import { describe, expect, it, vi } from 'vitest'
import { fakeS3, httpError } from './testing/fakeS3'
import { listingSource } from './syncSource'
import { createTransferQueue } from './transferQueue'

const settle = () => new Promise((r) => setTimeout(r, 0))

/** Take items until the source is exhausted, letting pages arrive in between. */
async function drainKeys(source: ReturnType<typeof listingSource>): Promise<string[]> {
  const keys: string[] = []
  for (let guard = 0; guard < 50; guard++) {
    const took = source.take()
    if ('item' in took) keys.push(took.item.data.key)
    else if ('exhausted' in took) return keys
    else await settle()
  }
  throw new Error('source never finished')
}

describe('listing source', () => {
  it('hands out every object under the prefix, a page at a time', async () => {
    const s3 = fakeS3(
      [
        { key: 'src/a', size: 1 },
        { key: 'src/b', size: 2 },
        { key: 'src/c', size: 3 },
        { key: 'other/x', size: 9 }
      ],
      { pageSize: 2 }
    )
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: 'src/', wake: () => {} })

    expect(await drainKeys(source)).toEqual(['src/a', 'src/b', 'src/c'])
    expect(s3.requests.filter((r) => r.command === 'list')).toHaveLength(2)
  })

  it('leaves out folder placeholders', async () => {
    const s3 = fakeS3([
      { key: 'src/', size: 0 },
      { key: 'src/a', size: 1 }
    ])
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: 'src/', wake: () => {} })

    expect(await drainKeys(source)).toEqual(['src/a'])
  })

  it('continues after the mark of a previous run', async () => {
    const s3 = fakeS3([
      { key: 'src/a', size: 1 },
      { key: 'src/b', size: 1 },
      { key: 'src/c', size: 1 }
    ])
    const source = listingSource({
      client: () => s3,
      bucket: 'b',
      prefix: 'src/',
      startAfter: 'src/b',
      wake: () => {}
    })

    expect(await drainKeys(source)).toEqual(['src/c'])
  })

  it('moves the resume mark only past items that have all settled', async () => {
    const s3 = fakeS3([
      { key: 'k/a', size: 1 },
      { key: 'k/b', size: 1 },
      { key: 'k/c', size: 1 }
    ])
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: 'k/', wake: () => {} })
    source.take()
    await settle()
    const taken = [source.take(), source.take(), source.take()].map((t) =>
      'item' in t ? t.item.index : -1
    )
    expect(taken).toEqual([0, 1, 2])

    expect(source.settle(1)).toBeUndefined()
    expect(source.settle(0)).toBe('k/b')
    expect(source.settle(2)).toBe('k/c')
  })

  it('reports a refused listing so the job can end with its reason', async () => {
    const s3 = fakeS3([], { failWith: httpError(403, 'AccessDenied', 'Access Denied') })
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: 'src/', wake: () => {} })

    expect(source.take()).toEqual({ waiting: true })
    await settle()

    expect(source.take()).toEqual({ error: 'Access Denied' })
  })

  it('leaves out objects under an excluded prefix', async () => {
    const s3 = fakeS3([
      { key: 'a/x', size: 1 },
      { key: 'backups/a/x', size: 1 },
      { key: 'z', size: 1 }
    ])
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: '', exclude: 'backups/', wake: () => {} })

    expect(await drainKeys(source)).toEqual(['a/x', 'z'])
  })

  it('holds the resume mark before an object that failed, so a restart tries it again', async () => {
    const s3 = fakeS3([
      { key: 'k/a', size: 1 },
      { key: 'k/b', size: 1 },
      { key: 'k/c', size: 1 }
    ])
    const source = listingSource({ client: () => s3, bucket: 'b', prefix: 'k/', wake: () => {} })
    source.take()
    await settle()
    source.take()
    source.take()
    source.take()

    expect(source.settle(0, true)).toBe('k/a')
    expect(source.settle(1, false)).toBeUndefined()
    expect(source.settle(2, true)).toBeUndefined()
  })

  it('lets the sync of an empty folder finish', async () => {
    const s3 = fakeS3([{ key: 'other/x', size: 1 }])
    const finished = vi.fn()
    const queue = createTransferQueue({ onJobFinished: finished })
    const source = listingSource({
      client: () => s3,
      bucket: 'b',
      prefix: 'empty/',
      wake: () => queue.wake()
    })

    queue.add({
      id: 's',
      kind: 'sync',
      title: 's',
      target: { type: 'local', dir: '/' },
      createdAt: 0,
      source,
      run: async () => 'done' as const
    })
    await settle()

    expect(finished).toHaveBeenCalledWith('s')
  })
})
