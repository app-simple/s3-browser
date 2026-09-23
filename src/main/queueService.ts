import type {
  ConflictMode,
  JobDoneEvent,
  JobKind,
  JobRequest,
  JobTarget,
  PlanSummary,
  QueueSnapshot
} from '@shared/types'
import type { QueueStore, RestoredJob } from './queueStore'
import {
  arraySource,
  createTransferQueue,
  type ItemSource,
  type QueueItem,
  type RunContext,
  type Settled
} from './transferQueue'

export interface PlannedJob {
  kind: JobKind
  title: string
  target: JobTarget
  /** every item, known up front; null when the job lists its items as it goes (bucket sync) */
  items: QueueItem[] | null
  /** indices of items whose target already exists */
  conflicts: number[]
  /** a few conflicting target names for the dialog */
  sample: string[]
  /** what the factory needs to rebuild the job's runner, e.g. after a restart */
  spec: unknown
}

export interface JobRuntime {
  run(item: QueueItem, ctx: RunContext): Promise<'done' | 'skipped'>
  /** jobs that list their items as they go bring their own source */
  source?: ItemSource
  /** told about every settled item; returns a new resume mark when it moved */
  onSettled?(index: number): string | undefined
}

export interface RuntimeRequest {
  id: string
  kind: JobKind
  spec: unknown
  conflict: ConflictMode
  /** bucket sync: continue listing after this key */
  startAfter?: string
}

export interface JobFactory {
  plan(req: JobRequest): Promise<PlannedJob>
  runtime(job: RuntimeRequest, wake: () => void): JobRuntime
  /** which of these items' targets exist now; asked before resuming a "skip existing" job */
  recheck?(kind: JobKind, spec: unknown, items: QueueItem[]): Promise<number[]>
}

/** Ties the scheduler to the transfers it runs, the store that keeps them and the renderer. */
export function createQueueService(deps: {
  factory: JobFactory
  store: QueueStore
  emit(snapshot: QueueSnapshot): void
  onJobDone(event: JobDoneEvent): void
  newId(): string
  now(): number
  /** minimum gap between snapshots; the end of a job is never held back */
  throttleMs?: number
}) {
  const throttleMs = deps.throttleMs ?? 120
  const runtimes = new Map<string, JobRuntime>()
  const targets = new Map<string, { kind: JobKind; target: JobTarget }>()
  /** done and skipped totals of listing jobs, written along with each resume mark */
  const listed = new Map<string, { items: number; bytes: number }>()
  // only the newest plan can be started; an older one has lost its dialog
  let pending: { id: string; planned: PlannedJob } | undefined
  let restorable: RestoredJob[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const queue = createTransferQueue({
    onChange: scheduleEmit,
    onItemSettled: (jobId, item, status, error) => {
      const runtime = runtimes.get(jobId)
      if (!runtime) return
      if (!runtime.source) {
        deps.store.settle(jobId, item.index, error === undefined ? { status } : { status, error })
        return
      }
      const progress = listed.get(jobId)
      if (progress && (status === 'done' || status === 'skipped')) {
        progress.items++
        progress.bytes += item.size
      }
      const key = runtime.onSettled?.(item.index)
      if (key !== undefined && progress) deps.store.mark(jobId, { ...progress, key })
    },
    onJobPausedChanged: (jobId, paused) => deps.store.paused(jobId, paused),
    onJobFinished: (jobId) => {
      deps.store.remove(jobId)
      runtimes.delete(jobId)
      listed.delete(jobId)
      const info = targets.get(jobId)
      if (info) deps.onJobDone({ jobId, ...info })
      emitNow()
    }
  })

  function snapshot(): QueueSnapshot {
    const waiting = (r: RestoredJob): number =>
      r.job.items ? r.job.items.filter((i) => !r.outcomes.has(i.index)).length : 0
    return {
      paused: queue.isPaused(),
      jobs: queue.view(),
      restore:
        restorable.length === 0
          ? null
          : { jobs: restorable.length, items: restorable.reduce((sum, r) => sum + waiting(r), 0) }
    }
  }

  function emitNow(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
    deps.emit(snapshot())
  }

  function scheduleEmit(): void {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      deps.emit(snapshot())
    }, throttleMs)
  }

  const wake = (): void => {
    queue.wake()
    scheduleEmit()
  }

  function register(id: string, kind: JobKind, target: JobTarget, runtime: JobRuntime): void {
    runtimes.set(id, runtime)
    targets.set(id, { kind, target })
  }

  /** Put a job from the previous session back on the queue, past everything it had settled. */
  async function resume(r: RestoredJob): Promise<void> {
    const { job } = r
    const remaining: QueueItem[] = []
    const settled: Settled = { done: 0, skipped: 0, cancelled: 0, bytes: 0, failed: [] }
    let settledBytes = 0
    for (const stored of job.items ?? []) {
      const item: QueueItem = { index: stored.index, name: stored.name, size: stored.size, data: stored.data }
      const outcome = r.outcomes.get(stored.index)
      if (!outcome) {
        remaining.push(item)
        continue
      }
      settledBytes += item.size
      if (outcome.status === 'done') {
        settled.done++
        settled.bytes += item.size
      } else if (outcome.status === 'skipped') {
        settled.skipped++
        settled.bytes += item.size
      } else if (outcome.status === 'cancelled') {
        settled.cancelled++
      } else {
        settled.failed.push({ item, error: outcome.error ?? 'Unknown error' })
      }
    }

    // the answer from before the restart is stale: look at the targets again
    let runnable = remaining
    if (job.conflict === 'skip' && job.items && remaining.length > 0 && deps.factory.recheck) {
      const exists = new Set(await deps.factory.recheck(job.kind, job.spec, remaining))
      runnable = remaining.filter((i) => !exists.has(i.index))
      for (const item of remaining) {
        if (!exists.has(item.index)) continue
        settled.skipped++
        settled.bytes += item.size
        settledBytes += item.size
        deps.store.settle(job.id, item.index, { status: 'skipped' })
      }
    }

    const runtime = deps.factory.runtime(
      { id: job.id, kind: job.kind, spec: job.spec, conflict: job.conflict, startAfter: r.mark?.key },
      wake
    )
    let source: ItemSource
    if (job.items) {
      source = arraySource(runnable, { items: job.items.length - runnable.length, bytes: settledBytes })
    } else {
      if (!runtime.source) throw new Error(`Cannot resume "${job.title}"`)
      source = runtime.source
      settled.done = r.mark?.items ?? 0
      settled.bytes = r.mark?.bytes ?? 0
      listed.set(job.id, { items: settled.done, bytes: settled.bytes })
    }
    register(job.id, job.kind, job.target, runtime)
    queue.add({
      id: job.id,
      kind: job.kind,
      title: job.title,
      target: job.target,
      createdAt: job.createdAt,
      paused: r.paused,
      source,
      run: runtime.run,
      settled
    })
  }

  return {
    /** read what the previous session left unfinished; offered until restore() decides */
    init(): void {
      restorable = deps.store.loadAll()
    },

    async restore(decision: 'resume' | 'discard'): Promise<void> {
      const jobs = restorable
      restorable = []
      if (decision === 'discard') {
        for (const r of jobs) deps.store.remove(r.job.id)
        emitNow()
        return
      }
      const failed: { r: RestoredJob; message: string }[] = []
      for (const r of jobs) {
        try {
          await resume(r)
        } catch (err) {
          failed.push({ r, message: err instanceof Error ? err.message : String(err) })
        }
      }
      // a job that could not be resumed stays on offer instead of being lost
      restorable = failed.map((f) => f.r)
      emitNow()
      if (failed.length > 0) {
        const n = failed.length
        throw new Error(`${n} job${n === 1 ? '' : 's'} could not be resumed: ${failed[0].message}`)
      }
    },

    async plan(req: JobRequest): Promise<PlanSummary> {
      const planned = await deps.factory.plan(req)
      pending = { id: deps.newId(), planned }
      return {
        planId: pending.id,
        total: planned.items ? planned.items.length : null,
        conflicts: planned.conflicts.length,
        sample: planned.sample
      }
    },

    enqueue(planId: string, mode: ConflictMode): string {
      if (!pending || pending.id !== planId) {
        throw new Error('This transfer was already started or has expired — please start it again')
      }
      const { planned } = pending
      pending = undefined
      const id = deps.newId()
      const createdAt = deps.now()
      const runtime = deps.factory.runtime({ id, kind: planned.kind, spec: planned.spec, conflict: mode }, wake)
      register(id, planned.kind, planned.target, runtime)

      const skip = new Set(mode === 'skip' ? planned.conflicts : [])
      const all = planned.items ?? []
      const skipped = all.filter((i) => skip.has(i.index))
      const skippedBytes = skipped.reduce((sum, i) => sum + i.size, 0)

      deps.store.create({
        version: 1,
        id,
        kind: planned.kind,
        title: planned.title,
        target: planned.target,
        createdAt,
        conflict: mode,
        spec: planned.spec,
        items: planned.items
          ? planned.items.map(({ index, name, size, data }) => ({ index, name, size, data }))
          : null
      })
      for (const item of skipped) deps.store.settle(id, item.index, { status: 'skipped' })
      if (runtime.source) listed.set(id, { items: 0, bytes: 0 })

      queue.add({
        id,
        kind: planned.kind,
        title: planned.title,
        target: planned.target,
        createdAt,
        source:
          runtime.source ??
          arraySource(
            all.filter((i) => !skip.has(i.index)),
            { items: skipped.length, bytes: skippedBytes }
          ),
        run: runtime.run,
        settled: { done: 0, skipped: skipped.length, cancelled: 0, bytes: skippedBytes, failed: [] }
      })
      return id
    },

    pauseAll: (): void => queue.pauseAll(),
    resumeAll: (): void => queue.resumeAll(),
    pauseJob: (id: string): void => queue.pauseJob(id),
    resumeJob: (id: string): void => queue.resumeJob(id),
    cancelJob: (id: string): void => queue.cancelJob(id),
    cancelItem: (id: string, index: number): void => queue.cancelItem(id, index),

    clearFinished(): void {
      queue.clearFinished()
      for (const id of [...targets.keys()]) if (!queue.has(id)) targets.delete(id)
    },

    snapshot,

    /** the local folder a download job writes to, for "Show in folder" */
    revealDir(id: string): string | undefined {
      const target = targets.get(id)?.target
      return target?.type === 'local' ? target.dir : undefined
    }
  }
}
