import { describe, expect, it, vi } from 'vitest'
import { fakeS3 } from './testing/fakeS3'
import type { PrefixStats } from '@shared/types'
import { countPrefix, createPrefixScanner } from './prefixScan'

describe('countPrefix', () => {
  it('counts every object and sums their sizes across all result pages', async () => {
    const s3 = fakeS3(
      [
        { key: 'a.txt', size: 100 },
        { key: 'b.txt', size: 200 },
        { key: 'c.txt', size: 300 },
        { key: 'd.txt', size: 400 },
        { key: 'e.txt', size: 500 }
      ],
      { pageSize: 2 }
    )

    const result = await countPrefix(s3, 'bucket', '')

    expect(result).toEqual({ objects: 5, bytes: 1500 })
  })

  it('counts only the objects under the given prefix', async () => {
    const s3 = fakeS3([
      { key: 'a/1.txt', size: 10 },
      { key: 'a/2.txt', size: 20 },
      { key: 'ab/4.txt', size: 80 },
      { key: 'b/3.txt', size: 40 }
    ])

    const result = await countPrefix(s3, 'bucket', 'a/')

    expect(result).toEqual({ objects: 2, bytes: 30 })
  })

  it('includes objects in nested subfolders', async () => {
    const s3 = fakeS3([
      { key: 'photos/a.jpg', size: 1 },
      { key: 'photos/2024/b.jpg', size: 2 },
      { key: 'photos/2024/x/c.jpg', size: 4 }
    ])

    const result = await countPrefix(s3, 'bucket', 'photos/')

    expect(result).toEqual({ objects: 3, bytes: 7 })
  })

  it('does not count folder placeholder objects as documents', async () => {
    const s3 = fakeS3([
      { key: 'docs/', size: 0 },
      { key: 'docs/a.txt', size: 10 },
      { key: 'docs/sub/', size: 0 },
      { key: 'docs/sub/b.txt', size: 20 }
    ])

    const result = await countPrefix(s3, 'bucket', 'docs/')

    expect(result).toEqual({ objects: 2, bytes: 30 })
  })

  it('reports zero for a folder with nothing in it', async () => {
    const s3 = fakeS3([{ key: 'other/a.txt', size: 5 }])

    const result = await countPrefix(s3, 'bucket', 'empty/')

    expect(result).toEqual({ objects: 0, bytes: 0 })
  })

  it('reports running totals after every page', async () => {
    const s3 = fakeS3(
      [
        { key: 'a.txt', size: 100 },
        { key: 'b.txt', size: 200 },
        { key: 'c.txt', size: 300 },
        { key: 'd.txt', size: 400 },
        { key: 'e.txt', size: 500 }
      ],
      { pageSize: 2 }
    )
    const seen: [number, number][] = []

    await countPrefix(s3, 'bucket', '', {
      onProgress: (objects, bytes) => seen.push([objects, bytes])
    })

    expect(seen).toEqual([
      [2, 300],
      [4, 1000],
      [5, 1500]
    ])
  })

  it('requests no further pages once aborted', async () => {
    const s3 = fakeS3(
      [
        { key: 'a.txt', size: 1 },
        { key: 'b.txt', size: 1 },
        { key: 'c.txt', size: 1 },
        { key: 'd.txt', size: 1 },
        { key: 'e.txt', size: 1 },
        { key: 'f.txt', size: 1 }
      ],
      { pageSize: 2 }
    )
    const controller = new AbortController()

    const scan = countPrefix(s3, 'bucket', '', {
      signal: controller.signal,
      onProgress: () => controller.abort()
    })

    await expect(scan).rejects.toMatchObject({ name: 'AbortError' })
    expect(s3.requests).toHaveLength(1)
  })

  it('gives up on a request that is still in flight when aborted', async () => {
    const s3 = fakeS3([{ key: 'a.txt', size: 1 }], { delayMs: Infinity })
    const controller = new AbortController()

    const scan = countPrefix(s3, 'bucket', '', { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)

    await expect(scan).rejects.toMatchObject({ name: 'AbortError' })
  }, 1000)
})

describe('createPrefixScanner', () => {
  it('finishes with the totals, tagged with the id the caller chose', async () => {
    const s3 = fakeS3([
      { key: 'docs/a.txt', size: 10 },
      { key: 'docs/b.txt', size: 20 }
    ])
    const events: PrefixStats[] = []
    const scanner = createPrefixScanner({ getClient: () => s3, emit: (e) => events.push(e) })

    scanner.start('scan-1', 'acc', 'bucket', 'docs/')

    await vi.waitFor(() => expect(events.at(-1)?.done).toBe(true))
    expect(events.at(-1)).toEqual({ scanId: 'scan-1', objects: 2, bytes: 30, done: true })
  })

  it('silences the scan it replaces', async () => {
    const slow = fakeS3([{ key: 'big/a.txt', size: 1 }], { delayMs: 60 })
    const fast = fakeS3([{ key: 'small/b.txt', size: 2 }])
    const events: PrefixStats[] = []
    const scanner = createPrefixScanner({
      getClient: (acc) => (acc === 'slow' ? slow : fast),
      emit: (e) => events.push(e)
    })

    scanner.start('old', 'slow', 'bucket', 'big/')
    scanner.start('new', 'fast', 'bucket', 'small/')
    // long enough for the slow listing to have answered, had it not been abandoned
    await new Promise((r) => setTimeout(r, 150))

    expect(events.filter((e) => e.scanId === 'old')).toEqual([])
    expect(events.at(-1)).toEqual({ scanId: 'new', objects: 1, bytes: 2, done: true })
  })

  it('finishes with an error when the listing is refused', async () => {
    // the shape the SDK throws for a 403 on ListObjectsV2
    const denied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 }
    })
    const s3 = fakeS3([], { failWith: denied })
    const events: PrefixStats[] = []
    const scanner = createPrefixScanner({ getClient: () => s3, emit: (e) => events.push(e) })

    scanner.start('scan-1', 'acc', 'bucket', 'private/')

    await vi.waitFor(() => expect(events.at(-1)?.done).toBe(true))
    expect(events.at(-1)).toMatchObject({ scanId: 'scan-1', done: true, error: 'Access Denied' })
  })

  it('finishes with an error when the connection cannot be used', () => {
    const events: PrefixStats[] = []
    const scanner = createPrefixScanner({
      getClient: () => {
        throw new Error('Unknown connection: gone')
      },
      emit: (e) => events.push(e)
    })

    expect(() => scanner.start('scan-1', 'gone', 'bucket', '')).not.toThrow()
    return vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        scanId: 'scan-1',
        done: true,
        error: 'Unknown connection: gone'
      })
    )
  })

  it('reports counts while the scan is still running', async () => {
    const s3 = fakeS3(
      [
        { key: 'a.txt', size: 100 },
        { key: 'b.txt', size: 200 },
        { key: 'c.txt', size: 300 },
        { key: 'd.txt', size: 400 },
        { key: 'e.txt', size: 500 }
      ],
      { pageSize: 2 }
    )
    const events: PrefixStats[] = []
    const scanner = createPrefixScanner({
      getClient: () => s3,
      emit: (e) => events.push(e),
      throttleMs: 0
    })

    scanner.start('scan-1', 'acc', 'bucket', '')

    await vi.waitFor(() => expect(events.at(-1)?.done).toBe(true))
    const running = events.filter((e) => !e.done).map((e) => [e.objects, e.bytes])
    expect(running).toEqual(
      expect.arrayContaining([
        [2, 300],
        [4, 1000]
      ])
    )
  })

  it('holds back rapid progress but always delivers the final totals', async () => {
    const s3 = fakeS3(
      [
        { key: 'a.txt', size: 100 },
        { key: 'b.txt', size: 200 },
        { key: 'c.txt', size: 300 },
        { key: 'd.txt', size: 400 },
        { key: 'e.txt', size: 500 }
      ],
      { pageSize: 2 }
    )
    const events: PrefixStats[] = []
    const scanner = createPrefixScanner({
      getClient: () => s3,
      emit: (e) => events.push(e),
      throttleMs: 60_000
    })

    scanner.start('scan-1', 'acc', 'bucket', '')

    await vi.waitFor(() => expect(events.at(-1)?.done).toBe(true))
    // three pages arrive within one throttle window, so not every one is forwarded
    expect(events.filter((e) => !e.done).length).toBeLessThan(3)
    expect(events.at(-1)).toEqual({ scanId: 'scan-1', objects: 5, bytes: 1500, done: true })
  })

  it('stop() silences the running scan without starting another', async () => {
    const slow = fakeS3([{ key: 'big/a.txt', size: 1 }], { delayMs: 60 })
    const events: PrefixStats[] = []
    const scanner = createPrefixScanner({ getClient: () => slow, emit: (e) => events.push(e) })

    scanner.start('scan-1', 'acc', 'bucket', 'big/')
    scanner.stop()
    await new Promise((r) => setTimeout(r, 150))

    expect(events).toEqual([])
  })
})
