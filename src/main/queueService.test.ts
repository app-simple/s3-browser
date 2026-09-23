import { describe, expect, it, vi } from 'vitest'
import type { JobRequest, QueueSnapshot } from '@shared/types'
import { createQueueService, type JobFactory, type PlannedJob } from './queueService'
import { arraySource, type QueueItem } from './transferQueue'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobKind } from '@shared/types'
import { createQueueStore } from './queueStore'

const settle = () => new Promise((r) => setTimeout(r, 5))
const request: JobRequest = { kind: 'upload', accountId: 'a', bucket: 'b', prefix: '', paths: [] }
const items = (n: number): QueueItem[] =>
  Array.from({ length: n }, (_, index) => ({ index, name: `f${index}`, size: 10, data: null }))

/** A factory that plans a fixed job of three items and records which ones ran. */
function fakeFactory(planned: Partial<PlannedJob> = {}) {
  const ran: number[] = []
  const factory: JobFactory = {
    plan: async () => ({
      kind: 'upload',
      title: 'Upload',
      target: { type: 's3', accountId: 'a', bucket: 'b', prefix: '' },
      items: items(3),
      conflicts: [],
      sample: [],
      spec: {},
      ...planned
    }),
    runtime: () => ({
      run: async (item) => {
        ran.push(item.index)
        return 'done'
      }
    })
  }
  return { factory, ran }
}

const queueDir = (): string => join(mkdtempSync(join(tmpdir(), 's3b-svc-')), 'queue')

/** A queue service on a store folder; a second call on the same folder is a restart. */
function service(factory: JobFactory, throttleMs = 0, dir = queueDir()) {
  const snapshots: QueueSnapshot[] = []
  const done = vi.fn()
  const svc = createQueueService({
    factory,
    store: createQueueStore(dir),
    emit: (s) => snapshots.push(s),
    onJobDone: done,
    newId: () => randomUUID(),
    now: () => 1,
    throttleMs
  })
  svc.init()
  return { svc, snapshots, done }
}

/** A factory whose items finish only when the test says so. */
function manualFactory(opts: { kind?: JobKind; lazy?: boolean; recheck?: number[]; recheckFails?: boolean } = {}) {
  const live = new Map<number, () => void>()
  const started: number[] = []
  const startAfter: (string | undefined)[] = []
  const factory: JobFactory = {
    plan: async () => ({
      kind: opts.lazy ? 'sync' : (opts.kind ?? 'upload'),
      title: 'Job',
      target: { type: 's3', accountId: 'a', bucket: 'b', prefix: '' },
      items: opts.lazy ? null : items(3),
      conflicts: [],
      sample: [],
      spec: { note: 'kept' }
    }),
    runtime: (job) => {
      startAfter.push(job.startAfter)
      const run = (item: QueueItem) =>
        new Promise<'done'>((resolve) => {
          started.push(item.index)
          live.set(item.index, () => resolve('done'))
        })
      if (!opts.lazy) return { run }
      return { run, source: arraySource(items(3)), onSettled: (index) => `key${index}` }
    },
    ...(opts.recheck || opts.recheckFails
      ? {
          recheck: async () => {
            if (opts.recheckFails) throw new Error('network down')
            return opts.recheck ?? []
          }
        }
      : {})
  }
  return { factory, live, started, startAfter }
}

describe('queue service', () => {
  it('skips the conflicting items when asked to', async () => {
    const { factory, ran } = fakeFactory({ conflicts: [1] })
    const { svc } = service(factory)
    const plan = await svc.plan(request)
    expect(plan).toMatchObject({ total: 3, conflicts: 1 })

    svc.enqueue(plan.planId, 'skip')
    await settle()

    expect(ran).toEqual([0, 2])
    expect(svc.snapshot().jobs[0].items).toMatchObject({ total: 3, done: 2, skipped: 1 })
  })

  it('transfers every item when told to overwrite', async () => {
    const { factory, ran } = fakeFactory({ conflicts: [1] })
    const { svc } = service(factory)

    svc.enqueue((await svc.plan(request)).planId, 'overwrite')
    await settle()

    expect(ran).toEqual([0, 1, 2])
  })

  it('starts a plan only once', async () => {
    const { svc } = service(fakeFactory().factory)
    const plan = await svc.plan(request)
    svc.enqueue(plan.planId, 'overwrite')

    expect(() => svc.enqueue(plan.planId, 'overwrite')).toThrow()
  })

  it('forgets a plan once a newer one was made', async () => {
    const { svc } = service(fakeFactory().factory)
    const first = await svc.plan(request)
    const second = await svc.plan(request)

    expect(() => svc.enqueue(first.planId, 'overwrite')).toThrow()
    expect(() => svc.enqueue(second.planId, 'overwrite')).not.toThrow()
  })

  it('announces a finished job together with its target', async () => {
    const { svc, done } = service(fakeFactory().factory)

    const jobId = svc.enqueue((await svc.plan(request)).planId, 'overwrite')
    await settle()

    expect(done).toHaveBeenCalledWith({
      jobId,
      kind: 'upload',
      target: { type: 's3', accountId: 'a', bucket: 'b', prefix: '' }
    })
  })

  it('sends the final state of a job without waiting for the throttle', async () => {
    const { svc, snapshots } = service(fakeFactory().factory, 60_000)

    svc.enqueue((await svc.plan(request)).planId, 'overwrite')
    await settle()

    expect(snapshots.at(-1)?.jobs[0].finished).toBe(true)
  })

  it('lets a job that lists as it goes bring its own source', async () => {
    const seen: number[] = []
    const factory: JobFactory = {
      plan: async () => ({
        kind: 'sync',
        title: 'Sync',
        target: { type: 's3', accountId: 'a', bucket: 'c', prefix: '' },
        items: null,
        conflicts: [],
        sample: [],
        spec: {}
      }),
      runtime: () => ({
        source: arraySource(items(2)),
        onSettled: (index) => {
          seen.push(index)
          return undefined
        },
        run: async () => 'done'
      })
    }
    const { svc } = service(factory)
    const plan = await svc.plan({
      kind: 'sync',
      accountId: 'a',
      bucket: 'b',
      prefix: '',
      target: { accountId: 'a', bucket: 'c', prefix: '' }
    })
    expect(plan.total).toBeNull()

    svc.enqueue(plan.planId, 'skip')
    await settle()

    expect(seen.sort()).toEqual([0, 1])
  })

  it('knows the local folder of a download job and nothing for others', async () => {
    const { factory } = fakeFactory({ kind: 'download', target: { type: 'local', dir: '/dl' } })
    const { svc } = service(factory)

    const jobId = svc.enqueue((await svc.plan(request)).planId, 'overwrite')

    expect(svc.revealDir(jobId)).toBe('/dl')
    expect(svc.revealDir('unknown')).toBeUndefined()
  })
})

describe('queue service across restarts', () => {
  it('offers an unfinished job after a restart and resumes only what was left', async () => {
    const dir = queueDir()
    const first = manualFactory()
    const one = service(first.factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')
    first.live.get(0)!()
    await settle()

    const second = manualFactory()
    const two = service(second.factory, 0, dir)
    expect(two.svc.snapshot().restore).toEqual({ jobs: 1, items: 2 })
    await two.svc.restore('resume')

    // item 1 was still running when the app quit: it starts over
    expect(second.started).toEqual([1, 2])
    expect(two.svc.snapshot().jobs[0].items).toMatchObject({ total: 3, done: 1, running: 2 })
    expect(two.svc.snapshot().restore).toBeNull()
  })

  it('keeps a job the user had paused paused when resuming', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    const jobId = one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')
    one.svc.pauseJob(jobId)

    const second = manualFactory()
    const two = service(second.factory, 0, dir)
    await two.svc.restore('resume')

    expect(two.svc.snapshot().jobs[0].paused).toBe(true)
    expect(second.started).toEqual([])
  })

  it('forgets the saved jobs when told to discard them', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')

    await service(manualFactory().factory, 0, dir).svc.restore('discard')

    expect(service(manualFactory().factory, 0, dir).svc.snapshot().restore).toBeNull()
  })

  it('offers the jobs again when the previous start never decided', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')

    service(manualFactory().factory, 0, dir) // started and quit again without choosing

    expect(service(manualFactory().factory, 0, dir).svc.snapshot().restore).toEqual({ jobs: 1, items: 3 })
  })

  it('leaves nothing to restore once a job has finished', async () => {
    const dir = queueDir()
    const first = manualFactory()
    const one = service(first.factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'overwrite')
    for (const finish of [...first.live.values()]) finish()
    await settle()

    expect(service(manualFactory().factory, 0, dir).svc.snapshot().restore).toBeNull()
  })

  it('continues a bucket sync after its last mark', async () => {
    const dir = queueDir()
    const first = manualFactory({ lazy: true })
    const one = service(first.factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'skip')
    first.live.get(0)!()
    first.live.get(1)!()
    await settle()

    const second = manualFactory({ lazy: true })
    const two = service(second.factory, 0, dir)
    await two.svc.restore('resume')

    expect(second.startAfter).toEqual(['key1'])
    expect(two.svc.snapshot().jobs[0].items).toMatchObject({ done: 2 })
  })

  it('checks a skip job again before resuming it and skips what appeared meanwhile', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'skip')

    const second = manualFactory({ recheck: [2] })
    const two = service(second.factory, 0, dir)
    await two.svc.restore('resume')

    expect(second.started).toEqual([0, 1])
    expect(two.svc.snapshot().jobs[0].items).toMatchObject({ total: 3, skipped: 1 })
  })

  it('keeps a job on offer when checking it again fails', async () => {
    const dir = queueDir()
    const one = service(manualFactory().factory, 0, dir)
    one.svc.enqueue((await one.svc.plan(request)).planId, 'skip')

    const two = service(manualFactory({ recheckFails: true }).factory, 0, dir)

    await expect(two.svc.restore('resume')).rejects.toThrow('could not be resumed: network down')
    expect(two.svc.snapshot().restore).toEqual({ jobs: 1, items: 3 })
  })

  it('tells a listing job which of its objects failed', async () => {
    const seen: [number, boolean][] = []
    const factory: JobFactory = {
      plan: async () => ({
        kind: 'sync',
        title: 'Sync',
        target: { type: 's3', accountId: 'a', bucket: 'c', prefix: '' },
        items: null,
        conflicts: [],
        sample: [],
        spec: {}
      }),
      runtime: () => ({
        source: arraySource(items(2)),
        onSettled: (index, ok) => {
          seen.push([index, ok])
          return undefined
        },
        run: async (item) => {
          if (item.index === 1) throw new Error('Access Denied')
          return 'done'
        }
      })
    }
    const { svc } = service(factory)

    svc.enqueue((await svc.plan(request)).planId, 'overwrite')
    await settle()

    expect(seen.sort()).toEqual([
      [0, true],
      [1, false]
    ])
  })
})
