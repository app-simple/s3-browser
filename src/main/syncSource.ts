import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import type { ListClient } from './prefixScan'
import type { ItemSource, QueueItem, Take } from './transferQueue'

export interface SyncEntry {
  key: string
}

export interface ListingSource extends ItemSource<SyncEntry> {
  /** the whole prefix's size, once a parallel count has finished */
  setTotals(items: number, bytes: number): void
  /** record that an item settled; returns the new resume mark if it moved */
  settle(index: number): string | undefined
}

/**
 * Feeds a bucket sync to the queue one listing page at a time, so memory stays
 * flat however large the bucket is. The resume mark is the key up to which
 * every handed-out item has settled; a later run lists from there on.
 */
export function listingSource(opts: {
  client: () => ListClient
  bucket: string
  prefix: string
  /** continue after this key, from the mark of a previous run */
  startAfter?: string
  /** a page arrived: the queue should ask again */
  wake(): void
}): ListingSource {
  let buffer: QueueItem<SyncEntry>[] = []
  let token: string | undefined
  let firstPage = true
  let listedAll = false
  let fetching = false
  let stopped = false
  let failure: string | undefined
  let nextIndex = 0
  let totals: { items: number | null; bytes: number | null } = { items: null, bytes: null }
  const handedOut = new Map<number, string>()
  const settledAhead = new Set<number>()
  let contiguous = 0

  async function fetchPage(): Promise<void> {
    fetching = true
    try {
      const res = await opts.client().send(
        new ListObjectsV2Command({
          Bucket: opts.bucket,
          Prefix: opts.prefix || undefined,
          MaxKeys: 1000,
          ContinuationToken: token,
          StartAfter: firstPage ? opts.startAfter : undefined
        })
      )
      firstPage = false
      for (const o of res.Contents ?? []) {
        // "folder/" placeholders are not documents
        if (!o.Key || o.Key.endsWith('/')) continue
        buffer.push({
          index: nextIndex++,
          name: o.Key.slice(opts.prefix.length),
          size: o.Size ?? 0,
          data: { key: o.Key }
        })
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
      listedAll = !token
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    } finally {
      fetching = false
    }
    if (!stopped) opts.wake()
  }

  return {
    take(): Take<SyncEntry> {
      if (failure) return { error: failure }
      const item = buffer.shift()
      if (item) {
        handedOut.set(item.index, item.data.key)
        return { item }
      }
      if (listedAll || stopped) return { exhausted: true }
      if (!fetching) void fetchPage()
      return { waiting: true }
    },
    peek: (n) => buffer.slice(0, n),
    // unknown until the listing is complete; a failure must surface through take()
    waiting: () => (stopped ? 0 : failure || !listedAll ? null : buffer.length),
    totals: () => totals,
    drain() {
      stopped = true
      const left = buffer.length
      buffer = []
      return left
    },
    setTotals(items, bytes) {
      totals = { items, bytes }
    },
    settle(index) {
      settledAhead.add(index)
      let mark: string | undefined
      while (settledAhead.has(contiguous)) {
        mark = handedOut.get(contiguous)
        handedOut.delete(contiguous)
        settledAhead.delete(contiguous)
        contiguous++
      }
      return mark
    }
  }
}
