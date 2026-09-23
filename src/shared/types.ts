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

export type JobKind = 'upload' | 'download' | 'copy' | 'sync'
export type ItemStatus = 'queued' | 'running' | 'done' | 'skipped' | 'error' | 'cancelled'
export type ConflictMode = 'skip' | 'overwrite'

/** Where a job writes; the renderer uses it to refresh the open folder when the job ends. */
export type JobTarget =
  | { type: 's3'; accountId: string; bucket: string; prefix: string }
  | { type: 'local'; dir: string }

export interface TransferItemView {
  index: number
  name: string
  size: number
  loaded: number
  status: ItemStatus
  error?: string
}

/** A job as the transfer panel sees it: totals plus the few items worth listing. */
export interface TransferJobView {
  id: string
  kind: JobKind
  title: string
  target: JobTarget
  createdAt: number
  paused: boolean
  finished: boolean
  /** set when the job as a whole gave up, e.g. its connection was deleted */
  error?: string
  items: {
    /** null while a bucket sync is still being counted */
    total: number | null
    /** null while a bucket sync is still listing */
    waiting: number | null
    running: number
    done: number
    skipped: number
    failed: number
    cancelled: number
  }
  bytes: { total: number | null; done: number }
  running: TransferItemView[]
  failed: TransferItemView[]
  upcoming: TransferItemView[]
}

export interface QueueSnapshot {
  paused: boolean
  jobs: TransferJobView[]
  /** unfinished jobs from the previous session, waiting for Resume or Discard */
  restore: { jobs: number; items: number } | null
}

export interface EntryRef {
  key: string
  type: 'file' | 'folder'
  size?: number
}

export interface S3Location {
  accountId: string
  bucket: string
  prefix: string
}

/** What the renderer asks the queue to transfer. */
export type JobRequest =
  | { kind: 'upload'; accountId: string; bucket: string; prefix: string; paths: string[] }
  | { kind: 'download'; accountId: string; bucket: string; entries: EntryRef[]; destDir: string }
  | { kind: 'copy'; accountId: string; bucket: string; entries: EntryRef[]; target: S3Location }
  | { kind: 'sync'; accountId: string; bucket: string; prefix: string; target: S3Location }

export interface PlanSummary {
  planId: string
  /** null for a bucket sync, whose items are listed while it runs */
  total: number | null
  conflicts: number
  sample: string[]
}

export interface JobDoneEvent {
  jobId: string
  kind: JobKind
  target: JobTarget
}
