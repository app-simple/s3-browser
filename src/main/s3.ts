import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  GetBucketLocationCommand,
  type _Object,
  type CommonPrefix
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { Agent } from 'node:https'
import { getAccount, getCredentials } from './store'
import type { Account, AccountInput, BucketInfo, ListResult, ObjectDetails, S3Entry } from '@shared/types'
import { basename } from '@shared/format'

const clients = new Map<string, S3Client>()

export function invalidateClient(accountId?: string): void {
  if (accountId) {
    clients.get(accountId)?.destroy()
    clients.delete(accountId)
    return
  }
  for (const c of clients.values()) c.destroy()
  clients.clear()
}

function buildClient(
  account: Pick<Account, 'region' | 'endpoint' | 'forcePathStyle' | 'allowInsecureTls'>,
  creds: { accessKeyId: string; secretAccessKey: string }
): S3Client {
  return new S3Client({
    region: account.region || 'us-east-1',
    endpoint: account.endpoint || undefined,
    forcePathStyle: account.forcePathStyle,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey
    },
    requestHandler: account.allowInsecureTls
      ? new NodeHttpHandler({ httpsAgent: new Agent({ rejectUnauthorized: false }) })
      : undefined
  })
}

export function getClient(accountId: string): S3Client {
  const cached = clients.get(accountId)
  if (cached) return cached

  const account = getAccount(accountId)
  if (!account) throw new Error(`Unknown connection: ${accountId}`)
  const creds = getCredentials(accountId)
  if (!creds?.accessKeyId || !creds.secretAccessKey) {
    throw new Error('No credentials stored for this connection. Please edit and re-enter the secret key.')
  }

  const client = buildClient(account, creds)
  clients.set(accountId, client)
  return client
}

export function describeAccount(accountId: string): Account {
  const account = getAccount(accountId)
  if (!account) throw new Error(`Unknown connection: ${accountId}`)
  return account
}

export async function listBuckets(accountId: string): Promise<BucketInfo[]> {
  const res = await getClient(accountId).send(new ListBucketsCommand({}))
  return (res.Buckets ?? []).map((b) => ({
    name: b.Name ?? '',
    creationDate: b.CreationDate?.toISOString()
  }))
}

export async function getBucketRegion(accountId: string, bucket: string): Promise<string> {
  const res = await getClient(accountId).send(new GetBucketLocationCommand({ Bucket: bucket }))
  return res.LocationConstraint || 'us-east-1'
}

export async function listObjects(
  accountId: string,
  bucket: string,
  prefix: string,
  token?: string
): Promise<ListResult> {
  const res = await getClient(accountId).send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      Delimiter: '/',
      MaxKeys: 1000,
      ContinuationToken: token
    })
  )

  const folders: S3Entry[] = (res.CommonPrefixes ?? [])
    .map((p: CommonPrefix) => p.Prefix)
    .filter((p): p is string => !!p)
    .map((p) => ({ type: 'folder' as const, key: p, name: basename(p), size: 0 }))

  const files: S3Entry[] = (res.Contents ?? [])
    .filter((o: _Object) => !!o.Key && o.Key !== prefix)
    .map((o: _Object) => ({
      type: 'file' as const,
      key: o.Key as string,
      name: basename(o.Key as string),
      size: o.Size ?? 0,
      lastModified: o.LastModified?.toISOString(),
      storageClass: o.StorageClass,
      etag: o.ETag?.replace(/"/g, '')
    }))
    // an explicit "folder marker" object (key ending in /) is not a real file
    .filter((f) => f.name !== '')

  return {
    entries: [...folders, ...files],
    nextToken: res.NextContinuationToken,
    truncated: !!res.IsTruncated
  }
}

/** Recursively collect every object key under a prefix. */
export async function listAllKeys(
  accountId: string,
  bucket: string,
  prefix: string
): Promise<{ key: string; size: number }[]> {
  const client = getClient(accountId)
  const out: { key: string; size: number }[] = []
  let token: string | undefined
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: token
      })
    )
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 })
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return out
}

export async function headObject(
  accountId: string,
  bucket: string,
  key: string
): Promise<ObjectDetails> {
  const res = await getClient(accountId).send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  return {
    key,
    size: res.ContentLength ?? 0,
    lastModified: res.LastModified?.toISOString(),
    contentType: res.ContentType,
    etag: res.ETag?.replace(/"/g, ''),
    storageClass: res.StorageClass ?? 'STANDARD',
    versionId: res.VersionId,
    metadata: res.Metadata ?? {}
  }
}

export async function createFolder(
  accountId: string,
  bucket: string,
  prefix: string,
  name: string
): Promise<void> {
  const clean = name.replace(/^\/+|\/+$/g, '')
  if (!clean) throw new Error('Folder name must not be empty')
  const key = `${prefix}${clean}/`
  await getClient(accountId).send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: new Uint8Array(0) })
  )
}

export async function deleteEntries(
  accountId: string,
  bucket: string,
  entries: { key: string; type: 'file' | 'folder' }[]
): Promise<number> {
  const client = getClient(accountId)
  const keys: string[] = []
  for (const e of entries) {
    if (e.type === 'folder') {
      const all = await listAllKeys(accountId, bucket, e.key)
      keys.push(...all.map((a) => a.key))
      keys.push(e.key)
    } else {
      keys.push(e.key)
    }
  }
  const unique = [...new Set(keys)]
  for (let i = 0; i < unique.length; i += 1000) {
    const chunk = unique.slice(i, i + 1000)
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true }
      })
    )
  }
  return unique.length
}

export async function copyKey(
  accountId: string,
  bucket: string,
  sourceKey: string,
  targetKey: string
): Promise<void> {
  await getClient(accountId).send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${sourceKey}`.split('/').map(encodeURIComponent).join('/'),
      Key: targetKey
    })
  )
}

export async function renameEntry(
  accountId: string,
  bucket: string,
  entry: { key: string; type: 'file' | 'folder' },
  newName: string
): Promise<void> {
  const clean = newName.replace(/\//g, '').trim()
  if (!clean) throw new Error('Name must not be empty')

  if (entry.type === 'file') {
    const parent = entry.key.slice(0, entry.key.lastIndexOf('/') + 1)
    const target = `${parent}${clean}`
    if (target === entry.key) return
    await copyKey(accountId, bucket, entry.key, target)
    await deleteEntries(accountId, bucket, [{ key: entry.key, type: 'file' }])
    return
  }

  const trimmed = entry.key.replace(/\/$/, '')
  const parent = trimmed.slice(0, trimmed.lastIndexOf('/') + 1)
  const targetPrefix = `${parent}${clean}/`
  if (targetPrefix === entry.key) return

  const all = await listAllKeys(accountId, bucket, entry.key)
  for (const item of all) {
    const rest = item.key.slice(entry.key.length)
    await copyKey(accountId, bucket, item.key, `${targetPrefix}${rest}`)
  }
  await deleteEntries(accountId, bucket, [{ key: entry.key, type: 'folder' }])
}

export async function createBucket(accountId: string, name: string): Promise<void> {
  const account = describeAccount(accountId)
  const region = account.region || 'us-east-1'
  await getClient(accountId).send(
    new CreateBucketCommand({
      Bucket: name,
      ...(account.provider === 'aws' && region !== 'us-east-1'
        ? { CreateBucketConfiguration: { LocationConstraint: region as never } }
        : {})
    })
  )
}

export async function deleteBucket(accountId: string, name: string): Promise<void> {
  await getClient(accountId).send(new DeleteBucketCommand({ Bucket: name }))
}

export async function presignUrl(
  accountId: string,
  bucket: string,
  key: string,
  expiresIn: number
): Promise<string> {
  return getSignedUrl(getClient(accountId), new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn
  })
}

export async function testConnection(accountId: string): Promise<string> {
  const buckets = await listBuckets(accountId)
  return `Connected. ${buckets.length} bucket${buckets.length === 1 ? '' : 's'} visible.`
}

/** Test unsaved dialog input with a transient client — nothing is persisted. */
export async function testConnectionInput(input: AccountInput): Promise<string> {
  let secret = input.secretAccessKey?.trim()
  if (!secret && input.id) secret = getCredentials(input.id)?.secretAccessKey
  if (!secret) throw new Error('Enter the secret access key to test this connection.')

  const endpoint = input.provider === 'aws' ? '' : input.endpoint.trim()
  const client = buildClient(
    {
      region: input.region.trim(),
      endpoint,
      forcePathStyle: !!input.forcePathStyle,
      allowInsecureTls: !!input.allowInsecureTls
    },
    { accessKeyId: input.accessKeyId.trim(), secretAccessKey: secret }
  )
  try {
    const res = await client.send(new ListBucketsCommand({}))
    const n = (res.Buckets ?? []).length
    return `Connected. ${n} bucket${n === 1 ? '' : 's'} visible.`
  } catch (err) {
    if (err instanceof Error && err.name === 'SignatureDoesNotMatch') {
      throw new Error(signatureHelp(err.message, endpoint))
    }
    throw err
  } finally {
    client.destroy()
  }
}

/** Signature errors are almost always keys or a misbehaving reverse proxy — say so. */
function signatureHelp(message: string, endpoint: string): string {
  const hints = ['• Re-check the access key ID and the secret access key.']
  let pathname = ''
  try {
    pathname = endpoint ? new URL(endpoint).pathname.replace(/\/+$/, '') : ''
  } catch {
    /* leave pathname empty */
  }
  if (pathname) {
    hints.push(
      `• The endpoint contains a path ("${pathname}"). If a reverse proxy strips this prefix before the request reaches the server, signing always fails — the S3 API usually needs its own hostname or port instead of a sub-path.`
    )
  }
  hints.push(
    '• If a reverse proxy sits in front of the server, it must forward the Host header unchanged (nginx: "proxy_set_header Host $http_host;") and must not rewrite the request path.'
  )
  return `${message}\n${hints.join('\n')}`
}
