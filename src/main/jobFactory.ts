import { basename } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import type { ConflictMode, S3Location } from '@shared/types'
import { countPrefix } from './prefixScan'
import type { JobFactory, JobRuntime, PlannedJob } from './queueService'
import { listingSource, type SyncEntry } from './syncSource'
import {
  buildCopyItems,
  buildDownloadItems,
  buildUploadItems,
  runCopy,
  runDownload,
  runUpload,
  type CopyData,
  type CopyRoute,
  type DownloadData,
  type ListKeys,
  type UploadData
} from './transferItems'
import { JobFailure, type QueueItem } from './transferQueue'

interface UploadSpec {
  accountId: string
  bucket: string
}

interface DownloadSpec {
  accountId: string
  bucket: string
  destDir: string
}

interface CopySpec {
  accountId: string
  bucket: string
  target: S3Location
}

interface SyncSpec {
  accountId: string
  bucket: string
  prefix: string
  target: S3Location
}

const count = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
const at = (bucket: string, prefix: string): string => `${bucket}/${prefix}`

export interface FactoryDeps {
  getClient(accountId: string): S3Client
  accountExists(accountId: string): boolean
  listKeys(accountId: string, bucket: string, prefix: string): Promise<{ key: string; size: number }[]>
}

export function createJobFactory(deps: FactoryDeps): JobFactory {
  const lister =
    (accountId: string, bucket: string): ListKeys =>
    (prefix) =>
      deps.listKeys(accountId, bucket, prefix)

  /** Checked per item, so a deleted connection ends the job once instead of failing every item. */
  function client(accountId: string): S3Client {
    if (!deps.accountExists(accountId)) {
      throw new JobFailure('The connection used by this job no longer exists')
    }
    return deps.getClient(accountId)
  }

  function route(accountId: string, bucket: string, target: S3Location): CopyRoute {
    return {
      source: client(accountId),
      target: client(target.accountId),
      sameAccount: accountId === target.accountId,
      sourceBucket: bucket,
      targetBucket: target.bucket
    }
  }

  function syncRuntime(
    spec: SyncSpec,
    conflict: ConflictMode,
    startAfter: string | undefined,
    wake: () => void
  ): JobRuntime {
    const source = listingSource({
      client: () => client(spec.accountId),
      bucket: spec.bucket,
      prefix: spec.prefix,
      startAfter,
      wake
    })
    // the whole prefix is counted alongside; until then the job shows no total
    void (async () => {
      try {
        const totals = await countPrefix(client(spec.accountId), spec.bucket, spec.prefix)
        source.setTotals(totals.objects, totals.bytes)
        wake()
      } catch {
        // the sync still runs, only without a total
      }
    })()
    // one listing of the destination answers "already there with this size?" for every object
    let existing: Promise<Map<string, number>> | undefined
    const existingSizes = (): Promise<Map<string, number>> =>
      (existing ??= deps
        .listKeys(spec.target.accountId, spec.target.bucket, spec.target.prefix)
        .then((list) => new Map(list.map((o) => [o.key, o.size]))))

    return {
      source,
      onSettled: (index) => source.settle(index),
      async run(item, ctx) {
        const entry = item as QueueItem<SyncEntry>
        const targetKey = spec.target.prefix + entry.data.key.slice(spec.prefix.length)
        const sameObject =
          spec.accountId === spec.target.accountId &&
          spec.bucket === spec.target.bucket &&
          entry.data.key === targetKey
        if (sameObject) return 'skipped'
        if (conflict === 'skip' && (await existingSizes()).get(targetKey) === entry.size) {
          return 'skipped'
        }
        return runCopy(
          route(spec.accountId, spec.bucket, spec.target),
          { ...entry, data: { key: entry.data.key, targetKey } },
          ctx
        )
      }
    }
  }

  return {
    async plan(req): Promise<PlannedJob> {
      switch (req.kind) {
        case 'upload': {
          const items = buildUploadItems(req.prefix, req.paths)
          const spec: UploadSpec = { accountId: req.accountId, bucket: req.bucket }
          return {
            kind: 'upload',
            title: `Upload ${count(items.length, 'file')} → ${at(req.bucket, req.prefix)}`,
            target: { type: 's3', accountId: req.accountId, bucket: req.bucket, prefix: req.prefix },
            items,
            conflicts: [],
            sample: [],
            spec
          }
        }
        case 'download': {
          const items = await buildDownloadItems(lister(req.accountId, req.bucket), req.entries)
          const spec: DownloadSpec = { accountId: req.accountId, bucket: req.bucket, destDir: req.destDir }
          return {
            kind: 'download',
            title: `Download ${count(items.length, 'file')} → ${basename(req.destDir)}`,
            target: { type: 'local', dir: req.destDir },
            items,
            conflicts: [],
            sample: [],
            spec
          }
        }
        case 'copy': {
          const items = await buildCopyItems(lister(req.accountId, req.bucket), req.entries, req.target.prefix)
          // today's check, narrowed to what a selection touches in Task 9
          const existing = new Set(
            (await deps.listKeys(req.target.accountId, req.target.bucket, req.target.prefix)).map((o) => o.key)
          )
          const clashing = items.filter((i) => existing.has(i.data.targetKey))
          const spec: CopySpec = { accountId: req.accountId, bucket: req.bucket, target: req.target }
          return {
            kind: 'copy',
            title: `Copy ${count(items.length, 'object')} → ${at(req.target.bucket, req.target.prefix)}`,
            target: { type: 's3', ...req.target },
            items,
            conflicts: clashing.map((i) => i.index),
            sample: clashing.slice(0, 5).map((i) => i.data.targetKey),
            spec
          }
        }
        case 'sync': {
          const onto =
            req.accountId === req.target.accountId &&
            req.bucket === req.target.bucket &&
            req.prefix === req.target.prefix
          if (onto) throw new Error('Source and destination are identical')
          const spec: SyncSpec = { accountId: req.accountId, bucket: req.bucket, prefix: req.prefix, target: req.target }
          return {
            kind: 'sync',
            title: `Copy contents ${at(req.bucket, req.prefix)} → ${at(req.target.bucket, req.target.prefix)}`,
            target: { type: 's3', ...req.target },
            items: null,
            conflicts: [],
            sample: [],
            spec
          }
        }
      }
    },

    runtime(job, wake): JobRuntime {
      switch (job.kind) {
        case 'upload': {
          const s = job.spec as UploadSpec
          return {
            run: async (item, ctx) => runUpload(client(s.accountId), s.bucket, item as QueueItem<UploadData>, ctx)
          }
        }
        case 'download': {
          const s = job.spec as DownloadSpec
          return {
            run: async (item, ctx) =>
              runDownload(client(s.accountId), s.bucket, s.destDir, item as QueueItem<DownloadData>, ctx)
          }
        }
        case 'copy': {
          const s = job.spec as CopySpec
          return {
            run: async (item, ctx) =>
              runCopy(route(s.accountId, s.bucket, s.target), item as QueueItem<CopyData>, ctx)
          }
        }
        case 'sync':
          return syncRuntime(job.spec as SyncSpec, job.conflict, job.startAfter, wake)
      }
    }
  }
}
