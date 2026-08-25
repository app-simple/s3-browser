export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`
}

export function formatDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })
}

export function basename(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

export function joinKey(prefix: string, name: string): string {
  if (!prefix) return name
  return prefix.endsWith('/') ? prefix + name : `${prefix}/${name}`
}
