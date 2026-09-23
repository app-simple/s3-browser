import { isAbsolute } from 'node:path'
import type { EntryRef, JobRequest, S3Location } from '@shared/types'

function fail(what: string): never {
  throw new Error(`Invalid transfer request: ${what}`)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(what)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(what)
  return value
}

function absolutePath(value: unknown, what: string): string {
  const path = text(value, what)
  if (!path || path.includes('\0') || !isAbsolute(path)) fail(what)
  return path
}

function location(value: unknown): S3Location {
  const o = record(value, 'target')
  return {
    accountId: text(o.accountId, 'target connection'),
    bucket: text(o.bucket, 'target bucket'),
    prefix: text(o.prefix, 'target folder')
  }
}

function entries(value: unknown): EntryRef[] {
  if (!Array.isArray(value)) fail('entries')
  return value.map((raw) => {
    const o = record(raw, 'entry')
    if (o.type !== 'file' && o.type !== 'folder') fail('entry type')
    const key = text(o.key, 'entry key')
    if (o.size === undefined) return { key, type: o.type }
    if (typeof o.size !== 'number' || !Number.isFinite(o.size) || o.size < 0) fail('entry size')
    return { key, type: o.type, size: o.size }
  })
}

/** Rebuild a renderer request field by field; nothing unexpected reaches the queue. */
export function parseJobRequest(input: unknown): JobRequest {
  const o = record(input, 'request')
  const accountId = text(o.accountId, 'connection')
  const bucket = text(o.bucket, 'bucket')
  switch (o.kind) {
    case 'upload':
      if (!Array.isArray(o.paths)) fail('paths')
      return {
        kind: 'upload',
        accountId,
        bucket,
        prefix: text(o.prefix, 'folder'),
        paths: o.paths.map((p) => absolutePath(p, 'upload path'))
      }
    case 'download':
      return {
        kind: 'download',
        accountId,
        bucket,
        entries: entries(o.entries),
        destDir: absolutePath(o.destDir, 'download folder')
      }
    case 'copy':
      return { kind: 'copy', accountId, bucket, entries: entries(o.entries), target: location(o.target) }
    case 'sync':
      return { kind: 'sync', accountId, bucket, prefix: text(o.prefix, 'folder'), target: location(o.target) }
    default:
      return fail('kind')
  }
}
