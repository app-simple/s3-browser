import { ipcMain, dialog, shell, clipboard, BrowserWindow } from 'electron'
import * as store from './store'
import * as s3 from './s3'
import * as transfers from './transfers'
import type { AccountInput, Result } from '@shared/types'

type Handler<A extends unknown[], R> = (...args: A) => Promise<R> | R

function wrap<A extends unknown[], R>(channel: string, fn: Handler<A, R>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<Result<R>> => {
    try {
      const data = await fn(...(args as A))
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })
}

export function registerIpc(): void {
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
  wrap('accounts:test', (id: string) => s3.testConnection(id))
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
  wrap('s3:presign', (accountId: string, bucket: string, key: string, expiresIn: number) =>
    s3.presignUrl(accountId, bucket, key, expiresIn)
  )

  // ---- transfers ------------------------------------------------------
  wrap('transfer:upload', (accountId: string, bucket: string, prefix: string, paths: string[]) =>
    transfers.uploadPaths(accountId, bucket, prefix, paths)
  )
  wrap('transfer:download', (
    accountId: string,
    bucket: string,
    entries: { key: string; type: 'file' | 'folder' }[],
    destDir: string
  ) => transfers.downloadEntries(accountId, bucket, entries, destDir))
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

  wrap('shell:openPath', (path: string) => shell.openPath(path))
  wrap('shell:showItem', (path: string) => shell.showItemInFolder(path))
  wrap('shell:openExternal', (url: string) => shell.openExternal(url))
  wrap('clipboard:write', (text: string) => clipboard.writeText(text))
}
