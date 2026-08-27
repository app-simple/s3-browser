import { useEffect, useState } from 'react'
import type { Account, BucketInfo } from '@shared/types'

interface Props {
  accounts: Account[]
  sourceAccountId: string
  sourceBucket: string
  itemCount: number
  onCancel: () => void
  onConfirm: (targetAccountId: string, targetBucket: string, targetPrefix: string) => void
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
  onCancel,
  onConfirm
}: Props) {
  const [accountId, setAccountId] = useState(sourceAccountId)
  const [buckets, setBuckets] = useState<BucketInfo[] | null>(null)
  const [bucket, setBucket] = useState('')
  const [folder, setFolder] = useState('')
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
          Copy {itemCount} item{itemCount === 1 ? '' : 's'} to…
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
                  onConfirm(accountId, bucket, normalizePrefix(folder))
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
          {error && <div className="hint" style={{ color: 'var(--danger)' }}>{error}</div>}
        </div>
        <div className="modal-foot">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!bucket}
            onClick={() => onConfirm(accountId, bucket, normalizePrefix(folder))}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  )
}
