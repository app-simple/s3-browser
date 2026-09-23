import { Readable } from 'node:stream'
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type ListObjectsV2CommandOutput
} from '@aws-sdk/client-s3'

export interface FakeObject {
  key: string
  size: number
  /** content served by GetObject; defaults to `size` bytes of "x" */
  body?: string
}

export interface FakeS3Options {
  /** keys per listing page; S3 may return fewer than MaxKeys, so callers must follow IsTruncated */
  pageSize?: number
  /** answer after this many ms; Infinity never answers until the request is aborted */
  delayMs?: number
  /** every request fails with this error */
  failWith?: Error
  /** HeadObject answers with this HTTP status instead of looking the key up */
  headStatus?: number
}

export interface FakeRequest {
  command: 'list' | 'head' | 'get'
  input: object
}

/** An error shaped the way the SDK throws one for an HTTP status. */
export function httpError(status: number, name: string, message: string): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: status >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: status }
  })
}

const aborted = (): Error => Object.assign(new Error('Request aborted'), { name: 'AbortError' })

/**
 * Stands in for the network: answers ListObjectsV2, HeadObject and GetObject the
 * way S3 does — prefix filtering, delimiter grouping, StartAfter, lexicographic
 * order and paging through continuation tokens — and records every request.
 */
export function fakeS3(objects: FakeObject[], opts: FakeS3Options = {}) {
  const requests: FakeRequest[] = []
  const sorted = [...objects].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  async function wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw aborted()
    if (opts.failWith) throw opts.failWith
    if (!opts.delayMs) return
    await new Promise<void>((resolve, reject) => {
      if (Number.isFinite(opts.delayMs)) setTimeout(resolve, opts.delayMs)
      signal?.addEventListener('abort', () => reject(aborted()))
    })
  }

  function list(input: ListObjectsV2Command['input']): ListObjectsV2CommandOutput {
    const prefix = input.Prefix ?? ''
    // StartAfter only applies to the first page; later pages continue from the token
    const after = input.ContinuationToken ? undefined : input.StartAfter
    const rows: ({ obj: FakeObject } | { common: string })[] = []
    const seen = new Set<string>()
    for (const o of sorted) {
      if (!o.key.startsWith(prefix)) continue
      if (after !== undefined && o.key <= after) continue
      const rest = o.key.slice(prefix.length)
      const cut = input.Delimiter ? rest.indexOf(input.Delimiter) : -1
      if (cut === -1) {
        rows.push({ obj: o })
      } else {
        const common = prefix + rest.slice(0, cut + 1)
        if (!seen.has(common)) {
          seen.add(common)
          rows.push({ common })
        }
      }
    }
    const start = input.ContinuationToken ? Number(input.ContinuationToken.slice('tok-'.length)) : 0
    const limit = Math.min(opts.pageSize ?? 1000, input.MaxKeys ?? 1000)
    const page = rows.slice(start, start + limit)
    const next = start + limit
    const truncated = next < rows.length
    const contents = page.flatMap((r) =>
      'obj' in r
        ? [
            {
              Key: r.obj.key,
              LastModified: new Date('2026-01-01T00:00:00Z'),
              ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
              Size: r.obj.size,
              StorageClass: 'STANDARD' as const
            }
          ]
        : []
    )
    const commons = page.flatMap((r) => ('common' in r ? [{ Prefix: r.common }] : []))
    return {
      $metadata: { httpStatusCode: 200 },
      IsTruncated: truncated,
      // S3 leaves these out entirely rather than sending empty arrays
      ...(contents.length ? { Contents: contents } : {}),
      ...(commons.length ? { CommonPrefixes: commons } : {}),
      Name: input.Bucket,
      Prefix: prefix,
      Delimiter: input.Delimiter,
      MaxKeys: input.MaxKeys ?? 1000,
      KeyCount: page.length,
      ContinuationToken: input.ContinuationToken,
      ...(truncated ? { NextContinuationToken: `tok-${next}` } : {})
    }
  }

  function find(key: string | undefined): FakeObject {
    const o = sorted.find((x) => x.key === key)
    if (!o) throw httpError(404, 'NotFound', 'Not Found')
    return o
  }

  function send(
    command: ListObjectsV2Command,
    options?: { abortSignal?: AbortSignal }
  ): Promise<ListObjectsV2CommandOutput>
  function send(
    command: HeadObjectCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<HeadObjectCommandOutput>
  function send(
    command: GetObjectCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<GetObjectCommandOutput>
  function send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>
  async function send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    if (command instanceof ListObjectsV2Command) {
      requests.push({ command: 'list', input: { ...command.input } })
      await wait(options?.abortSignal)
      return list(command.input)
    }
    if (command instanceof HeadObjectCommand) {
      requests.push({ command: 'head', input: { ...command.input } })
      await wait(options?.abortSignal)
      if (opts.headStatus) {
        throw httpError(opts.headStatus, opts.headStatus === 403 ? 'Forbidden' : 'Unknown', `HTTP ${opts.headStatus}`)
      }
      const o = find(command.input.Key)
      return { $metadata: { httpStatusCode: 200 }, ContentLength: o.size, ETag: '"etag"' }
    }
    if (command instanceof GetObjectCommand) {
      requests.push({ command: 'get', input: { ...command.input } })
      await wait(options?.abortSignal)
      const o = find(command.input.Key)
      const body = o.body ?? 'x'.repeat(o.size)
      return {
        $metadata: { httpStatusCode: 200 },
        ContentLength: Buffer.byteLength(body),
        Body: Readable.from([Buffer.from(body)])
      }
    }
    throw new Error(`fakeS3 does not handle ${command.constructor.name}`)
  }

  return { requests, send }
}
