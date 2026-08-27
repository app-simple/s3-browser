import { useEffect, useState } from 'react'
import type { Account, BucketInfo } from '@shared/types'

interface Props {
  accounts: Account[]
  sourceAccountId: string
  sourceBucket: string
  itemCount: number
  /** copy the whole bucket (resumable sync) instead of the current selection */
  bucketMode?: boolean
  onCancel: () => void
  onConfirm: (
    targetAccountId: string,
    targetBucket: string,
    targetPrefix: string,
    skipExisting: boolean
  ) => void
}

/** '' stays '', anything else becomes a clean prefix ending in '/' */
function normalizePrefix(input: string): string {
  const clean = input
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/')
  return clean ? `${clean}/` : ''
}

export default function CopyDialog({
  accounts,
  sourceAccountId,
  sourceBucket,
  itemCount,
  bucketMode = false,
  onCancel,
  onConfirm
}: Props) {
  const [accountId, setAccountId] = useState(sourceAccountId)
  const [buckets, setBuckets] = useState<BucketInfo[] | null>(null)
  const [bucket, setBucket] = useState('')
  const [folder, setFolder] = useState('')
  const [skipExisting, setSkipExisting] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    setBuckets(null)
    setBucket('')
    setError(null)
    window.api.s3
      .listBuckets(accountId)
      .then((list) => {
        if (stale) return
        setBuckets(list)
      })
      .catch((e) => {
        if (stale) return
        setBuckets([])
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      stale = true
    }
  }, [accountId])

  const sameAccount = accountId === sourceAccountId

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-head">
          {bucketMode
            ? `Copy bucket "${sourceBucket}" to…`
            : `Copy ${itemCount} item${itemCount === 1 ? '' : 's'} to…`}
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Connection</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Bucket</label>
            <select
              value={bucket}
              disabled={buckets === null}
              onChange={(e) => setBucket(e.target.value)}
            >
              <option value="">
                {buckets === null ? 'Loading buckets…' : 'Select a bucket'}
              </option>
              {(buckets ?? []).map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Target folder (optional)</label>
            <input
              value={folder}
              placeholder="e.g. backups/2026"
              spellCheck={false}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && bucket) {
                  onConfirm(accountId, bucket, normalizePrefix(folder), skipExisting)
                }
                if (e.key === 'Escape') onCancel()
              }}
            />
            <div className="hint">
              {sameAccount
                ? 'Objects are copied server-side — the data never leaves the provider.'
                : 'Objects are streamed directly between the providers without touching your disk.'}
            </div>
          </div>
          {bucketMode && (
            <div className="field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={skipExisting}
                  onChange={(e) => setSkipExisting(e.target.checked)}
                />
                Skip objects that already exist at the destination (same size)
              </label>
              <div className="hint">
                Makes the copy resumable: run it again and only new or changed objects are
                transferred.
              </div>
            </div>
          )}
          {error && <div className="hint" style={{ color: 'var(--danger)' }}>{error}</div>}
        </div>
        <div className="modal-foot">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!bucket}
            onClick={() => onConfirm(accountId, bucket, normalizePrefix(folder), skipExisting)}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  )
}
