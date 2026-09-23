import { useRef, useState } from 'react'
import type { QueueSnapshot, TransferItemView, TransferJobView } from '@shared/types'
import { formatBytes } from '@shared/format'
import {
  ChevronIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  PauseIcon,
  PlayIcon,
  UploadIcon,
  XIcon
} from './Icons'

interface Props {
  queue: QueueSnapshot
  onPauseAll(): void
  onResumeAll(): void
  onPauseJob(id: string): void
  onResumeJob(id: string): void
  onCancelJob(id: string): void
  onCancelItem(id: string, index: number): void
  onClear(): void
  onReveal(id: string): void
  onRestore(decision: 'resume' | 'discard'): void
}

interface SpeedSample {
  done: number
  time: number
  speed: number
}

const KIND_ICON = { upload: UploadIcon, download: DownloadIcon, copy: CopyIcon, sync: CopyIcon }

function percent(job: TransferJobView): number {
  if (job.bytes.total) return Math.min(100, (job.bytes.done / job.bytes.total) * 100)
  const { items } = job
  const settled = items.done + items.skipped + items.failed + items.cancelled
  return items.total ? Math.min(100, (settled / items.total) * 100) : 0
}

/** One line under the title: how far the job is and what it is doing right now. */
function summary(job: TransferJobView, speed: number): string {
  if (job.error) return `Failed — ${job.error}`
  // a single-file job never expands, so its reason has to show right here
  if (job.items.total === 1 && job.failed.length > 0) return `Failed — ${job.failed[0].error}`
  const { items } = job
  const settled = (items.done + items.skipped).toLocaleString()
  const parts = [items.total === null ? `${settled} objects` : `${settled} / ${items.total.toLocaleString()}`]
  if (items.skipped) parts.push(`${items.skipped.toLocaleString()} skipped`)
  if (items.failed) parts.push(`${items.failed.toLocaleString()} failed`)
  if (items.cancelled) parts.push(`${items.cancelled.toLocaleString()} cancelled`)
  if (!job.finished) {
    if (job.paused) parts.push(items.running ? `paused — ${items.running} finishing` : 'paused')
    else if (speed > 0) parts.push(`${formatBytes(speed)}/s`)
  }
  return parts.join(' · ')
}

function jobStatus(job: TransferJobView): string {
  if (job.error || (job.finished && job.items.failed)) return 'error'
  if (job.finished) return job.items.done || job.items.skipped ? 'done' : 'cancelled'
  return 'running'
}

function ItemRow({ item, onCancel }: { item: TransferItemView; onCancel?: () => void }) {
  const pct = item.size > 0 ? Math.min(100, (item.loaded / item.size) * 100) : 0
  const failed = item.status === 'error'
  return (
    <div className="transfer-row item-row">
      <span />
      <div className="tmain" title={item.error ?? item.name}>
        <span className="tname">{item.name}</span>
        {item.error && <span className="tsub error">{item.error}</span>}
      </div>
      <div className={`progress ${item.status}`}>
        <div style={{ width: `${failed ? 100 : pct}%` }} />
      </div>
      <span className={`tstatus ${failed ? 'error' : ''}`}>{failed ? 'failed' : `${Math.round(pct)}%`}</span>
      {onCancel ? (
        <button className="ghost" style={{ padding: 2 }} title="Cancel" onClick={onCancel}>
          <XIcon size={12} />
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

function JobRow(props: {
  job: TransferJobView
  speed: number
  expanded: boolean
  onToggle(): void
} & Omit<Props, 'queue' | 'onPauseAll' | 'onResumeAll' | 'onClear' | 'onRestore'>) {
  const { job, speed, expanded } = props
  const Icon = KIND_ICON[job.kind]
  const single = job.items.total === 1
  const waiting = job.items.waiting ?? 0
  return (
    <div className="job">
      <div className="transfer-row job-row">
        <span
          className="job-toggle"
          onClick={single ? undefined : props.onToggle}
          style={{
            cursor: single ? 'default' : 'pointer',
            transform: expanded && !single ? 'rotate(90deg)' : 'none'
          }}
        >
          {single ? <Icon size={13} /> : <ChevronIcon size={11} />}
        </span>
        <div className="tmain" title={job.title}>
          <span className="tname">
            {!single && <Icon size={12} />} {job.title}
          </span>
          <span className="tsub">{summary(job, speed)}</span>
        </div>
        <div className={`progress ${jobStatus(job)}`}>
          <div style={{ width: `${percent(job)}%` }} />
        </div>
        <span className="tstatus">{formatBytes(job.bytes.total ?? job.bytes.done)}</span>
        <span className="job-actions">
          {job.target.type === 'local' && job.items.done > 0 && (
            <button className="ghost" title="Show in folder" onClick={() => props.onReveal(job.id)}>
              <FolderIcon size={12} />
            </button>
          )}
          {!job.finished &&
            (job.paused ? (
              <button className="ghost" title="Resume" onClick={() => props.onResumeJob(job.id)}>
                <PlayIcon size={12} />
              </button>
            ) : (
              <button className="ghost" title="Pause" onClick={() => props.onPauseJob(job.id)}>
                <PauseIcon size={12} />
              </button>
            ))}
          {!job.finished && (
            <button className="ghost" title="Cancel" onClick={() => props.onCancelJob(job.id)}>
              <XIcon size={12} />
            </button>
          )}
        </span>
      </div>
      {expanded && !single && (
        <div className="job-items">
          {job.running.map((item) => (
            <ItemRow key={`r${item.index}`} item={item} onCancel={() => props.onCancelItem(job.id, item.index)} />
          ))}
          {job.failed.map((item) => (
            <ItemRow key={`f${item.index}`} item={item} />
          ))}
          {job.upcoming.length > 0 && (
            <div className="job-upcoming">
              · {job.upcoming[0].name}
              {job.upcoming.length > 1 && ` … ${job.upcoming[job.upcoming.length - 1].name}`}
              {waiting > job.upcoming.length && (
                <span className="more"> + {(waiting - job.upcoming.length).toLocaleString()} more waiting</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function restoreText(r: { jobs: number; items: number }): string {
  const jobs = `${r.jobs} unfinished job${r.jobs === 1 ? '' : 's'} from last time`
  return r.items > 0 ? `${jobs} — ${r.items.toLocaleString()} transfer${r.items === 1 ? '' : 's'} waiting` : jobs
}

export default function TransferPanel(props: Props) {
  const { queue } = props
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const samples = useRef(new Map<string, SpeedSample>())

  /** smoothed bytes/second from the byte deltas between renders */
  function speedOf(job: TransferJobView): number {
    if (job.finished || job.paused || job.items.running === 0) {
      samples.current.delete(job.id)
      return 0
    }
    const now = Date.now()
    const prev = samples.current.get(job.id)
    if (!prev) {
      samples.current.set(job.id, { done: job.bytes.done, time: now, speed: 0 })
      return 0
    }
    const dt = now - prev.time
    if (dt < 500) return prev.speed
    const instant = ((job.bytes.done - prev.done) * 1000) / dt
    const speed = prev.speed > 0 ? prev.speed * 0.7 + instant * 0.3 : instant
    samples.current.set(job.id, { done: job.bytes.done, time: now, speed })
    return speed
  }

  if (queue.jobs.length === 0 && !queue.restore) return null

  const running = queue.jobs.reduce((n, j) => n + j.items.running, 0)
  const waiting = queue.jobs.reduce((n, j) => n + (j.finished ? 0 : (j.items.waiting ?? 0)), 0)
  const failed = queue.jobs.reduce((n, j) => n + j.items.failed, 0)
  const anyActive = queue.jobs.some((j) => !j.finished)

  return (
    <div className="transfers">
      <div className="transfers-head" onClick={() => setOpen((v) => !v)}>
        <span style={{ display: 'flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>
          <ChevronIcon size={12} />
        </span>
        <strong style={{ color: 'var(--text)' }}>Transfers</strong>
        {running > 0 && <span className="badge">{running} active</span>}
        {waiting > 0 && <span className="badge">{waiting.toLocaleString()} waiting</span>}
        {failed > 0 && (
          <span className="badge" style={{ color: 'var(--danger)' }}>
            {failed} failed
          </span>
        )}
        {queue.paused && <span className="badge">{running > 0 ? `paused — ${running} finishing` : 'paused'}</span>}
        <span className="spacer" />
        {anyActive && (
          <button
            className="ghost"
            style={{ fontSize: 11.5, padding: '2px 7px' }}
            onClick={(e) => {
              e.stopPropagation()
              if (queue.paused) props.onResumeAll()
              else props.onPauseAll()
            }}
          >
            {queue.paused ? <PlayIcon size={11} /> : <PauseIcon size={11} />}
            {queue.paused ? ' Resume all' : ' Pause all'}
          </button>
        )}
        <button
          className="ghost"
          style={{ fontSize: 11.5, padding: '2px 7px' }}
          onClick={(e) => {
            e.stopPropagation()
            props.onClear()
          }}
        >
          Clear finished
        </button>
      </div>

      {queue.restore && (
        <div className="restore-bar">
          <span>{restoreText(queue.restore)}</span>
          <span className="spacer" />
          <button className="primary" onClick={() => props.onRestore('resume')}>
            Resume
          </button>
          <button className="ghost" onClick={() => props.onRestore('discard')}>
            Discard
          </button>
        </div>
      )}

      {open && (
        <div className="transfers-list">
          {queue.jobs.map((job) => (
            <JobRow
              key={job.id}
              {...props}
              job={job}
              speed={speedOf(job)}
              expanded={expanded[job.id] ?? !job.finished}
              onToggle={() => setExpanded((s) => ({ ...s, [job.id]: !(s[job.id] ?? !job.finished) }))}
            />
          ))}
        </div>
      )}
    </div>
  )
}
