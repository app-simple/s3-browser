export type ProviderId =
  | 'aws'
  | 'minio'
  | 'hetzner'
  | 'backblaze'
  | 'wasabi'
  | 'digitalocean'
  | 'cloudflare'
  | 'scaleway'
  | 'stackit'
  | 'ionos'
  | 'storj'
  | 'custom'

export interface ProviderPreset {
  id: ProviderId
  label: string
  /** may contain {region}; empty string means "AWS default endpoint" */
  endpointTemplate: string
  regions: string[]
  defaultRegion: string
  forcePathStyle: boolean
  /** provider needs a free-form endpoint (e.g. account id in host) */
  customEndpoint?: boolean
  hint?: string
}

export interface Account {
  id: string
  name: string
  provider: ProviderId
  /** full endpoint URL, '' = AWS default */
  endpoint: string
  region: string
  accessKeyId: string
  forcePathStyle: boolean
  /** skip TLS verification – only for local MinIO with self-signed certs */
  allowInsecureTls?: boolean
  createdAt: number
}

export interface AccountInput extends Omit<Account, 'id' | 'createdAt'> {
  id?: string
  secretAccessKey?: string
}

export interface BucketInfo {
  name: string
  creationDate?: string
}

export interface S3Entry {
  type: 'folder' | 'file'
  /** full key for files, full prefix (ending in /) for folders */
  key: string
  /** display name relative to current prefix */
  name: string
  size: number
  lastModified?: string
  storageClass?: string
  etag?: string
}

export interface ListResult {
  entries: S3Entry[]
  nextToken?: string
  truncated: boolean
}

export interface ObjectDetails {
  key: string
  size: number
  lastModified?: string
  contentType?: string
  etag?: string
  storageClass?: string
  versionId?: string
  metadata: Record<string, string>
}

export type TransferKind = 'upload' | 'download' | 'copy'
export type TransferStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface Transfer {
  id: string
  kind: TransferKind
  name: string
  accountId: string
  bucket: string
  key: string
  localPath: string
  loaded: number
  total: number
  status: TransferStatus
  error?: string
  startedAt: number
  finishedAt?: number
  /** destination of an s3-to-s3 copy */
  targetAccountId?: string
  targetBucket?: string
  targetKey?: string
  /** aggregate transfers (bucket sync): object currently being transferred */
  detail?: string
  itemsDone?: number
  itemsTotal?: number
  itemsSkipped?: number
}

export interface Result<T> {
  ok: boolean
  data?: T
  error?: string
}

/** Running or final totals of a folder count, as reported to the renderer. */
export interface PrefixStats {
  /** chosen by the renderer, so it can drop events from a folder it has left */
  scanId: string
  objects: number
  bytes: number
  done: boolean
  error?: string
}
