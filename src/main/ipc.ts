import {
  ipcMain,
  dialog,
  shell,
  clipboard,
  BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { isAbsolute } from 'node:path'
import * as store from './store'
import * as s3 from './s3'
import * as transfers from './transfers'
import { createPrefixScanner } from './prefixScan'
import { isAppUrl } from './origin'
import type { AccountInput, Result } from '@shared/types'

type Handler<A extends unknown[], R> = (...args: A) => Promise<R> | R

/**
 * Only the main frame of one of our own windows may invoke handlers. Any iframe,
 * webview or foreign page that ends up with an ipcRenderer is rejected outright.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!BrowserWindow.fromWebContents(event.sender)) return false
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  return isAppUrl(frame.url)
}

function wrap<A extends unknown[], R>(channel: string, fn: Handler<A, R>): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<R>> => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'IPC call rejected: untrusted sender' }
    }
    try {
      const data = await fn(...(args as A))
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })
}

function assertAbsolutePath(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !isAbsolute(value)) {
    throw new Error(`Invalid ${what}`)
  }
}

/** S3 caps presigned URLs at 7 days; anything outside that range is a renderer bug. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60

export function registerIpc(): void {
  const scanner = createPrefixScanner({
    getClient: (accountId) => s3.getClient(accountId),
    emit: (stats) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('prefix:stats', stats)
      }
    }
  })

  // ---- accounts -------------------------------------------------------
  wrap('accounts:list', () => store.listAccounts())
  wrap('accounts:save', (input: AccountInput) => {
    const account = store.saveAccount(input)
    s3.invalidateClient(account.id)
    return account
  })
  wrap('accounts:delete', (id: string) => {
    s3.invalidateClient(id)
    store.deleteAccount(id)
  })
  wrap('accounts:test', (input: AccountInput) => s3.testConnectionInput(input))
  wrap('accounts:encryptionAvailable', () => store.encryptionAvailable())

  // ---- buckets & objects ---------------------------------------------
  wrap('s3:listBuckets', (accountId: string) => s3.listBuckets(accountId))
  wrap('s3:createBucket', (accountId: string, name: string) => s3.createBucket(accountId, name))
  wrap('s3:deleteBucket', (accountId: string, name: string) => s3.deleteBucket(accountId, name))
  wrap('s3:listObjects', (accountId: string, bucket: string, prefix: string, token?: string) =>
    s3.listObjects(accountId, bucket, prefix, token)
  )
  wrap('s3:head', (accountId: string, bucket: string, key: string) =>
    s3.headObject(accountId, bucket, key)
  )
  wrap('s3:createFolder', (accountId: string, bucket: string, prefix: string, name: string) =>
    s3.createFolder(accountId, bucket, prefix, name)
  )
  wrap('s3:delete', (
    accountId: string,
    bucket: string,
    entries: { key: string; type: 'file' | 'folder' }[]
  ) => s3.deleteEntries(accountId, bucket, entries))
  wrap('s3:rename', (
    accountId: string,
    bucket: string,
    entry: { key: string; type: 'file' | 'folder' },
    newName: string
  ) => s3.renameEntry(accountId, bucket, entry, newName))
  wrap('s3:scanPrefix', (scanId: unknown, accountId: string, bucket: string, prefix: unknown) => {
    if (typeof scanId !== 'string' || !scanId || scanId.length > 64) {
      throw new Error('Invalid scan id')
    }
    if (typeof prefix !== 'string') throw new Error('Invalid prefix')
    scanner.start(scanId, accountId, bucket, prefix)
  })
  wrap('s3:stopScan', () => scanner.stop())
  wrap('s3:presign', (accountId: string, bucket: string, key: string, expiresIn: number) => {
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_PRESIGN_SECONDS) {
      throw new Error('Link expiry must be between 1 second and 7 days')
    }
    return s3.presignUrl(accountId, bucket, key, expiresIn)
  })

  // ---- transfers ------------------------------------------------------
  wrap('transfer:upload', (accountId: string, bucket: string, prefix: string, paths: unknown) => {
    if (!Array.isArray(paths)) throw new Error('Invalid upload paths')
    for (const p of paths) assertAbsolutePath(p, 'upload path')
    return transfers.uploadPaths(accountId, bucket, prefix, paths as string[])
  })
  wrap('transfer:download', (
    accountId: string,
    bucket: string,
    entries: { key: string; type: 'file' | 'folder' }[],
    destDir: unknown
  ) => {
    assertAbsolutePath(destDir, 'download folder')
    return transfers.downloadEntries(accountId, bucket, entries, destDir)
  })
  wrap('transfer:planCopy', (
    sourceAccountId: string,
    sourceBucket: string,
    entries: { key: string; type: 'file' | 'folder'; size?: number }[],
    targetAccountId: string,
    targetBucket: string,
    targetPrefix: string
  ) =>
    transfers.planCopy(
      sourceAccountId,
      sourceBucket,
      entries,
      targetAccountId,
      targetBucket,
      targetPrefix
    ))
  wrap('transfer:copy', (
    sourceAccountId: string,
    sourceBucket: string,
    entries: { key: string; type: 'file' | 'folder'; size?: number }[],
    targetAccountId: string,
    targetBucket: string,
    targetPrefix: string,
    skipExisting?: boolean
  ) =>
    transfers.copyEntries(
      sourceAccountId,
      sourceBucket,
      entries,
      targetAccountId,
      targetBucket,
      targetPrefix,
      skipExisting
    ))
  wrap('transfer:syncBucket', (
    sourceAccountId: string,
    sourceBucket: string,
    sourcePrefix: string,
    targetAccountId: string,
    targetBucket: string,
    targetPrefix: string,
    skipExisting: boolean
  ) =>
    transfers.syncBucket(
      sourceAccountId,
      sourceBucket,
      sourcePrefix,
      targetAccountId,
      targetBucket,
      targetPrefix,
      skipExisting
    ))
  wrap('transfer:list', () => transfers.listTransfers())
  wrap('transfer:cancel', (id: string) => transfers.cancelTransfer(id))
  wrap('transfer:clear', () => transfers.clearFinishedTransfers())

  // ---- shell / dialogs ------------------------------------------------
  wrap('dialog:pickFiles', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })
  wrap('dialog:pickFolders', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })
  wrap('dialog:pickDestination', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  wrap('dialog:confirm', async (message: string, detail: string, confirmLabel: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [confirmLabel, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message,
      detail
    })
    return res.response === 0
  })

  // the renderer may only reveal files this app downloaded itself — never an arbitrary path
  wrap('shell:showItem', (path: unknown) => {
    assertAbsolutePath(path, 'path')
    if (!transfers.isDownloadedPath(path)) throw new Error('Not a file downloaded by this app')
    shell.showItemInFolder(path)
  })
  wrap('clipboard:write', (text: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid clipboard text')
    clipboard.writeText(text)
  })
}
