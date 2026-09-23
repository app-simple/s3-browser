import type {
  JobKind,
  JobTarget,
  TransferItemView,
  TransferJobView
} from '@shared/types'

/** How many items transfer at the same time, across all jobs. */
export const MAX_RUNNING = 4
/** How many waiting items a job lists in the panel before summarising the rest. */
export const UPCOMING_SHOWN = 8
/** Failed items listed per job; the count covers any beyond. */
const FAILED_SHOWN = 50

export interface QueueItem<T = unknown> {
  index: number
  name: string
  size: number
  data: T
}

export type Take<T> =
  | { item: QueueItem<T> }
  | { waiting: true }
  | { exhausted: true }
  | { error: string }

/** Where a job's items come from. The scheduler only ever asks for the next one. */
export interface ItemSource<T = unknown> {
  take(): Take<T>
  peek(n: number): QueueItem<T>[]
  /** items known to be waiting, or null while that is not known yet */
  waiting(): number | null
  /** size of the whole job, settled items included */
  totals(): { items: number | null; bytes: number | null }
  /** drop every waiting item and return how many there were */
  drain(): number
}

export interface RunContext {
  signal: AbortSignal
  onProgress(loaded: number): void
}

/** Thrown by a runner when the job as a whole cannot go on, e.g. its connection is gone. */
export class JobFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobFailure'
  }
}

/** Items accounted for before a job was added: skipped while planning, finished before a restart. */
export interface Settled {
  done: number
  skipped: number
  cancelled: number
  /** bytes of the done and skipped items */
  bytes: number
  failed: { item: QueueItem; error: string }[]
}

export interface JobInit<T = unknown> {
  id: string
  kind: JobKind
  title: string
  target: JobTarget
  createdAt: number
  paused?: boolean
  source: ItemSource<T>
  run(item: QueueItem<T>, ctx: RunContext): Promise<'done' | 'skipped'>
  settled?: Settled
}

export type SettledStatus = 'done' | 'skipped' | 'error' | 'cancelled'

export interface QueueHooks {
  /** anything visible changed; the caller decides how often to redraw */
  onChange?(): void
  onItemSettled?(jobId: string, item: QueueItem, status: SettledStatus, error?: string): void
  onJobFinished?(jobId: string): void
  onJobPausedChanged?(jobId: string, paused: boolean): void
}

interface Running {
  item: QueueItem
  loaded: number
  controller: AbortController
}

interface JobState {
  init: JobInit
  paused: boolean
  cancelled: boolean
  error?: string
  finished: boolean
  running: Map<number, Running>
  failed: { item: QueueItem; error: string }[]
  done: number
  skipped: number
  cancelledCount: number
  bytesDone: number
}

/** A job whose items are all known up front: a selection of files, folders or objects. */
export function arraySource<T>(
  items: QueueItem<T>[],
  alreadySettled: { items: number; bytes: number } = { items: 0, bytes: 0 }
): ItemSource<T> {
  let next = 0
  const bytes = items.reduce((sum, i) => sum + i.size, 0)
  return {
    take: () => (next < items.length ? { item: items[next++] } : { exhausted: true }),
    peek: (n) => items.slice(next, next + n),
    waiting: () => items.length - next,
    totals: () => ({
      items: items.length + alreadySettled.items,
      bytes: bytes + alreadySettled.bytes
    }),
    drain: () => {
      const left = items.length - next
      next = items.length
      return left
    }
  }
}

const itemView = (item: QueueItem, status: TransferItemView['status'], loaded = 0, error?: string): TransferItemView => ({
  index: item.index,
  name: item.name,
  size: item.size,
  loaded,
  status,
  ...(error === undefined ? {} : { error })
})

/** A hook that throws (e.g. a full disk while saving progress) must not stall the queue. */
function safely(hook: () => void): void {
  try {
    hook()
  } catch (err) {
    console.error('transfer queue hook failed:', err)
  }
}

export function createTransferQueue(hooks: QueueHooks = {}) {
  const jobs: JobState[] = []
  let paused = false
  let running = 0
  /** the job that got the last slot; the next slot goes to the one after it */
  let lastServed: string | undefined

  const changed = (): void => safely(() => hooks.onChange?.())
  const find = (id: string): JobState | undefined => jobs.find((j) => j.init.id === id)
  const active = (job: JobState): boolean => !job.finished && !job.cancelled && !job.error

  function finishIfIdle(job: JobState): void {
    if (job.finished || job.running.size > 0) return
    if (active(job) && job.init.source.waiting() !== 0) return
    job.finished = true
    safely(() => hooks.onJobFinished?.(job.init.id))
  }

  function fail(job: JobState, message: string): void {
    if (job.error) return
    job.error = message
    job.cancelledCount += job.init.source.drain()
    for (const r of job.running.values()) r.controller.abort()
    finishIfIdle(job)
  }

  function pickNext(): { job: JobState; item: QueueItem } | undefined {
    if (jobs.length === 0) return undefined
    const start = lastServed === undefined ? 0 : jobs.findIndex((j) => j.init.id === lastServed) + 1
    for (let step = 0; step < jobs.length; step++) {
      const job = jobs[(start + step) % jobs.length]
      if (!active(job) || job.paused) continue
      const took = job.init.source.take()
      if ('item' in took) {
        lastServed = job.init.id
        return { job, item: took.item }
      }
      if ('error' in took) fail(job, took.error)
      else if ('exhausted' in took) finishIfIdle(job)
    }
    return undefined
  }

  function pump(): void {
    if (paused) return
    while (running < MAX_RUNNING) {
      const next = pickNext()
      if (!next) break
      start(next.job, next.item)
    }
  }

  function start(job: JobState, item: QueueItem): void {
    const controller = new AbortController()
    const entry: Running = { item, loaded: 0, controller }
    job.running.set(item.index, entry)
    running++
    changed()
    const ctx: RunContext = {
      signal: controller.signal,
      onProgress: (loaded) => {
        entry.loaded = loaded
        changed()
      }
    }
    let result: Promise<'done' | 'skipped'>
    try {
      result = job.init.run(item, ctx)
    } catch (err) {
      // a runner that throws before returning its promise must not break the dispatch loop
      result = Promise.reject(err)
    }
    result.then(
        (result) => settle(job, entry, result === 'skipped' ? 'skipped' : 'done'),
        (err: unknown) => {
          if (controller.signal.aborted) return settle(job, entry, 'cancelled')
          const message = err instanceof Error ? err.message : String(err)
          if (err instanceof JobFailure) fail(job, message)
          settle(job, entry, 'error', message)
        }
      )
  }

  function settle(job: JobState, entry: Running, status: SettledStatus, error?: string): void {
    job.running.delete(entry.item.index)
    running--
    if (status === 'done') {
      job.done++
      job.bytesDone += entry.item.size
    } else if (status === 'skipped') {
      job.skipped++
      job.bytesDone += entry.item.size
    } else if (status === 'cancelled') {
      job.cancelledCount++
    } else {
      job.failed.push({ item: entry.item, error: error ?? 'Unknown error' })
    }
    safely(() => hooks.onItemSettled?.(job.init.id, entry.item, status, error))
    finishIfIdle(job)
    changed()
    pump()
  }

  function viewOf(job: JobState): TransferJobView {
    const live = active(job)
    const totals = job.init.source.totals()
    const runningItems = [...job.running.values()]
    return {
      id: job.init.id,
      kind: job.init.kind,
      title: job.init.title,
      target: job.init.target,
      createdAt: job.init.createdAt,
      paused: job.paused,
      finished: job.finished,
      ...(job.error === undefined ? {} : { error: job.error }),
      items: {
        total: totals.items,
        waiting: live ? job.init.source.waiting() : 0,
        running: runningItems.length,
        done: job.done,
        skipped: job.skipped,
        failed: job.failed.length,
        cancelled: job.cancelledCount
      },
      bytes: {
        total: totals.bytes,
        done: job.bytesDone + runningItems.reduce((sum, r) => sum + r.loaded, 0)
      },
      running: runningItems.map((r) => itemView(r.item, 'running', r.loaded)),
      failed: job.failed.slice(0, FAILED_SHOWN).map((f) => itemView(f.item, 'error', 0, f.error)),
      upcoming: live ? job.init.source.peek(UPCOMING_SHOWN).map((i) => itemView(i, 'queued')) : []
    }
  }

  return {
    add<T>(init: JobInit<T>): void {
      const s = init.settled
      const job: JobState = {
        init: init as unknown as JobInit,
        paused: init.paused ?? false,
        cancelled: false,
        finished: false,
        running: new Map(),
        failed: s ? [...s.failed] : [],
        done: s?.done ?? 0,
        skipped: s?.skipped ?? 0,
        cancelledCount: s?.cancelled ?? 0,
        bytesDone: s?.bytes ?? 0
      }
      jobs.push(job)
      // a job whose items were all settled while planning is done at once
      finishIfIdle(job)
      changed()
      pump()
    },
    /** a source that answered "waiting" has items again */
    wake(): void {
      pump()
    },
    pauseAll(): void {
      paused = true
      changed()
    },
    resumeAll(): void {
      paused = false
      changed()
      pump()
    },
    pauseJob(id: string): void {
      const job = find(id)
      if (!job || job.paused || job.finished) return
      job.paused = true
      safely(() => hooks.onJobPausedChanged?.(id, true))
      changed()
    },
    resumeJob(id: string): void {
      const job = find(id)
      if (!job || !job.paused) return
      job.paused = false
      safely(() => hooks.onJobPausedChanged?.(id, false))
      changed()
      pump()
    },
    cancelJob(id: string): void {
      const job = find(id)
      if (!job || job.finished || job.cancelled) return
      job.cancelled = true
      job.cancelledCount += job.init.source.drain()
      for (const r of job.running.values()) r.controller.abort()
      finishIfIdle(job)
      changed()
    },
    cancelItem(jobId: string, index: number): void {
      find(jobId)?.running.get(index)?.controller.abort()
    },
    clearFinished(): void {
      for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].finished) jobs.splice(i, 1)
      changed()
    },
    has: (id: string): boolean => find(id) !== undefined,
    isPaused: (): boolean => paused,
    view: (): TransferJobView[] => jobs.map(viewOf)
  }
}
