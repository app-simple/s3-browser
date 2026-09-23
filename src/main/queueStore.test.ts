import { appendFileSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createQueueStore, type StoredJob } from './queueStore'

const queueDir = (): string => join(mkdtempSync(join(tmpdir(), 's3b-queue-')), 'queue')

const job = (id = 'job-1', extra: Partial<StoredJob> = {}): StoredJob => ({
  version: 1,
  id,
  kind: 'upload',
  title: 'Upload 3 files → b/',
  target: { type: 's3', accountId: 'a', bucket: 'b', prefix: '' },
  createdAt: 1,
  conflict: 'skip',
  spec: { accountId: 'a', bucket: 'b', prefix: '' },
  items: [0, 1, 2].map((index) => ({
    index,
    name: `f${index}`,
    size: 10,
    data: { file: `/f${index}`, key: `f${index}` }
  })),
  ...extra
})

describe('queue store', () => {
  it('brings a job back with what had already happened to its items', () => {
    const dir = queueDir()
    const store = createQueueStore(dir)
    store.create(job())
    store.settle('job-1', 0, { status: 'done' })
    store.settle('job-1', 2, { status: 'error', error: 'Access Denied' })

    const [restored] = createQueueStore(dir).loadAll()

    expect(restored.job).toEqual(job())
    expect([...restored.outcomes]).toEqual([
      [0, { status: 'done' }],
      [2, { status: 'error', error: 'Access Denied' }]
    ])
  })

  it('does not trust a last line whose newline a crash never wrote', () => {
    const dir = queueDir()
    const store = createQueueStore(dir)
    store.create(job())
    store.settle('job-1', 0, { status: 'done' })
    // looks complete, but the write was cut before its newline: item 1 must run again
    appendFileSync(join(dir, 'job-1.log'), '1 done')

    expect([...store.loadAll()[0].outcomes.keys()]).toEqual([0])
  })

  it('remembers whether the user had paused a job', () => {
    const store = createQueueStore(queueDir())
    store.create(job('a'))
    store.create(job('b', { createdAt: 2 }))
    store.paused('a', true)
    store.paused('b', true)
    store.paused('b', false)

    expect(store.loadAll().map((r) => [r.job.id, r.paused])).toEqual([
      ['a', true],
      ['b', false]
    ])
  })

  it('keeps the latest resume mark, whatever its key contains', () => {
    const store = createQueueStore(queueDir())
    store.create(job('s', { kind: 'sync', items: null }))
    store.mark('s', { items: 1, bytes: 10, key: 'a' })
    store.mark('s', { items: 7, bytes: 70, key: 'dir with spaces/line\nbreak.txt' })

    expect(store.loadAll()[0].mark).toEqual({ items: 7, bytes: 70, key: 'dir with spaces/line\nbreak.txt' })
  })

  it('keeps an error message on one line', () => {
    const store = createQueueStore(queueDir())
    store.create(job())
    store.settle('job-1', 1, { status: 'error', error: 'first\nsecond' })

    expect(store.loadAll()[0].outcomes.get(1)).toEqual({ status: 'error', error: 'first second' })
  })

  it('forgets a removed job', () => {
    const store = createQueueStore(queueDir())
    store.create(job())
    store.settle('job-1', 0, { status: 'done' })

    store.remove('job-1')

    expect(store.loadAll()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('writes files only the user can read', () => {
    const dir = queueDir()
    const store = createQueueStore(dir)
    store.create(job())
    store.settle('job-1', 0, { status: 'done' })

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'job-1.job.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'job-1.log')).mode & 0o777).toBe(0o600)
  })

  it('drops a job file it cannot read and keeps the others', () => {
    const dir = queueDir()
    const store = createQueueStore(dir)
    store.create(job('good'))
    writeFileSync(join(dir, 'bad.job.json'), '{ not json')

    expect(store.loadAll().map((r) => r.job.id)).toEqual(['good'])
    expect(existsSync(join(dir, 'bad.job.json'))).toBe(false)
  })

  it('refuses a job id that is not a safe file name', () => {
    expect(() => createQueueStore(queueDir()).create(job('../evil'))).toThrow()
  })

  it('has nothing to restore before anything was saved', () => {
    expect(createQueueStore(queueDir()).loadAll()).toEqual([])
  })

  it('writes after a torn line without gluing onto it', () => {
    const dir = queueDir()
    const store = createQueueStore(dir)
    store.create(job())
    store.settle('job-1', 0, { status: 'done' })
    appendFileSync(join(dir, 'job-1.log'), '1') // the crash cut this write short

    const next = createQueueStore(dir)
    next.loadAll()
    next.settle('job-1', 2, { status: 'done' })

    expect([...createQueueStore(dir).loadAll()[0].outcomes.keys()]).toEqual([0, 2])
  })
})
