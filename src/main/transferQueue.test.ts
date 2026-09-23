import { describe, expect, it, vi } from 'vitest'
import {
  arraySource,
  createTransferQueue,
  JobFailure,
  type ItemSource,
  type JobInit,
  type QueueItem,
  type RunContext
} from './transferQueue'

const items = (n: number, size = 10): QueueItem<string>[] =>
  Array.from({ length: n }, (_, index) => ({ index, name: `f${index}`, size, data: `f${index}` }))

/** A runner whose items finish only when the test says so. */
function manual() {
  const live = new Map<
    number,
    { finish(result?: 'done' | 'skipped'): void; fail(err: unknown): void; ctx: RunContext }
  >()
  const started: number[] = []
  const run = (item: QueueItem, ctx: RunContext) =>
    new Promise<'done' | 'skipped'>((resolve, reject) => {
      started.push(item.index)
      live.set(item.index, {
        finish: (result = 'done') => {
          live.delete(item.index)
          resolve(result)
        },
        fail: (err) => {
          live.delete(item.index)
          reject(err)
        },
        ctx
      })
      ctx.signal.addEventListener('abort', () => {
        live.delete(item.index)
        reject(new Error('aborted'))
      })
    })
  return { run, live, started }
}

/** let the queue's promise callbacks run */
const settle = () => new Promise((r) => setTimeout(r, 0))

function job(
  id: string,
  n: number,
  runner: ReturnType<typeof manual>,
  extra: Partial<JobInit> = {}
): JobInit {
  return {
    id,
    kind: 'upload',
    title: id,
    target: { type: 'local', dir: '/tmp' },
    createdAt: 0,
    source: arraySource(items(n)),
    run: runner.run,
    ...extra
  }
}

describe('transfer queue', () => {
  it('never runs more than four items at once', async () => {
    const a = manual()
    const queue = createTransferQueue()

    queue.add(job('a', 10, a))
    expect(a.live.size).toBe(4)
    a.live.get(0)!.finish()
    await settle()

    expect(a.live.size).toBe(4)
    expect(a.started).toEqual([0, 1, 2, 3, 4])
  })

  it('gives the next free slot to a job added later', async () => {
    const a = manual()
    const b = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 10, a))
    queue.add(job('b', 1, b))
    expect(b.started).toEqual([])

    a.live.get(0)!.finish()
    await settle()

    expect(b.started).toEqual([0])
  })

  it('starts nothing new while paused but lets running items finish', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 10, a))

    queue.pauseAll()
    a.live.get(0)!.finish()
    a.live.get(1)!.finish()
    await settle()
    expect(a.live.size).toBe(2)

    queue.resumeAll()
    expect(a.live.size).toBe(4)
  })

  it('skips a paused job and gives its slots to the others', async () => {
    const a = manual()
    const b = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 10, a))
    queue.add(job('b', 10, b))

    queue.pauseJob('a')
    for (const index of [...a.live.keys()]) a.live.get(index)!.finish()
    await settle()

    expect(a.live.size).toBe(0)
    expect(b.live.size).toBe(4)
  })

  it('stops the running items and drops the waiting ones of a cancelled job', async () => {
    const a = manual()
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })
    queue.add(job('a', 10, a))

    queue.cancelJob('a')
    await settle()

    const [view] = queue.view()
    expect(view.items).toMatchObject({ cancelled: 10, done: 0, waiting: 0 })
    expect(view.finished).toBe(true)
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('cancels a single running item and moves on', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 5, a))

    queue.cancelItem('a', 1)
    await settle()

    expect(queue.view()[0].items).toMatchObject({ cancelled: 1, running: 4 })
    expect(a.started).toEqual([0, 1, 2, 3, 4])
  })

  it('keeps going after one item fails', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 3, a))

    a.live.get(0)!.fail(new Error('Access Denied'))
    a.live.get(1)!.finish()
    a.live.get(2)!.finish()
    await settle()

    const [view] = queue.view()
    expect(view.items).toMatchObject({ done: 2, failed: 1 })
    expect(view.failed).toMatchObject([{ index: 0, status: 'error', error: 'Access Denied' }])
    expect(view.finished).toBe(true)
  })

  it('ends the whole job when a runner reports a job failure', async () => {
    const a = manual()
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })
    queue.add(job('a', 10, a))

    a.live.get(0)!.fail(new JobFailure('The connection used by this job no longer exists'))
    await settle()

    const [view] = queue.view()
    expect(view.error).toBe('The connection used by this job no longer exists')
    expect(view.finished).toBe(true)
    expect(a.started).toEqual([0, 1, 2, 3])
    expect(finished).toHaveBeenCalledTimes(1)
  })

  it('counts an item the runner skipped as skipped', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 1, a))

    a.live.get(0)!.finish('skipped')
    await settle()

    expect(queue.view()[0].items).toMatchObject({ done: 0, skipped: 1 })
  })

  it('reports a job finished when its last item ends while everything is paused', async () => {
    const a = manual()
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })
    queue.add(job('a', 1, a))

    queue.pauseAll()
    a.live.get(0)!.finish()
    await settle()

    expect(finished).toHaveBeenCalledWith('a')
  })

  it('finishes a job at once when all of its items were settled beforehand', () => {
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })

    queue.add(
      job('a', 0, manual(), {
        settled: { done: 0, skipped: 3, cancelled: 0, bytes: 30, failed: [] }
      })
    )

    expect(finished).toHaveBeenCalledWith('a')
  })

  it('asks a source that was still listing again once it wakes the queue', () => {
    const a = manual()
    let ready: QueueItem[] = []
    const source: ItemSource = {
      take: () => {
        const item = ready.shift()
        return item ? { item } : { waiting: true }
      },
      peek: () => [],
      waiting: () => null,
      totals: () => ({ items: null, bytes: null }),
      drain: () => 0
    }
    const queue = createTransferQueue()
    queue.add(job('a', 0, a, { source }))
    expect(a.started).toEqual([])

    ready = items(2)
    queue.wake()

    expect(a.started).toEqual([0, 1])
  })

  it('lists only a handful of the waiting items of a very large job', () => {
    const queue = createTransferQueue()

    queue.add(job('a', 50_000, manual()))

    const [view] = queue.view()
    expect(view.running).toHaveLength(4)
    expect(view.upcoming.map((i) => i.index)).toEqual([4, 5, 6, 7, 8, 9, 10, 11])
    expect(view.items).toMatchObject({ total: 50_000, waiting: 49_996 })
  })

  it('includes the progress of running items in the byte count', async () => {
    const a = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 2, a))

    a.live.get(0)!.ctx.onProgress(4)
    a.live.get(1)!.finish()
    await settle()

    expect(queue.view()[0].bytes).toEqual({ total: 20, done: 14 })
  })

  it('treats a runner that throws right away like a failed item', async () => {
    const queue = createTransferQueue()
    let calls = 0
    queue.add(
      job('a', 2, manual(), {
        run: () => {
          calls++
          throw new Error('boom')
        }
      })
    )
    await settle()

    expect(calls).toBe(2)
    expect(queue.view()[0].items).toMatchObject({ failed: 2, running: 0 })
  })

  it('clears finished jobs and keeps the others', async () => {
    const a = manual()
    const b = manual()
    const queue = createTransferQueue()
    queue.add(job('a', 1, a))
    queue.add(job('b', 1, b))

    a.live.get(0)!.finish()
    await settle()
    queue.clearFinished()

    expect(queue.view().map((j) => j.id)).toEqual(['b'])
    expect(queue.has('a')).toBe(false)
  })

  it('keeps dispatching when a hook throws', async () => {
    const a = manual()
    const queue = createTransferQueue({
      onItemSettled: () => {
        throw new Error('ENOSPC: no space left on device')
      }
    })
    queue.add(job('a', 6, a))

    a.live.get(0)!.finish()
    await settle()

    expect(a.started).toEqual([0, 1, 2, 3, 4])
  })
})
