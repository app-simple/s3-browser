import { describe, expect, it, vi } from 'vitest'
import type { JobRequest, QueueSnapshot } from '@shared/types'
import { createQueueService, type JobFactory, type PlannedJob } from './queueService'
import { arraySource, type QueueItem } from './transferQueue'

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

function service(factory: JobFactory, throttleMs = 0) {
  let id = 0
  const snapshots: QueueSnapshot[] = []
  const done = vi.fn()
  const svc = createQueueService({
    factory,
    emit: (s) => snapshots.push(s),
    onJobDone: done,
    newId: () => `id${++id}`,
    now: () => 1,
    throttleMs
  })
  return { svc, snapshots, done }
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
