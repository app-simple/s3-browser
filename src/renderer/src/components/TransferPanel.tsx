import { useState } from 'react'
import type { Transfer } from '@shared/types'
import { formatBytes } from '@shared/format'
import { ChevronIcon, DownloadIcon, UploadIcon, XIcon } from './Icons'

interface Props {
  transfers: Transfer[]
  onCancel: (id: string) => void
  onClear: () => void
  onReveal: (path: string) => void
}

export default function TransferPanel({ transfers, onCancel, onClear, onReveal }: Props) {
  const [open, setOpen] = useState(true)
  if (transfers.length === 0) return null

  const active = transfers.filter((t) => t.status === 'running' || t.status === 'queued').length
  const failed = transfers.filter((t) => t.status === 'error').length

  return (
    <div className="transfers">
      <div className="transfers-head" onClick={() => setOpen((v) => !v)}>
        <span
          style={{
            display: 'flex',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .12s'
          }}
        >
          <ChevronIcon size={12} />
        </span>
        <strong style={{ color: 'var(--text)' }}>Transfers</strong>
        {active > 0 && <span className="badge">{active} active</span>}
        {failed > 0 && (
          <span className="badge" style={{ color: 'var(--danger)' }}>{failed} failed</span>
        )}
        <span className="spacer" />
        <button
          className="ghost"
          style={{ fontSize: 11.5, padding: '2px 7px' }}
          onClick={(e) => {
            e.stopPropagation()
            onClear()
          }}
        >
          Clear finished
        </button>
      </div>

      {open && (
        <div className="transfers-list">
          {transfers.map((t) => {
            const pct = t.total > 0 ? Math.min(100, (t.loaded / t.total) * 100) : t.status === 'done' ? 100 : 0
            const running = t.status === 'running' || t.status === 'queued'
            return (
              <div className="transfer-row" key={t.id}>
                {t.kind === 'upload' ? <UploadIcon size={13} /> : <DownloadIcon size={13} />}
                <span
                  className="tname"
                  title={`${t.bucket}/${t.key}`}
                  onDoubleClick={() => t.kind === 'download' && onReveal(t.localPath)}
                >
                  {t.name}
                </span>
                <div className={`progress ${t.status}`}>
                  <div style={{ width: `${pct}%` }} />
                </div>
                <span className={`tstatus ${t.status === 'error' ? 'error' : ''}`} title={t.error}>
                  {t.status === 'error'
                    ? 'failed'
                    : t.status === 'cancelled'
                      ? 'cancelled'
                      : t.status === 'done'
                        ? formatBytes(t.total)
                        : `${Math.round(pct)}%`}
                </span>
                {running ? (
                  <button
                    className="ghost"
                    style={{ padding: 2 }}
                    title="Cancel"
                    onClick={() => onCancel(t.id)}
                  >
                    <XIcon size={12} />
                  </button>
                ) : (
                  <span />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
