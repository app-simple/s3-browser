import { useEffect, useState } from 'react'
import type { ObjectDetails, S3Entry } from '@shared/types'
import { formatBytes, formatDate } from '@shared/format'

interface Props {
  accountId: string
  bucket: string
  entry: S3Entry
  onClose: () => void
}

const EXPIRY_OPTIONS = [
  { label: '15 minutes', value: 900 },
  { label: '1 hour', value: 3600 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 }
]

export default function DetailsDialog({ accountId, bucket, entry, onClose }: Props) {
  const [details, setDetails] = useState<ObjectDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expiry, setExpiry] = useState(3600)
  const [url, setUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    window.api.s3
      .head(accountId, bucket, entry.key)
      .then(setDetails)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [accountId, bucket, entry.key])

  async function share(): Promise<void> {
    setError(null)
    setCopied(false)
    try {
      const link = await window.api.s3.presign(accountId, bucket, entry.key, expiry)
      setUrl(link)
      await window.api.system.copyToClipboard(link)
      setCopied(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const rows: [string, string][] = details
    ? [
        ['Key', details.key],
        ['Size', `${formatBytes(details.size)} (${details.size.toLocaleString()} bytes)`],
        ['Modified', formatDate(details.lastModified)],
        ['Content type', details.contentType ?? '—'],
        ['Storage class', details.storageClass ?? 'STANDARD'],
        ['ETag', details.etag ?? '—'],
        ...(details.versionId ? ([['Version ID', details.versionId]] as [string, string][]) : []),
        ...Object.entries(details.metadata).map(
          ([k, v]) => [`x-amz-meta-${k}`, v] as [string, string]
        )
      ]
    : []

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">{entry.name}</div>
        <div className="modal-body">
          {!details && !error && (
            <div style={{ padding: '10px 0' }}>
              <span className="spinner" />
            </div>
          )}
          {error && <div className="banner error" style={{ margin: '0 0 12px' }}>{error}</div>}

          {details && (
            <table style={{ width: '100%', fontSize: 12.5, marginBottom: 14 }}>
              <tbody>
                {rows.map(([k, v]) => (
                  <tr key={k}>
                    <td
                      style={{
                        color: 'var(--text-faint)',
                        padding: '4px 12px 4px 0',
                        verticalAlign: 'top',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {k}
                    </td>
                    <td style={{ userSelect: 'text', wordBreak: 'break-all' }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="field">
            <label>Presigned share link</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                value={expiry}
                onChange={(e) => setExpiry(Number(e.target.value))}
                style={{ maxWidth: 160 }}
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <button onClick={share}>Generate &amp; copy</button>
            </div>
            {url && (
              <div className="hint" style={{ userSelect: 'text', wordBreak: 'break-all' }}>
                {copied && <strong style={{ color: 'var(--success)' }}>Copied to clipboard. </strong>}
                {url}
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
