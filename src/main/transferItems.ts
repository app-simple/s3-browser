import { Upload } from '@aws-sdk/lib-storage'
import {
  CopyObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  type S3Client
} from '@aws-sdk/client-s3'
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { EntryRef } from '@shared/types'
import type { QueueItem, RunContext } from './transferQueue'

export interface UploadData {
  file: string
  key: string
}

export interface DownloadData {
  key: string
  /** path below the download folder; resolved through localPathFor on every run */
  rel: string
}

export interface CopyData {
  key: string
  targetKey: string
}

/** Lists every object under a prefix; injected so the builders need no S3. */
export type ListKeys = (prefix: string) => Promise<{ key: string; size: number }[]>

/** The slice of S3Client a download needs. */
export interface GetClient {
  send(
    command: GetObjectCommand,
    options?: { abortSignal?: AbortSignal }
  ): Promise<GetObjectCommandOutput>
}

/** CopyObject rejects sources above 5 GiB; larger objects fall back to streaming. */
const COPY_OBJECT_LIMIT = 5 * 1024 * 1024 * 1024

/**
 * Map an object key (relative to the download root) onto a path inside destDir.
 * Keys on shared buckets are attacker-controlled: ".."/"." segments, backslashes
 * and drive prefixes must never let a download escape the folder the user picked.
 */
export function localPathFor(destDir: string, rel: string): string {
  const segments = rel.split('/').filter((seg) => seg.length > 0)
  if (segments.length === 0) throw new Error(`Cannot derive a file name from "${rel}"`)
  for (const seg of segments) {
    const dotOnly = seg === '.' || seg === '..'
    const badChars = /[\\\0]/.test(seg) || (process.platform === 'win32' && seg.includes(':'))
    if (dotOnly || badChars) {
      throw new Error(`Refusing to write "${rel}": unsafe path segment "${seg}"`)
    }
  }
  const root = resolve(destDir)
  const target = resolve(root, ...segments)
  const inside = relative(root, target)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`Refusing to write "${rel}" outside of ${root}`)
  }
  return target
}

/**
 * Expand local paths (files and directories) into files with their key suffix.
 * Symlinks inside a folder are skipped: following them could upload files from
 * outside the selected tree (e.g. a link to ~/.ssh) or loop forever on cycles.
 */
function expandLocal(paths: string[]): { file: string; rel: string; size: number }[] {
  const out: { file: string; rel: string; size: number }[] = []
  const walk = (abs: string, root: string): void => {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      for (const child of readdirSync(abs)) walk(join(abs, child), root)
    } else if (st.isFile()) {
      out.push({ file: abs, rel: relative(root, abs).split(sep).join('/'), size: st.size })
    }
  }
  for (const p of paths) {
    const st = statSync(p)
    if (st.isDirectory()) walk(p, dirname(p))
    else out.push({ file: p, rel: basename(p), size: st.size })
  }
  return out
}

/** Flatten a selection into objects; a selected folder keeps its own name. */
async function expandEntries(
  list: ListKeys,
  entries: EntryRef[]
): Promise<{ key: string; rel: string; size: number }[]> {
  const out: { key: string; rel: string; size: number }[] = []
  for (const e of entries) {
    if (e.type === 'folder') {
      const parentLen = e.key.replace(/\/$/, '').lastIndexOf('/') + 1
      for (const obj of await list(e.key)) {
        if (obj.key.endsWith('/')) continue
        out.push({ key: obj.key, rel: obj.key.slice(parentLen), size: obj.size })
      }
    } else {
      out.push({ key: e.key, rel: e.key.slice(e.key.lastIndexOf('/') + 1), size: e.size ?? 0 })
    }
  }
  return out
}

export function buildUploadItems(prefix: string, paths: string[]): QueueItem<UploadData>[] {
  return expandLocal(paths).map((e, index) => ({
    index,
    name: e.rel,
    size: e.size,
    data: { file: e.file, key: `${prefix}${e.rel}` }
  }))
}

export async function buildDownloadItems(
  list: ListKeys,
  entries: EntryRef[]
): Promise<QueueItem<DownloadData>[]> {
  return (await expandEntries(list, entries)).map((o, index) => ({
    index,
    name: o.rel,
    size: o.size,
    data: { key: o.key, rel: o.rel }
  }))
}

export async function buildCopyItems(
  list: ListKeys,
  entries: EntryRef[],
  targetPrefix: string
): Promise<QueueItem<CopyData>[]> {
  return (await expandEntries(list, entries)).map((o, index) => ({
    index,
    name: o.rel,
    size: o.size,
    data: { key: o.key, targetKey: `${targetPrefix}${o.rel}` }
  }))
}

/** lib-storage wants an AbortController of its own; follow the queue's signal. */
function controllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

export async function runUpload(
  client: S3Client,
  bucket: string,
  item: QueueItem<UploadData>,
  ctx: RunContext
): Promise<'done'> {
  try {
    statSync(item.data.file)
  } catch {
    throw new Error('The file no longer exists')
  }
  const upload = new Upload({
    client,
    params: { Bucket: bucket, Key: item.data.key, Body: createReadStream(item.data.file) },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
    abortController: controllerFor(ctx.signal)
  })
  upload.on('httpUploadProgress', (p) => ctx.onProgress(p.loaded ?? 0))
  await upload.done()
  return 'done'
}

export async function runDownload(
  client: GetClient,
  bucket: string,
  destDir: string,
  item: QueueItem<DownloadData>,
  ctx: RunContext
): Promise<'done'> {
  // recomputed on every run: a stored path is never trusted to stay inside destDir
  const target = localPathFor(destDir, item.data.rel)
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.data.key }), {
    abortSignal: ctx.signal
  })
  mkdirSync(dirname(target), { recursive: true })
  let loaded = 0
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      loaded += chunk.length
      ctx.onProgress(loaded)
      cb(null, chunk)
    }
  })
  // write beside the target and move it into place only when complete: a download that breaks
  // off, is cancelled or is cut by quitting never leaves a truncated file that looks finished
  const partial = `${target}.part`
  try {
    await pipeline(res.Body as Readable, meter, createWriteStream(partial), { signal: ctx.signal })
  } catch (err) {
    rmSync(partial, { force: true })
    throw err
  }
  renameSync(partial, target)
  return 'done'
}

export interface CopyRoute {
  source: S3Client
  target: S3Client
  sameAccount: boolean
  sourceBucket: string
  targetBucket: string
}

/** Copy one object: server-side within an account, streamed across accounts. */
export async function runCopy(
  route: CopyRoute,
  item: QueueItem<CopyData>,
  ctx: RunContext
): Promise<'done'> {
  const { key, targetKey } = item.data
  if (route.sameAccount && route.sourceBucket === route.targetBucket && key === targetKey) {
    throw new Error('Source and destination are the same object')
  }
  if (route.sameAccount && item.size <= COPY_OBJECT_LIMIT) {
    // server-side copy: the data never leaves the provider
    await route.source.send(
      new CopyObjectCommand({
        Bucket: route.targetBucket,
        CopySource: `${route.sourceBucket}/${key}`.split('/').map(encodeURIComponent).join('/'),
        Key: targetKey
      }),
      { abortSignal: ctx.signal }
    )
    ctx.onProgress(item.size)
    return 'done'
  }
  // across accounts: pipe the source stream straight into a multipart upload
  const res = await route.source.send(
    new GetObjectCommand({ Bucket: route.sourceBucket, Key: key }),
    { abortSignal: ctx.signal }
  )
  const total = res.ContentLength ?? item.size
  const upload = new Upload({
    client: route.target,
    params: {
      Bucket: route.targetBucket,
      Key: targetKey,
      Body: res.Body as Readable,
      ContentType: res.ContentType,
      Metadata: res.Metadata
    },
    queueSize: 4,
    // stay under the 10k part limit for very large objects
    partSize: Math.max(8 * 1024 * 1024, Math.ceil(total / 9000)),
    leavePartsOnError: false,
    abortController: controllerFor(ctx.signal)
  })
  upload.on('httpUploadProgress', (p) => ctx.onProgress(p.loaded ?? 0))
  await upload.done()
  return 'done'
}
