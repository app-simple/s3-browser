import { Upload } from '@aws-sdk/lib-storage'
import { CopyObjectCommand, GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { dirname, join, relative, sep, basename as pathBasename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { Transfer, TransferKind } from '@shared/types'
import { getClient, listAllKeys } from './s3'
import { localPathFor } from './transferItems'

const transfers = new Map<string, Transfer>()
const aborters = new Map<string, AbortController>()

function broadcast(t: Transfer): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('transfer:update', t)
  }
}

function create(
  kind: TransferKind,
  name: string,
  accountId: string,
  bucket: string,
  key: string,
  localPath: string,
  total: number,
  extra: Partial<Transfer> = {}
): Transfer {
  const t: Transfer = {
    id: randomUUID(),
    kind,
    name,
    accountId,
    bucket,
    key,
    localPath,
    loaded: 0,
    total,
    status: 'queued',
    startedAt: Date.now(),
    ...extra
  }
  transfers.set(t.id, t)
  broadcast(t)
  return t
}

function update(id: string, patch: Partial<Transfer>): void {
  const t = transfers.get(id)
  if (!t) return
  Object.assign(t, patch)
  broadcast(t)
}

export function listTransfers(): Transfer[] {
  return [...transfers.values()].sort((a, b) => b.startedAt - a.startedAt)
}

export function cancelTransfer(id: string): void {
  aborters.get(id)?.abort()
  const t = transfers.get(id)
  if (t && (t.status === 'queued' || t.status === 'running')) {
    update(id, { status: 'cancelled', finishedAt: Date.now() })
  }
}

export function clearFinishedTransfers(): void {
  for (const [id, t] of transfers) {
    if (t.status !== 'running' && t.status !== 'queued') transfers.delete(id)
  }
}

/** Whether a local path belongs to a download this app performed (used to gate "reveal"). */
export function isDownloadedPath(path: string): boolean {
  for (const t of transfers.values()) {
    if (t.kind === 'download' && t.localPath === path) return true
  }
  return false
}


/**
 * Expand local paths (files and directories) into { absolute path, key suffix } pairs.
 * Symlinks inside a folder are skipped: following them could upload files from
 * outside the selected tree (e.g. a link to ~/.ssh) or loop forever on cycles.
 */
function expandLocal(paths: string[]): { file: string; rel: string }[] {
  const out: { file: string; rel: string }[] = []
  const walk = (abs: string, root: string): void => {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      for (const child of readdirSync(abs)) walk(join(abs, child), root)
    } else if (st.isFile()) {
      out.push({ file: abs, rel: relative(root, abs).split(sep).join('/') })
    }
  }
  for (const p of paths) {
    const st = statSync(p)
    if (st.isDirectory()) walk(p, dirname(p))
    else out.push({ file: p, rel: pathBasename(p) })
  }
  return out
}

export async function uploadPaths(
  accountId: string,
  bucket: string,
  prefix: string,
  paths: string[]
): Promise<number> {
  const items = expandLocal(paths)
  const client = getClient(accountId)

  for (const item of items) {
    const key = `${prefix}${item.rel}`
    const size = statSync(item.file).size
    const t = create('upload', item.rel, accountId, bucket, key, item.file, size)
    const controller = new AbortController()
    aborters.set(t.id, controller)

    try {
      update(t.id, { status: 'running' })
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: createReadStream(item.file) },
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
        abortController: controller
      })
      upload.on('httpUploadProgress', (p) => {
        update(t.id, { loaded: p.loaded ?? 0, total: p.total ?? size })
      })
      await upload.done()
      update(t.id, { status: 'done', loaded: size, finishedAt: Date.now() })
    } catch (err) {
      if (controller.signal.aborted) {
        update(t.id, { status: 'cancelled', finishedAt: Date.now() })
      } else {
        update(t.id, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now()
        })
      }
    } finally {
      aborters.delete(t.id)
    }
  }
  return items.length
}

export async function downloadEntries(
  accountId: string,
  bucket: string,
  entries: { key: string; type: 'file' | 'folder' }[],
  destDir: string
): Promise<number> {
  const client = getClient(accountId)

  // flatten folders into individual keys, keeping a sensible local layout;
  // keys that would land outside destDir become failed transfers instead of writes
  const jobs: { key: string; localPath: string; size: number; unsafe?: string }[] = []
  const plan = (key: string, rel: string, size: number): void => {
    try {
      jobs.push({ key, localPath: localPathFor(destDir, rel), size })
    } catch (err) {
      jobs.push({ key, localPath: '', size, unsafe: err instanceof Error ? err.message : String(err) })
    }
  }
  for (const e of entries) {
    if (e.type === 'folder') {
      const parentLen = e.key.replace(/\/$/, '').lastIndexOf('/') + 1
      const all = await listAllKeys(accountId, bucket, e.key)
      for (const obj of all) {
        if (obj.key.endsWith('/')) continue
        plan(obj.key, obj.key.slice(parentLen), obj.size)
      }
    } else {
      plan(e.key, e.key.slice(e.key.lastIndexOf('/') + 1), 0)
    }
  }

  for (const job of jobs) {
    const t = create(
      'download',
      job.key.slice(job.key.lastIndexOf('/') + 1),
      accountId,
      bucket,
      job.key,
      job.localPath,
      job.size
    )
    if (job.unsafe) {
      update(t.id, { status: 'error', error: job.unsafe, finishedAt: Date.now() })
      continue
    }
    const controller = new AbortController()
    aborters.set(t.id, controller)

    try {
      update(t.id, { status: 'running' })
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: job.key }),
        { abortSignal: controller.signal }
      )
      const total = res.ContentLength ?? job.size
      update(t.id, { total })

      mkdirSync(dirname(job.localPath), { recursive: true })

      let loaded = 0
      let lastEmit = 0
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          loaded += chunk.length
          const now = Date.now()
          if (now - lastEmit > 120) {
            lastEmit = now
            update(t.id, { loaded })
          }
          cb(null, chunk)
        }
      })

      const body = res.Body as Readable
      await pipeline(body, meter, createWriteStream(job.localPath))
      update(t.id, { status: 'done', loaded: total, total, finishedAt: Date.now() })
    } catch (err) {
      if (controller.signal.aborted) {
        update(t.id, { status: 'cancelled', finishedAt: Date.now() })
      } else {
        update(t.id, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now()
        })
      }
    } finally {
      aborters.delete(t.id)
    }
  }
  return jobs.length
}

/** CopyObject rejects sources above 5 GiB; larger objects fall back to streaming. */
const COPY_OBJECT_LIMIT = 5 * 1024 * 1024 * 1024

/** Copy one object: server-side within an account, streamed across accounts. */
async function copyObject(
  source: S3Client,
  target: S3Client,
  sameAccount: boolean,
  sourceBucket: string,
  key: string,
  targetBucket: string,
  targetKey: string,
  size: number,
  controller: AbortController,
  onProgress: (loaded: number) => void
): Promise<void> {
  if (sameAccount && size <= COPY_OBJECT_LIMIT) {
    // server-side copy: the data never leaves the provider
    await source.send(
      new CopyObjectCommand({
        Bucket: targetBucket,
        CopySource: `${sourceBucket}/${key}`.split('/').map(encodeURIComponent).join('/'),
        Key: targetKey
      }),
      { abortSignal: controller.signal }
    )
    onProgress(size)
  } else {
    // cross-account: pipe the source stream straight into a multipart
    // upload — only part buffers in memory, nothing on disk
    const res = await source.send(
      new GetObjectCommand({ Bucket: sourceBucket, Key: key }),
      { abortSignal: controller.signal }
    )
    const total = res.ContentLength ?? size
    const upload = new Upload({
      client: target,
      params: {
        Bucket: targetBucket,
        Key: targetKey,
        Body: res.Body as Readable,
        ContentType: res.ContentType,
        Metadata: res.Metadata
      },
      queueSize: 4,
      // stay under the 10k part limit for very large objects
      partSize: Math.max(8 * 1024 * 1024, Math.ceil(total / 9000)),
      leavePartsOnError: false,
      abortController: controller
    })
    upload.on('httpUploadProgress', (p) => onProgress(p.loaded ?? 0))
    await upload.done()
    onProgress(total)
  }
}

/** Flatten a selection (files and folders) into copy jobs, keeping folder layout. */
async function expandCopyJobs(
  sourceAccountId: string,
  sourceBucket: string,
  entries: { key: string; type: 'file' | 'folder'; size?: number }[],
  targetPrefix: string
): Promise<{ key: string; targetKey: string; size: number }[]> {
  const jobs: { key: string; targetKey: string; size: number }[] = []
  for (const e of entries) {
    if (e.type === 'folder') {
      const parentLen = e.key.replace(/\/$/, '').lastIndexOf('/') + 1
      const all = await listAllKeys(sourceAccountId, sourceBucket, e.key)
      for (const obj of all) {
        if (obj.key.endsWith('/')) continue
        jobs.push({
          key: obj.key,
          targetKey: `${targetPrefix}${obj.key.slice(parentLen)}`,
          size: obj.size
        })
      }
    } else {
      const name = e.key.slice(e.key.lastIndexOf('/') + 1)
      jobs.push({ key: e.key, targetKey: `${targetPrefix}${name}`, size: e.size ?? 0 })
    }
  }
  return jobs
}

/** Preview a selection copy: how many objects it involves and which already exist. */
export async function planCopy(
  sourceAccountId: string,
  sourceBucket: string,
  entries: { key: string; type: 'file' | 'folder'; size?: number }[],
  targetAccountId: string,
  targetBucket: string,
  targetPrefix: string
): Promise<{ total: number; conflicts: number; sample: string[] }> {
  const jobs = await expandCopyJobs(sourceAccountId, sourceBucket, entries, targetPrefix)
  const existing = new Set(
    (await listAllKeys(targetAccountId, targetBucket, targetPrefix)).map((o) => o.key)
  )
  const conflicts = jobs.filter((j) => existing.has(j.targetKey))
  return {
    total: jobs.length,
    conflicts: conflicts.length,
    sample: conflicts.slice(0, 5).map((j) => j.targetKey)
  }
}

export async function copyEntries(
  sourceAccountId: string,
  sourceBucket: string,
  entries: { key: string; type: 'file' | 'folder'; size?: number }[],
  targetAccountId: string,
  targetBucket: string,
  targetPrefix: string,
  skipExisting = false
): Promise<number> {
  const source = getClient(sourceAccountId)
  const target = getClient(targetAccountId)
  const sameAccount = sourceAccountId === targetAccountId

  let jobs = await expandCopyJobs(sourceAccountId, sourceBucket, entries, targetPrefix)
  if (skipExisting) {
    const existing = new Set(
      (await listAllKeys(targetAccountId, targetBucket, targetPrefix)).map((o) => o.key)
    )
    jobs = jobs.filter((j) => !existing.has(j.targetKey))
  }

  for (const job of jobs) {
    const name = job.key.slice(job.key.lastIndexOf('/') + 1)
    const t = create('copy', name, sourceAccountId, sourceBucket, job.key, '', job.size, {
      targetAccountId,
      targetBucket,
      targetKey: job.targetKey
    })

    if (sameAccount && sourceBucket === targetBucket && job.key === job.targetKey) {
      update(t.id, {
        status: 'error',
        error: 'Source and destination are the same object',
        finishedAt: Date.now()
      })
      continue
    }

    const controller = new AbortController()
    aborters.set(t.id, controller)

    try {
      update(t.id, { status: 'running' })
      let lastLoaded = 0
      await copyObject(
        source,
        target,
        sameAccount,
        sourceBucket,
        job.key,
        targetBucket,
        job.targetKey,
        job.size,
        controller,
        (loaded) => {
          lastLoaded = loaded
          update(t.id, { loaded })
        }
      )
      const finalTotal = Math.max(job.size, lastLoaded)
      update(t.id, { status: 'done', loaded: finalTotal, total: finalTotal, finishedAt: Date.now() })
    } catch (err) {
      if (controller.signal.aborted) {
        update(t.id, { status: 'cancelled', finishedAt: Date.now() })
      } else {
        update(t.id, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now()
        })
      }
    } finally {
      aborters.delete(t.id)
    }
  }
  return jobs.length
}

const SYNC_CONCURRENCY = 4

/**
 * Copy everything under sourcePrefix into targetBucket/targetPrefix as ONE
 * aggregate transfer. With skipExisting, objects already present at the
 * destination with the same size are skipped, so re-runs resume cheaply.
 */
export async function syncBucket(
  sourceAccountId: string,
  sourceBucket: string,
  sourcePrefix: string,
  targetAccountId: string,
  targetBucket: string,
  targetPrefix: string,
  skipExisting: boolean
): Promise<number> {
  const source = getClient(sourceAccountId)
  const target = getClient(targetAccountId)
  const sameAccount = sourceAccountId === targetAccountId
  if (sameAccount && sourceBucket === targetBucket && targetPrefix === sourcePrefix) {
    throw new Error('Source and destination are identical')
  }

  const t = create(
    'copy',
    `${sourceBucket} → ${targetBucket}`,
    sourceAccountId,
    sourceBucket,
    sourcePrefix,
    '',
    0,
    { targetAccountId, targetBucket, targetKey: targetPrefix }
  )
  const controller = new AbortController()
  aborters.set(t.id, controller)

  try {
    update(t.id, { status: 'running' })

    const jobs = (await listAllKeys(sourceAccountId, sourceBucket, sourcePrefix))
      .filter((o) => !o.key.endsWith('/'))
      .map((o) => ({
        key: o.key,
        targetKey: `${targetPrefix}${o.key.slice(sourcePrefix.length)}`,
        size: o.size
      }))
    const totalBytes = jobs.reduce((sum, j) => sum + j.size, 0)
    update(t.id, { total: totalBytes, itemsDone: 0, itemsTotal: jobs.length })

    // one listing of the destination beats a HEAD request per object
    const existing = skipExisting
      ? new Map(
          (await listAllKeys(targetAccountId, targetBucket, targetPrefix)).map((o) => [
            o.key,
            o.size
          ])
        )
      : new Map<string, number>()

    let doneBytes = 0
    let itemsDone = 0
    let itemsSkipped = 0
    let failed = 0
    let firstError = ''
    let lastEmit = 0
    const inFlight = new Map<string, number>()

    const emit = (): void => {
      const now = Date.now()
      if (now - lastEmit < 120) return
      lastEmit = now
      let active = 0
      for (const v of inFlight.values()) active += v
      update(t.id, {
        loaded: doneBytes + active,
        itemsDone,
        itemsSkipped,
        // oldest object still in flight — a stable "currently transferring" label
        detail: inFlight.keys().next().value
      })
    }

    let next = 0
    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const i = next++
        if (i >= jobs.length) return
        const job = jobs[i]
        const identical =
          sameAccount && sourceBucket === targetBucket && job.key === job.targetKey
        if (identical || (skipExisting && existing.get(job.targetKey) === job.size)) {
          doneBytes += job.size
          itemsDone++
          itemsSkipped++
          emit()
          continue
        }
        inFlight.set(job.key, 0)
        try {
          await copyObject(
            source,
            target,
            sameAccount,
            sourceBucket,
            job.key,
            targetBucket,
            job.targetKey,
            job.size,
            controller,
            (loaded) => {
              inFlight.set(job.key, loaded)
              emit()
            }
          )
          doneBytes += job.size
          itemsDone++
        } catch (err) {
          if (controller.signal.aborted) return
          failed++
          if (!firstError) firstError = err instanceof Error ? err.message : String(err)
        } finally {
          inFlight.delete(job.key)
          emit()
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(SYNC_CONCURRENCY, Math.max(jobs.length, 1)) }, () => worker())
    )

    if (controller.signal.aborted) {
      update(t.id, { status: 'cancelled', detail: undefined, finishedAt: Date.now() })
    } else if (failed > 0) {
      update(t.id, {
        status: 'error',
        error: `${failed} of ${jobs.length} object${jobs.length === 1 ? '' : 's'} failed — ${firstError}`,
        loaded: doneBytes,
        itemsDone,
        itemsSkipped,
        detail: undefined,
        finishedAt: Date.now()
      })
    } else {
      update(t.id, {
        status: 'done',
        loaded: totalBytes,
        total: totalBytes,
        itemsDone,
        itemsSkipped,
        detail: undefined,
        finishedAt: Date.now()
      })
    }
    return jobs.length
  } catch (err) {
    if (controller.signal.aborted) {
      update(t.id, { status: 'cancelled', finishedAt: Date.now() })
    } else {
      update(t.id, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: Date.now()
      })
    }
    return 0
  } finally {
    aborters.delete(t.id)
  }
}
