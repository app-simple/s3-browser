import type {
  ConflictMode,
  JobDoneEvent,
  JobKind,
  JobRequest,
  JobTarget,
  PlanSummary,
  QueueSnapshot
} from '@shared/types'
import {
  arraySource,
  createTransferQueue,
  type ItemSource,
  type QueueItem,
  type RunContext
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
}

/** Ties the scheduler to the transfers it runs and to the renderer that watches it. */
export function createQueueService(deps: {
  factory: JobFactory
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
  // only the newest plan can be started; an older one has lost its dialog
  let pending: { id: string; planned: PlannedJob } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const queue = createTransferQueue({
    onChange: scheduleEmit,
    onItemSettled: (jobId, item) => {
      runtimes.get(jobId)?.onSettled?.(item.index)
    },
    onJobFinished: (jobId) => {
      runtimes.delete(jobId)
      const info = targets.get(jobId)
      if (info) deps.onJobDone({ jobId, ...info })
      emitNow()
    }
  })

  function snapshot(): QueueSnapshot {
    return { paused: queue.isPaused(), jobs: queue.view(), restore: null }
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

  return {
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
      const runtime = deps.factory.runtime(
        { id, kind: planned.kind, spec: planned.spec, conflict: mode },
        wake
      )
      runtimes.set(id, runtime)
      targets.set(id, { kind: planned.kind, target: planned.target })

      const skip = new Set(mode === 'skip' ? planned.conflicts : [])
      const all = planned.items ?? []
      const skipped = all.filter((i) => skip.has(i.index))
      const skippedBytes = skipped.reduce((sum, i) => sum + i.size, 0)
      queue.add({
        id,
        kind: planned.kind,
        title: planned.title,
        target: planned.target,
        createdAt: deps.now(),
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
