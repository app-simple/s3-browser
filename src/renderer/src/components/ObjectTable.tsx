import { useMemo, useState } from 'react'
import type { S3Entry } from '@shared/types'
import { formatBytes, formatDate } from '@shared/format'
import { FileIcon, FolderIcon } from './Icons'

type SortKey = 'name' | 'size' | 'lastModified'

interface Props {
  entries: S3Entry[]
  selected: Set<string>
  filter: string
  onToggle: (key: string, shiftKey: boolean) => void
  onToggleAll: (keys: string[]) => void
  onOpenFolder: (prefix: string) => void
  onOpenDetails: (entry: S3Entry) => void
}

export default function ObjectTable({
  entries,
  selected,
  filter,
  onToggle,
  onToggleAll,
  onOpenFolder,
  onOpenDetails
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [asc, setAsc] = useState(true)

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const filtered = needle
      ? entries.filter((e) => e.name.toLowerCase().includes(needle))
      : entries

    const dir = asc ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      switch (sortKey) {
        case 'size':
          return (a.size - b.size) * dir
        case 'lastModified':
          return ((a.lastModified ?? '') > (b.lastModified ?? '') ? 1 : -1) * dir
        default:
          return a.name.localeCompare(b.name, undefined, { numeric: true }) * dir
      }
    })
  }, [entries, filter, sortKey, asc])

  function sortBy(key: SortKey): void {
    if (key === sortKey) setAsc((v) => !v)
    else {
      setSortKey(key)
      setAsc(true)
    }
  }

  const allKeys = visible.map((e) => e.key)
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k))
  const arrow = (key: SortKey): string => (sortKey === key ? (asc ? ' ↑' : ' ↓') : '')

  return (
    <table className="objects">
      <thead>
        <tr>
          <th className="col-check">
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={allSelected}
              onChange={() => onToggleAll(allKeys)}
            />
          </th>
          <th onClick={() => sortBy('name')}>Name{arrow('name')}</th>
          <th className="col-size" onClick={() => sortBy('size')}>Size{arrow('size')}</th>
          <th className="col-date" onClick={() => sortBy('lastModified')}>
            Modified{arrow('lastModified')}
          </th>
          <th className="col-class">Storage class</th>
        </tr>
      </thead>
      <tbody>
        {visible.map((e) => (
          <tr
            key={e.key}
            className={selected.has(e.key) ? 'selected' : ''}
            onClick={(ev) => onToggle(e.key, ev.shiftKey)}
            onDoubleClick={() =>
              e.type === 'folder' ? onOpenFolder(e.key) : onOpenDetails(e)
            }
          >
            <td className="col-check" onClick={(ev) => ev.stopPropagation()}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={selected.has(e.key)}
                onChange={(ev) => onToggle(e.key, (ev.nativeEvent as MouseEvent).shiftKey)}
              />
            </td>
            <td className="name-cell" title={e.key}>
              {e.type === 'folder' ? <FolderIcon /> : <FileIcon />}
              <span
                className={`label ${e.type === 'folder' ? 'folder' : ''}`}
                onClick={(ev) => {
                  if (e.type !== 'folder') return
                  ev.stopPropagation()
                  onOpenFolder(e.key)
                }}
              >
                {e.name}
              </span>
            </td>
            <td className="col-size">{e.type === 'folder' ? '—' : formatBytes(e.size)}</td>
            <td className="col-date">{e.type === 'folder' ? '—' : formatDate(e.lastModified)}</td>
            <td className="col-class">{e.type === 'folder' ? '—' : e.storageClass ?? 'STANDARD'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
