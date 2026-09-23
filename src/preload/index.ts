import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Account,
  AccountInput,
  BucketInfo,
  ListResult,
  ObjectDetails,
  PrefixStats,
  Result,
  S3Entry,
  ConflictMode,
  JobDoneEvent,
  JobRequest,
  PlanSummary,
  QueueSnapshot
} from '@shared/types'

type EntryRef = { key: string; type: 'file' | 'folder' }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  if (!res.ok) throw new Error(res.error ?? 'Unknown error')
  return res.data as T
}

const api = {
  accounts: {
    list: () => call<Account[]>('accounts:list'),
    save: (input: AccountInput) => call<Account>('accounts:save', input),
    remove: (id: string) => call<void>('accounts:delete', id),
    test: (input: AccountInput) => call<string>('accounts:test', input),
    encryptionAvailable: () => call<boolean>('accounts:encryptionAvailable')
  },
  s3: {
    listBuckets: (accountId: string) => call<BucketInfo[]>('s3:listBuckets', accountId),
    createBucket: (accountId: string, name: string) =>
      call<void>('s3:createBucket', accountId, name),
    deleteBucket: (accountId: string, name: string) =>
      call<void>('s3:deleteBucket', accountId, name),
    listObjects: (accountId: string, bucket: string, prefix: string, token?: string) =>
      call<ListResult>('s3:listObjects', accountId, bucket, prefix, token),
    head: (accountId: string, bucket: string, key: string) =>
      call<ObjectDetails>('s3:head', accountId, bucket, key),
    createFolder: (accountId: string, bucket: string, prefix: string, name: string) =>
      call<void>('s3:createFolder', accountId, bucket, prefix, name),
    remove: (accountId: string, bucket: string, entries: EntryRef[]) =>
      call<number>('s3:delete', accountId, bucket, entries),
    rename: (accountId: string, bucket: string, entry: EntryRef, newName: string) =>
      call<void>('s3:rename', accountId, bucket, entry, newName),
    presign: (accountId: string, bucket: string, key: string, expiresIn: number) =>
      call<string>('s3:presign', accountId, bucket, key, expiresIn),
    /** count everything under a prefix; results arrive through onPrefixStats */
    scanPrefix: (scanId: string, accountId: string, bucket: string, prefix: string) =>
      call<void>('s3:scanPrefix', scanId, accountId, bucket, prefix),
    stopScan: () => call<void>('s3:stopScan'),
    onPrefixStats: (cb: (s: PrefixStats) => void): (() => void) => {
      const listener = (_e: unknown, s: PrefixStats): void => cb(s)
      ipcRenderer.on('prefix:stats', listener)
      return () => {
        ipcRenderer.removeListener('prefix:stats', listener)
      }
    }
  },
  queue: {
    /** expand a transfer and check its targets; nothing runs until enqueue */
    plan: (req: JobRequest) => call<PlanSummary>('queue:plan', req),
    enqueue: (planId: string, mode: ConflictMode) => call<string>('queue:enqueue', planId, mode),
    list: () => call<QueueSnapshot>('queue:list'),
    pauseAll: () => call<void>('queue:pauseAll'),
    resumeAll: () => call<void>('queue:resumeAll'),
    pauseJob: (id: string) => call<void>('queue:pauseJob', id),
    resumeJob: (id: string) => call<void>('queue:resumeJob', id),
    cancelJob: (id: string) => call<void>('queue:cancelJob', id),
    cancelItem: (id: string, index: number) => call<void>('queue:cancelItem', id, index),
    clearFinished: () => call<void>('queue:clearFinished'),
    restore: (decision: 'resume' | 'discard') => call<void>('queue:restore', decision),
    revealJob: (id: string) => call<void>('queue:revealJob', id),
    onUpdate: (cb: (s: QueueSnapshot) => void): (() => void) => {
      const listener = (_e: unknown, s: QueueSnapshot): void => cb(s)
      ipcRenderer.on('queue:update', listener)
      return () => {
        ipcRenderer.removeListener('queue:update', listener)
      }
    },
    onJobDone: (cb: (e: JobDoneEvent) => void): (() => void) => {
      const listener = (_e: unknown, e: JobDoneEvent): void => cb(e)
      ipcRenderer.on('queue:jobDone', listener)
      return () => {
        ipcRenderer.removeListener('queue:jobDone', listener)
      }
    }
  },
  dialog: {
    pickFiles: () => call<string[]>('dialog:pickFiles'),
    pickFolders: () => call<string[]>('dialog:pickFolders'),
    pickDestination: () => call<string | null>('dialog:pickDestination'),
    confirm: (message: string, detail: string, confirmLabel = 'Delete') =>
      call<boolean>('dialog:confirm', message, detail, confirmLabel)
  },
  system: {
    copyToClipboard: (text: string) => call<void>('clipboard:write', text),
    /** absolute path of a dropped File (File.path no longer exists in Electron ≥ 32) */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    platform: process.platform
  }
}

export type Api = typeof api
export type { S3Entry }

contextBridge.exposeInMainWorld('api', api)
