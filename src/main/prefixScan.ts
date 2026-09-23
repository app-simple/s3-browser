import { ListObjectsV2Command, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3'
import type { PrefixStats } from '@shared/types'

/** The slice of S3Client a scan needs — lets the listing be driven without a network. */
export interface ListClient {
  send(
    command: ListObjectsV2Command,
    options?: { abortSignal?: AbortSignal }
  ): Promise<ListObjectsV2CommandOutput>
}

/**
 * Count every document under a prefix, subfolders included, holding only two
 * running totals — a folder of a million objects costs a thousand LIST
 * requests but no memory to speak of.
 */
export async function countPrefix(
  client: ListClient,
  bucket: string,
  prefix: string,
  opts: {
    signal?: AbortSignal
    onProgress?: (objects: number, bytes: number) => void
  } = {}
): Promise<{ objects: number; bytes: number }> {
  let objects = 0
  let bytes = 0
  let token: string | undefined
  do {
    // a cancelled scan must not fetch another page
    opts.signal?.throwIfAborted()
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        MaxKeys: 1000,
        ContinuationToken: token
      }),
      { abortSignal: opts.signal }
    )
    for (const o of res.Contents ?? []) {
      // "folder/" placeholders are not documents; the object table skips them too
      if (!o.Key || o.Key.endsWith('/')) continue
      objects++
      bytes += o.Size ?? 0
    }
    opts.onProgress?.(objects, bytes)
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return { objects, bytes }
}

/**
 * Runs one folder count at a time and reports it through `emit`. The caller
 * picks the scan id, so it knows which scan an event belongs to before the
 * first event can arrive.
 */
export function createPrefixScanner(deps: {
  getClient: (accountId: string) => ListClient
  emit: (stats: PrefixStats) => void
  /** minimum gap between progress events; the final result is never held back */
  throttleMs?: number
}): {
  start(scanId: string, accountId: string, bucket: string, prefix: string): void
  stop(): void
} {
  const throttleMs = deps.throttleMs ?? 120
  // only the folder on screen is worth counting: a new scan cancels the previous one
  let current: AbortController | undefined
  return {
    start(scanId, accountId, bucket, prefix) {
      current?.abort()
      const controller = new AbortController()
      current = controller
      let lastEmit = -Infinity
      void (async () => {
        try {
          const { objects, bytes } = await countPrefix(deps.getClient(accountId), bucket, prefix, {
            signal: controller.signal,
            onProgress: (objects, bytes) => {
              const now = Date.now()
              if (now - lastEmit < throttleMs) return
              lastEmit = now
              deps.emit({ scanId, objects, bytes, done: false })
            }
          })
          deps.emit({ scanId, objects, bytes, done: true })
        } catch (err) {
          // a replaced scan has nothing left to report
          if (controller.signal.aborted) return
          const error = err instanceof Error ? err.message : String(err)
          deps.emit({ scanId, objects: 0, bytes: 0, done: true, error })
        }
      })()
    },
    stop() {
      current?.abort()
      current = undefined
    }
  }
}
