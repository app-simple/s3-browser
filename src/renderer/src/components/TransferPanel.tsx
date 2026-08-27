import { useRef, useState } from 'react'
import type { Transfer } from '@shared/types'
import { formatBytes } from '@shared/format'
import { ChevronIcon, CopyIcon, DownloadIcon, UploadIcon, XIcon } from './Icons'

interface Props {
  transfers: Transfer[]
  onCancel: (id: string) => void
  onClear: () => void
  onReveal: (path: string) => void
}

interface SpeedSample {
  loaded: number
  time: number
  speed: number
}

export default function TransferPanel({ transfers, onCancel, onClear, onReveal }: Props) {
  const [open, setOpen] = useState(true)
  const samples = useRef(new Map<string, SpeedSample>())

  /** smoothed bytes/second from the loaded deltas between renders */
  function speedOf(t: Transfer): number {
    if (t.status !== 'running') {
      samples.current.delete(t.id)
      return 0
    }
    const now = Date.now()
    const prev = samples.current.get(t.id)
    if (!prev) {
      samples.current.set(t.id, { loaded: t.loaded, time: now, speed: 0 })
      return 0
    }
    const dt = now - prev.time
    if (dt < 500) return prev.speed
    const instant = ((t.loaded - prev.loaded) * 1000) / dt
    const speed = prev.speed > 0 ? prev.speed * 0.7 + instant * 0.3 : instant
    samples.current.set(t.id, { loaded: t.loaded, time: now, speed })
    return speed
  }

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
            const speed = speedOf(t)
            const subParts: string[] = []
            if (t.status === 'running' && t.detail) subParts.push(t.detail)
            if (t.itemsTotal) {
              subParts.push(
                t.status === 'running'
                  ? `${t.itemsDone ?? 0} / ${t.itemsTotal} objects`
                  : `${t.itemsTotal} objects`
              )
              if (t.itemsSkipped) subParts.push(`${t.itemsSkipped} skipped`)
            }
            if (t.status === 'running' && speed > 0) subParts.push(`${formatBytes(speed)}/s`)
            return (
              <div className="transfer-row" key={t.id}>
                {t.kind === 'upload' ? (
                  <UploadIcon size={13} />
                ) : t.kind === 'download' ? (
                  <DownloadIcon size={13} />
                ) : (
                  <CopyIcon size={13} />
                )}
                <div
                  className="tmain"
                  title={
                    t.kind === 'copy'
                      ? `${t.bucket}/${t.key} → ${t.targetBucket}/${t.targetKey}`
                      : `${t.bucket}/${t.key}`
                  }
                  onDoubleClick={() => t.kind === 'download' && onReveal(t.localPath)}
                >
                  <span className="tname">{t.name}</span>
                  {subParts.length > 0 && <span className="tsub">{subParts.join(' · ')}</span>}
                </div>
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
