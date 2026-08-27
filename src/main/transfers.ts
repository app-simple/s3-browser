import { Upload } from '@aws-sdk/lib-storage'
import { CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { dirname, join, relative, sep, basename as pathBasename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { Transfer, TransferKind } from '@shared/types'
import { getClient, listAllKeys } from './s3'

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

/** Expand local paths (files and directories) into { absolute path, key suffix } pairs. */
function expandLocal(paths: string[]): { file: string; rel: string }[] {
  const out: { file: string; rel: string }[] = []
  const walk = (abs: string, root: string): void => {
    const st = statSync(abs)
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

  // flatten folders into individual keys, keeping a sensible local layout
  const jobs: { key: string; localPath: string; size: number }[] = []
  for (const e of entries) {
    if (e.type === 'folder') {
      const parentLen = e.key.replace(/\/$/, '').lastIndexOf('/') + 1
      const all = await listAllKeys(accountId, bucket, e.key)
      for (const obj of all) {
        if (obj.key.endsWith('/')) continue
        const rel = obj.key.slice(parentLen)
        jobs.push({ key: obj.key, localPath: join(destDir, ...rel.split('/')), size: obj.size })
      }
    } else {
      const name = e.key.slice(e.key.lastIndexOf('/') + 1)
      jobs.push({ key: e.key, localPath: join(destDir, name), size: 0 })
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

export async function copyEntries(
  sourceAccountId: string,
  sourceBucket: string,
  entries: { key: string; type: 'file' | 'folder'; size?: number }[],
  targetAccountId: string,
  targetBucket: string,
  targetPrefix: string
): Promise<number> {
  const source = getClient(sourceAccountId)
  const target = getClient(targetAccountId)
  const sameAccount = sourceAccountId === targetAccountId

  // flatten folders into individual keys, keeping their layout (like downloads)
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

      if (sameAccount && job.size <= COPY_OBJECT_LIMIT) {
        // server-side copy: the data never leaves the provider
        await source.send(
          new CopyObjectCommand({
            Bucket: targetBucket,
            CopySource: `${sourceBucket}/${job.key}`.split('/').map(encodeURIComponent).join('/'),
            Key: job.targetKey
          }),
          { abortSignal: controller.signal }
        )
        update(t.id, { status: 'done', loaded: job.size, finishedAt: Date.now() })
      } else {
        // cross-account: pipe the source stream straight into a multipart
        // upload — only part buffers in memory, nothing on disk
        const res = await source.send(
          new GetObjectCommand({ Bucket: sourceBucket, Key: job.key }),
          { abortSignal: controller.signal }
        )
        const total = res.ContentLength ?? job.size
        update(t.id, { total })

        const upload = new Upload({
          client: target,
          params: {
            Bucket: targetBucket,
            Key: job.targetKey,
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
        upload.on('httpUploadProgress', (p) => {
          update(t.id, { loaded: p.loaded ?? 0 })
        })
        await upload.done()
        update(t.id, { status: 'done', loaded: total, total, finishedAt: Date.now() })
      }
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
