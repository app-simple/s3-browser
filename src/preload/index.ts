import { contextBridge, ipcRenderer } from 'electron'
import type {
  Account,
  AccountInput,
  BucketInfo,
  ListResult,
  ObjectDetails,
  Result,
  S3Entry,
  Transfer
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
    test: (id: string) => call<string>('accounts:test', id),
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
      call<string>('s3:presign', accountId, bucket, key, expiresIn)
  },
  transfers: {
    upload: (accountId: string, bucket: string, prefix: string, paths: string[]) =>
      call<number>('transfer:upload', accountId, bucket, prefix, paths),
    download: (accountId: string, bucket: string, entries: EntryRef[], destDir: string) =>
      call<number>('transfer:download', accountId, bucket, entries, destDir),
    copy: (
      sourceAccountId: string,
      sourceBucket: string,
      entries: (EntryRef & { size?: number })[],
      targetAccountId: string,
      targetBucket: string,
      targetPrefix: string
    ) =>
      call<number>(
        'transfer:copy',
        sourceAccountId,
        sourceBucket,
        entries,
        targetAccountId,
        targetBucket,
        targetPrefix
      ),
    syncBucket: (
      sourceAccountId: string,
      sourceBucket: string,
      sourcePrefix: string,
      targetAccountId: string,
      targetBucket: string,
      targetPrefix: string,
      skipExisting: boolean
    ) =>
      call<number>(
        'transfer:syncBucket',
        sourceAccountId,
        sourceBucket,
        sourcePrefix,
        targetAccountId,
        targetBucket,
        targetPrefix,
        skipExisting
      ),
    list: () => call<Transfer[]>('transfer:list'),
    cancel: (id: string) => call<void>('transfer:cancel', id),
    clearFinished: () => call<void>('transfer:clear'),
    onUpdate: (cb: (t: Transfer) => void): (() => void) => {
      const listener = (_e: unknown, t: Transfer): void => cb(t)
      ipcRenderer.on('transfer:update', listener)
      return () => {
        ipcRenderer.removeListener('transfer:update', listener)
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
    openPath: (path: string) => call<string>('shell:openPath', path),
    showItem: (path: string) => call<void>('shell:showItem', path),
    openExternal: (url: string) => call<void>('shell:openExternal', url),
    copyToClipboard: (text: string) => call<void>('clipboard:write', text),
    platform: process.platform
  }
}

export type Api = typeof api
export type { S3Entry }

contextBridge.exposeInMainWorld('api', api)
