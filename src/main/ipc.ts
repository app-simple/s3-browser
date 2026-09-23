import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  app,
  ipcMain,
  dialog,
  shell,
  clipboard,
  BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import * as store from './store'
import * as s3 from './s3'
import { createPrefixScanner } from './prefixScan'
import { createJobFactory } from './jobFactory'
import { parseJobRequest } from './jobRequest'
import { createQueueService } from './queueService'
import { createQueueStore } from './queueStore'
import { isAppUrl } from './origin'
import type { AccountInput, ConflictMode, Result } from '@shared/types'

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

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Job and plan ids are UUIDs; they also name files under userData/queue. */
function jobId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value)) throw new Error('Invalid job id')
  return value
}

function conflictMode(value: unknown): ConflictMode {
  if (value !== 'skip' && value !== 'overwrite') throw new Error('Invalid conflict choice')
  return value
}

/** S3 caps presigned URLs at 7 days; anything outside that range is a renderer bug. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60

export function registerIpc(): void {
  const scanner = createPrefixScanner({
    getClient: (accountId) => s3.getClient(accountId),
    emit: (stats) => broadcast('prefix:stats', stats)
  })
  const queue = createQueueService({
    factory: createJobFactory({
      getClient: (accountId) => s3.getClient(accountId),
      accountExists: (accountId) => store.getAccount(accountId) !== undefined,
      listKeys: (accountId, bucket, prefix) => s3.listAllKeys(accountId, bucket, prefix)
    }),
    store: createQueueStore(join(app.getPath('userData'), 'queue')),
    emit: (snapshot) => broadcast('queue:update', snapshot),
    onJobDone: (event) => broadcast('queue:jobDone', event),
    newId: () => randomUUID(),
    now: () => Date.now()
  })
  // unfinished jobs from the previous session are offered, never started unasked
  queue.init()

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

  // ---- transfer queue -------------------------------------------------
  wrap('queue:plan', (req: unknown) => queue.plan(parseJobRequest(req)))
  wrap('queue:enqueue', (planId: unknown, mode: unknown) =>
    queue.enqueue(jobId(planId), conflictMode(mode))
  )
  wrap('queue:list', () => queue.snapshot())
  wrap('queue:pauseAll', () => queue.pauseAll())
  wrap('queue:resumeAll', () => queue.resumeAll())
  wrap('queue:pauseJob', (id: unknown) => queue.pauseJob(jobId(id)))
  wrap('queue:resumeJob', (id: unknown) => queue.resumeJob(jobId(id)))
  wrap('queue:cancelJob', (id: unknown) => queue.cancelJob(jobId(id)))
  wrap('queue:cancelItem', (id: unknown, index: unknown) => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new Error('Invalid item')
    queue.cancelItem(jobId(id), index)
  })
  wrap('queue:clearFinished', () => queue.clearFinished())
  wrap('queue:restore', (decision: unknown) => {
    if (decision !== 'resume' && decision !== 'discard') throw new Error('Invalid choice')
    return queue.restore(decision)
  })
  // the folder comes from the job, and is only shown in the file manager — never opened, so
  // a download "folder" that is really an app or script cannot be launched from here
  wrap('queue:revealJob', (id: unknown) => {
    const dir = queue.revealDir(jobId(id))
    if (!dir) throw new Error('This job has no local folder')
    shell.showItemInFolder(dir)
  })

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

  wrap('clipboard:write', (text: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid clipboard text')
    clipboard.writeText(text)
  })
}
