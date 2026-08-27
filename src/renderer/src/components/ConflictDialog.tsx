interface Props {
  conflicts: number
  total: number
  sample: string[]
  targetBucket: string
  onOverwrite: () => void
  onSkip: () => void
  onCancel: () => void
}

export default function ConflictDialog({
  conflicts,
  total,
  sample,
  targetBucket,
  onOverwrite,
  onSkip,
  onCancel
}: Props) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-head">Objects already exist</div>
        <div className="modal-body">
          <p style={{ margin: '0 0 10px' }}>
            {conflicts} of {total} object{total === 1 ? '' : 's'} already exist
            {conflicts === 1 ? 's' : ''} in “{targetBucket}”:
          </p>
          <ul
            style={{
              margin: '0 0 10px',
              paddingLeft: 18,
              color: 'var(--text-dim)',
              fontSize: 12,
              maxHeight: 110,
              overflow: 'hidden'
            }}
          >
            {sample.map((k) => (
              <li key={k} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {k}
              </li>
            ))}
            {conflicts > sample.length && <li>… and {conflicts - sample.length} more</li>}
          </ul>
          <div className="hint">
            “Skip existing” copies only the {total - conflicts} object
            {total - conflicts === 1 ? '' : 's'} that {total - conflicts === 1 ? 'is' : 'are'} not
            at the destination yet. “Overwrite” replaces the existing objects.
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onCancel}>Cancel</button>
          <button disabled={conflicts === total} onClick={onSkip}>
            Skip existing
          </button>
          <button className="danger" onClick={onOverwrite}>
            Overwrite
          </button>
        </div>
      </div>
    </div>
  )
}
