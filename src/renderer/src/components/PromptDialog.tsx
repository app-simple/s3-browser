import { useEffect, useRef, useState } from 'react'

interface Props {
  title: string
  label: string
  initialValue?: string
  confirmLabel?: string
  hint?: string
  onCancel: () => void
  onConfirm: (value: string) => void
}

export default function PromptDialog({
  title,
  label,
  initialValue = '',
  confirmLabel = 'OK',
  hint,
  onCancel,
  onConfirm
}: Props) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-head">{title}</div>
        <div className="modal-body">
          <div className="field">
            <label>{label}</label>
            <input
              ref={inputRef}
              value={value}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && value.trim()) onConfirm(value.trim())
                if (e.key === 'Escape') onCancel()
              }}
            />
            {hint && <div className="hint">{hint}</div>}
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!value.trim()} onClick={() => onConfirm(value.trim())}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
