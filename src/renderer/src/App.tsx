import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Account,
  BucketInfo,
  ConflictMode,
  JobRequest,
  PlanSummary,
  PrefixStats,
  QueueSnapshot,
  S3Entry
} from '@shared/types'
import { formatBytes } from '@shared/format'
import Sidebar from './components/Sidebar'
import AccountDialog from './components/AccountDialog'
import ObjectTable from './components/ObjectTable'
import TransferPanel from './components/TransferPanel'
import PromptDialog from './components/PromptDialog'
import DetailsDialog from './components/DetailsDialog'
import CopyDialog from './components/CopyDialog'
import ConflictDialog from './components/ConflictDialog'
import {
  CopyIcon,
  DownloadIcon,
  NewFolderIcon,
  PencilIcon,
  RefreshIcon,
  TrashIcon,
  UploadIcon,
  InfoIcon,
  XIcon
} from './components/Icons'

type PromptKind =
  | { kind: 'newFolder' }
  | { kind: 'newBucket'; accountId: string }
  | { kind: 'rename'; entry: S3Entry }
  | null

let scanCounter = 0

export default function App() {
  const isMac = window.api.system.platform === 'darwin'

  const [accounts, setAccounts] = useState<Account[]>([])
  const [buckets, setBuckets] = useState<Record<string, BucketInfo[]>>({})
  const [loadingAccountId, setLoadingAccountId] = useState<string | null>(null)

  const [accountId, setAccountId] = useState<string | null>(null)
  const [bucket, setBucket] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')

  const [entries, setEntries] = useState<S3Entry[]>([])
  const [nextToken, setNextToken] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [queue, setQueue] = useState<QueueSnapshot>({ paused: false, jobs: [], restore: null })
  const [editing, setEditing] = useState<Account | null>(null)
  const [showAccountDialog, setShowAccountDialog] = useState(false)
  const [prompt, setPrompt] = useState<PromptKind>(null)
  const [detailsEntry, setDetailsEntry] = useState<S3Entry | null>(null)
  const [showCopyDialog, setShowCopyDialog] = useState(false)
  const [copyBucket, setCopyBucket] = useState<{ accountId: string; bucket: string } | null>(null)
  const [conflictPrompt, setConflictPrompt] = useState<(PlanSummary & { targetLabel: string }) | null>(null)
  const [dragging, setDragging] = useState(false)

  const dragCounter = useRef(0)
  // totals for everything under the open folder, counted in the background
  const [folderStats, setFolderStats] = useState<PrefixStats | null>(null)
  const scanId = useRef<string | null>(null)

  // ---------- bootstrap ----------
  useEffect(() => {
    window.api.accounts.list().then(setAccounts).catch(() => undefined)
    window.api.queue.list().then(setQueue).catch(() => undefined)
    return window.api.queue.onUpdate(setQueue)
  }, [])

  // events from a folder the user has already left are dropped here
  useEffect(
    () =>
      window.api.s3.onPrefixStats((stats) => {
        if (stats.scanId === scanId.current) setFolderStats(stats)
      }),
    []
  )

  const startFolderScan = useCallback((id: string, b: string, p: string) => {
    const next = `scan-${++scanCounter}`
    scanId.current = next
    setFolderStats({ scanId: next, objects: 0, bytes: 0, done: false })
    window.api.s3.scanPrefix(next, id, b, p).catch((e) => {
      if (scanId.current !== next) return
      const error = e instanceof Error ? e.message : String(e)
      setFolderStats({ scanId: next, objects: 0, bytes: 0, done: true, error })
    })
  }, [])

  const stopFolderScan = useCallback(() => {
    scanId.current = null
    setFolderStats(null)
    void window.api.s3.stopScan()
  }, [])

  const loadBuckets = useCallback(async (id: string) => {
    setLoadingAccountId(id)
    setError(null)
    try {
      const list = await window.api.s3.listBuckets(id)
      setBuckets((b) => ({ ...b, [id]: list }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBuckets((b) => ({ ...b, [id]: [] }))
    } finally {
      setLoadingAccountId(null)
    }
  }, [])

  const loadObjects = useCallback(
    async (id: string, b: string, p: string, token?: string) => {
      setLoading(true)
      setError(null)
      // a first page means a new folder or a refresh: recount it
      if (!token) startFolderScan(id, b, p)
      try {
        const res = await window.api.s3.listObjects(id, b, p, token)
        setEntries((prev) => (token ? [...prev, ...res.entries] : res.entries))
        setNextToken(res.truncated ? res.nextToken : undefined)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        if (!token) setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [startFolderScan]
  )

  function selectAccount(id: string): void {
    stopFolderScan()
    setAccountId(id)
    setBucket(null)
    setPrefix('')
    setEntries([])
    setSelected(new Set())
    if (!buckets[id]) void loadBuckets(id)
  }

  function selectBucket(id: string, name: string): void {
    setAccountId(id)
    setBucket(name)
    setPrefix('')
    setFilter('')
    setSelected(new Set())
    void loadObjects(id, name, '')
  }

  function navigate(p: string): void {
    if (!accountId || !bucket) return
    setPrefix(p)
    setFilter('')
    setSelected(new Set())
    void loadObjects(accountId, bucket, p)
  }

  const refresh = useCallback(() => {
    if (accountId && bucket) void loadObjects(accountId, bucket, prefix)
    else if (accountId) void loadBuckets(accountId)
  }, [accountId, bucket, prefix, loadObjects, loadBuckets])

  // a job that wrote into the open bucket shows up without a manual refresh
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const openBucket = useRef({ accountId, bucket })
  openBucket.current = { accountId, bucket }
  useEffect(
    () =>
      window.api.queue.onJobDone(({ target }) => {
        const open = openBucket.current
        if (target.type === 's3' && target.accountId === open.accountId && target.bucket === open.bucket) {
          refreshRef.current()
        }
      }),
    []
  )

  // ---------- selection ----------
  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.key)),
    [entries, selected]
  )

  function toggle(key: string): void {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll(keys: string[]): void {
    setSelected((s) => {
      const allOn = keys.length > 0 && keys.every((k) => s.has(k))
      return allOn ? new Set() : new Set(keys)
    })
  }

  // ---------- actions ----------
  /** Plan a transfer, ask once about targets that already exist, then hand it to the queue. */
  async function startJob(req: JobRequest, targetLabel: string): Promise<void> {
    try {
      const plan = await window.api.queue.plan(req)
      if (plan.conflicts > 0) {
        setConflictPrompt({ ...plan, targetLabel })
        return
      }
      await window.api.queue.enqueue(plan.planId, 'overwrite')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function resolveConflict(mode: ConflictMode): Promise<void> {
    const prompt = conflictPrompt
    setConflictPrompt(null)
    if (!prompt) return
    try {
      await window.api.queue.enqueue(prompt.planId, mode)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function uploadPaths(paths: string[]): Promise<void> {
    if (!accountId || !bucket || paths.length === 0) return
    await startJob({ kind: 'upload', accountId, bucket, prefix, paths }, `${bucket}/${prefix}`)
  }

  async function handleUploadFiles(): Promise<void> {
    await uploadPaths(await window.api.dialog.pickFiles())
  }

  async function handleUploadFolder(): Promise<void> {
    await uploadPaths(await window.api.dialog.pickFolders())
  }

  async function handleDownload(): Promise<void> {
    if (!accountId || !bucket || selectedEntries.length === 0) return
    const dest = await window.api.dialog.pickDestination()
    if (!dest) return
    await startJob(
      {
        kind: 'download',
        accountId,
        bucket,
        entries: selectedEntries.map((e) => ({ key: e.key, type: e.type, size: e.size })),
        destDir: dest
      },
      dest
    )
  }

  async function handleCopy(targetAccountId: string, targetBucket: string, targetPrefix: string): Promise<void> {
    if (!accountId || !bucket || selectedEntries.length === 0) return
    setShowCopyDialog(false)
    await startJob(
      {
        kind: 'copy',
        accountId,
        bucket,
        entries: selectedEntries.map((e) => ({ key: e.key, type: e.type, size: e.size })),
        target: { accountId: targetAccountId, bucket: targetBucket, prefix: targetPrefix }
      },
      `${targetBucket}/${targetPrefix}`
    )
  }

  async function handleSyncBucket(
    targetAccountId: string,
    targetBucket: string,
    targetPrefix: string,
    skipExisting: boolean
  ): Promise<void> {
    if (!copyBucket) return
    const src = copyBucket
    setCopyBucket(null)
    try {
      const plan = await window.api.queue.plan({
        kind: 'sync',
        accountId: src.accountId,
        bucket: src.bucket,
        prefix: '',
        target: { accountId: targetAccountId, bucket: targetBucket, prefix: targetPrefix }
      })
      // a sync decides per object while it runs; the checkbox is its conflict choice
      await window.api.queue.enqueue(plan.planId, skipExisting ? 'skip' : 'overwrite')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDelete(): Promise<void> {
    if (!accountId || !bucket || selectedEntries.length === 0) return
    const folders = selectedEntries.filter((e) => e.type === 'folder').length
    const ok = await window.api.dialog.confirm(
      `Delete ${selectedEntries.length} item${selectedEntries.length === 1 ? '' : 's'}?`,
      folders > 0
        ? 'Folders are deleted recursively, including everything inside them. This cannot be undone.'
        : 'This cannot be undone.',
      'Delete'
    )
    if (!ok) return
    try {
      await window.api.s3.remove(
        accountId,
        bucket,
        selectedEntries.map((e) => ({ key: e.key, type: e.type }))
      )
      setSelected(new Set())
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteBucketByName(accId: string, name: string): Promise<void> {
    const ok = await window.api.dialog.confirm(
      `Delete bucket "${name}"?`,
      'The bucket must already be empty. This cannot be undone.',
      'Delete bucket'
    )
    if (!ok) return
    try {
      await window.api.s3.deleteBucket(accId, name)
      if (accountId === accId && bucket === name) {
        stopFolderScan()
        setBucket(null)
        setEntries([])
      }
      await loadBuckets(accId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDeleteBucket(): Promise<void> {
    if (!accountId || !bucket) return
    await handleDeleteBucketByName(accountId, bucket)
  }

  async function handlePrompt(value: string): Promise<void> {
    if (!prompt) return
    try {
      if (prompt.kind === 'newFolder' && accountId && bucket) {
        await window.api.s3.createFolder(accountId, bucket, prefix, value)
        refresh()
      } else if (prompt.kind === 'newBucket') {
        await window.api.s3.createBucket(prompt.accountId, value)
        await loadBuckets(prompt.accountId)
      } else if (prompt.kind === 'rename' && accountId && bucket) {
        await window.api.s3.rename(
          accountId,
          bucket,
          { key: prompt.entry.key, type: prompt.entry.type },
          value
        )
        setSelected(new Set())
        refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPrompt(null)
    }
  }

  async function handleDeleteAccount(acc: Account): Promise<void> {
    const ok = await window.api.dialog.confirm(
      `Remove connection "${acc.name}"?`,
      'Stored credentials for this connection are deleted from this machine. Your data in the bucket is not touched.',
      'Remove'
    )
    if (!ok) return
    await window.api.accounts.remove(acc.id)
    setAccounts(await window.api.accounts.list())
    setBuckets((b) => {
      const next = { ...b }
      delete next[acc.id]
      return next
    })
    if (accountId === acc.id) {
      stopFolderScan()
      setAccountId(null)
      setBucket(null)
      setEntries([])
    }
    setEditing(null)
    setShowAccountDialog(false)
  }

  // ---------- drag & drop ----------
  function onDragEnter(e: React.DragEvent): void {
    e.preventDefault()
    if (!bucket) return
    dragCounter.current += 1
    setDragging(true)
  }

  function onDragLeave(e: React.DragEvent): void {
    e.preventDefault()
    dragCounter.current -= 1
    if (dragCounter.current <= 0) setDragging(false)
  }

  function onDrop(e: React.DragEvent): void {
    e.preventDefault()
    dragCounter.current = 0
    setDragging(false)
    if (!bucket) return
    const paths: string[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.api.system.pathForFile(file)
      if (p) paths.push(p)
    }
    if (paths.length > 0) void uploadPaths(paths)
    else setError('Could not read the dropped paths. Use the Upload button instead.')
  }

  // ---------- keyboard ----------
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        void handleDelete()
      }
      if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        refresh()
      }
      if (e.key === 'Escape') setSelected(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---------- breadcrumbs ----------
  const crumbs = useMemo(() => {
    const parts = prefix.split('/').filter(Boolean)
    return parts.map((part, i) => ({
      label: part,
      prefix: `${parts.slice(0, i + 1).join('/')}/`
    }))
  }, [prefix])

  const totalSize = useMemo(
    () => entries.filter((e) => e.type === 'file').reduce((sum, e) => sum + e.size, 0),
    [entries]
  )
  const folderCount = entries.filter((e) => e.type === 'folder').length
  const fileCount = entries.length - folderCount

  return (
    <div className="app">
      <Sidebar
        accounts={accounts}
        buckets={buckets}
        loadingAccountId={loadingAccountId}
        activeAccountId={accountId}
        activeBucket={bucket}
        isMac={isMac}
        onSelectAccount={selectAccount}
        onSelectBucket={selectBucket}
        onAddAccount={() => {
          setEditing(null)
          setShowAccountDialog(true)
        }}
        onEditAccount={(acc) => {
          setEditing(acc)
          setShowAccountDialog(true)
        }}
        onRefreshBuckets={(id) => void loadBuckets(id)}
        onNewBucket={(id) => setPrompt({ kind: 'newBucket', accountId: id })}
        onCopyBucket={(id, b) => setCopyBucket({ accountId: id, bucket: b })}
        onRemoveAccount={(acc) => void handleDeleteAccount(acc)}
        onDeleteBucket={(id, b) => void handleDeleteBucketByName(id, b)}
      />

      <main className="main">
        <div className="topbar">
          <div className="crumbs">
            {bucket ? (
              <>
                <span
                  className={`crumb ${prefix === '' ? 'current' : ''}`}
                  onClick={() => prefix !== '' && navigate('')}
                >
                  {bucket}
                </span>
                {crumbs.map((c, i) => (
                  <span key={c.prefix} style={{ display: 'contents' }}>
                    <span className="sep">/</span>
                    <span
                      className={`crumb ${i === crumbs.length - 1 ? 'current' : ''}`}
                      onClick={() => i !== crumbs.length - 1 && navigate(c.prefix)}
                    >
                      {c.label}
                    </span>
                  </span>
                ))}
              </>
            ) : (
              <span style={{ color: 'var(--text-faint)' }}>No bucket selected</span>
            )}
          </div>
          <span className="spacer" />
          {bucket && (
            <input
              value={filter}
              placeholder="Filter…"
              onChange={(e) => setFilter(e.target.value)}
              style={{ maxWidth: 200 }}
            />
          )}
        </div>

        {bucket && (
          <div className="toolbar">
            <button onClick={handleUploadFiles}><UploadIcon /> Upload files</button>
            <button onClick={handleUploadFolder}><UploadIcon /> Upload folder</button>
            <button onClick={() => setPrompt({ kind: 'newFolder' })}>
              <NewFolderIcon /> New folder
            </button>
            <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
            <button disabled={selectedEntries.length === 0} onClick={handleDownload}>
              <DownloadIcon /> Download
            </button>
            <button disabled={selectedEntries.length === 0} onClick={() => setShowCopyDialog(true)}>
              <CopyIcon /> Copy to…
            </button>
            <button
              disabled={selectedEntries.length !== 1}
              onClick={() => setPrompt({ kind: 'rename', entry: selectedEntries[0] })}
            >
              <PencilIcon /> Rename
            </button>
            <button
              disabled={selectedEntries.length !== 1 || selectedEntries[0].type !== 'file'}
              onClick={() => setDetailsEntry(selectedEntries[0])}
            >
              <InfoIcon /> Details
            </button>
            <button className="danger" disabled={selectedEntries.length === 0} onClick={handleDelete}>
              <TrashIcon /> Delete
            </button>
            <span className="spacer" />
            <button className="ghost" onClick={refresh} title="Refresh (Cmd/Ctrl+R)">
              {loading ? <span className="spinner" /> : <RefreshIcon />}
            </button>
            <button className="ghost danger" onClick={handleDeleteBucket} title="Delete bucket">
              <TrashIcon />
            </button>
          </div>
        )}

        {error && (
          <div className="banner error">
            <span style={{ flex: 1 }}>{error}</span>
            <button className="ghost" style={{ padding: 2 }} onClick={() => setError(null)}>
              <XIcon />
            </button>
          </div>
        )}

        <div
          className="content"
          onDragEnter={onDragEnter}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {dragging && <div className="drop-overlay">Drop to upload to {prefix || bucket}</div>}

          {!bucket ? (
            <div className="empty-state">
              <h3>{accounts.length === 0 ? 'Welcome to S3 Browser' : 'Select a bucket'}</h3>
              <p>
                {accounts.length === 0
                  ? 'Add a connection to Amazon S3, MinIO, Hetzner Object Storage, Backblaze B2, Wasabi or any other S3-compatible endpoint to get started.'
                  : 'Pick a bucket from the sidebar to browse its contents.'}
              </p>
              {accounts.length === 0 && (
                <button
                  className="primary"
                  onClick={() => {
                    setEditing(null)
                    setShowAccountDialog(true)
                  }}
                >
                  Add connection
                </button>
              )}
            </div>
          ) : entries.length === 0 && !loading ? (
            <div className="empty-state">
              <h3>This folder is empty</h3>
              <p>Drag files here or use the Upload button to add objects.</p>
            </div>
          ) : (
            <>
              <ObjectTable
                entries={entries}
                selected={selected}
                filter={filter}
                onToggle={toggle}
                onToggleAll={toggleAll}
                onOpenFolder={navigate}
                onOpenDetails={setDetailsEntry}
              />
              {nextToken && (
                <div style={{ padding: 12, textAlign: 'center' }}>
                  <button
                    disabled={loading}
                    onClick={() =>
                      accountId && bucket && loadObjects(accountId, bucket, prefix, nextToken)
                    }
                  >
                    {loading ? <span className="spinner" /> : null} Load more
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <TransferPanel
          queue={queue}
          onPauseAll={() => void window.api.queue.pauseAll()}
          onResumeAll={() => void window.api.queue.resumeAll()}
          onPauseJob={(id) => void window.api.queue.pauseJob(id)}
          onResumeJob={(id) => void window.api.queue.resumeJob(id)}
          onCancelJob={(id) => void window.api.queue.cancelJob(id)}
          onCancelItem={(id, index) => void window.api.queue.cancelItem(id, index)}
          onClear={() => void window.api.queue.clearFinished()}
          onReveal={(id) => void window.api.queue.revealJob(id)}
          onRestore={(decision) =>
            void window.api.queue
              .restore(decision)
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }
        />

        <div className="statusbar">
          {bucket ? (
            <>
              <span>
                {folderCount} folder{folderCount === 1 ? '' : 's'}, {fileCount} object
                {fileCount === 1 ? '' : 's'}
              </span>
              <span>{formatBytes(totalSize)} on this page</span>
              {selected.size > 0 && <span>{selected.size} selected</span>}
              {nextToken && <span>more available</span>}
              {folderStats && (
                <span
                  className="folder-total"
                  title={
                    folderStats.error
                      ? `Could not count this folder: ${folderStats.error}`
                      : 'Everything under this folder, subfolders included'
                  }
                >
                  {folderStats.error ? (
                    '—'
                  ) : (
                    <>
                      {!folderStats.done && <span className="spinner" />}
                      {folderStats.objects.toLocaleString()} object
                      {folderStats.objects === 1 ? '' : 's'} · {formatBytes(folderStats.bytes)}
                      {folderStats.done ? ' total' : ''}
                    </>
                  )}
                </span>
              )}
            </>
          ) : (
            <span>
              {accounts.length} connection{accounts.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </main>

      {showAccountDialog && (
        <AccountDialog
          account={editing}
          onClose={() => {
            setShowAccountDialog(false)
            setEditing(null)
          }}
          onSaved={async (acc) => {
            setAccounts(await window.api.accounts.list())
            setShowAccountDialog(false)
            setEditing(null)
            selectAccount(acc.id)
            await loadBuckets(acc.id)
          }}
        />
      )}

      {showAccountDialog && editing && (
        <div style={{ position: 'fixed', bottom: 28, left: 28, zIndex: 101 }}>
          <button className="danger" onClick={() => void handleDeleteAccount(editing)}>
            <TrashIcon /> Remove connection
          </button>
        </div>
      )}

      {prompt && (
        <PromptDialog
          title={
            prompt.kind === 'newFolder'
              ? 'New folder'
              : prompt.kind === 'newBucket'
                ? 'New bucket'
                : 'Rename'
          }
          label={
            prompt.kind === 'newBucket' ? 'Bucket name' : prompt.kind === 'rename' ? 'New name' : 'Folder name'
          }
          initialValue={prompt.kind === 'rename' ? prompt.entry.name : ''}
          confirmLabel={prompt.kind === 'rename' ? 'Rename' : 'Create'}
          hint={
            prompt.kind === 'newBucket'
              ? 'Lowercase letters, numbers, dots and hyphens. Must be globally unique on most providers.'
              : prompt.kind === 'rename'
                ? 'S3 has no native rename — the object is copied to the new key and the old one deleted.'
                : undefined
          }
          onCancel={() => setPrompt(null)}
          onConfirm={(v) => void handlePrompt(v)}
        />
      )}

      {showCopyDialog && accountId && bucket && (
        <CopyDialog
          accounts={accounts}
          sourceAccountId={accountId}
          sourceBucket={bucket}
          itemCount={selectedEntries.length}
          onCancel={() => setShowCopyDialog(false)}
          onConfirm={(a, b, p) => void handleCopy(a, b, p)}
        />
      )}

      {conflictPrompt && (
        <ConflictDialog
          conflicts={conflictPrompt.conflicts}
          total={conflictPrompt.total ?? conflictPrompt.conflicts}
          sample={conflictPrompt.sample}
          targetLabel={conflictPrompt.targetLabel}
          onCancel={() => setConflictPrompt(null)}
          onOverwrite={() => void resolveConflict('overwrite')}
          onSkip={() => void resolveConflict('skip')}
        />
      )}

      {copyBucket && (
        <CopyDialog
          accounts={accounts}
          sourceAccountId={copyBucket.accountId}
          sourceBucket={copyBucket.bucket}
          itemCount={0}
          bucketMode
          onCancel={() => setCopyBucket(null)}
          onConfirm={(a, b, p, skip) => void handleSyncBucket(a, b, p, skip)}
        />
      )}

      {detailsEntry && accountId && bucket && (
        <DetailsDialog
          accountId={accountId}
          bucket={bucket}
          entry={detailsEntry}
          onClose={() => setDetailsEntry(null)}
        />
      )}
    </div>
  )
}
