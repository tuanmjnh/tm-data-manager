export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—'
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return value
  const diff = Date.now() - timestamp
  const abs = Math.abs(diff)
  if (abs < 60_000) return diff >= 0 ? 'just now' : 'in a moment'
  const minutes = Math.round(abs / 60_000)
  if (minutes < 60) return diff >= 0 ? `${minutes}m ago` : `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return diff >= 0 ? `${hours}h ago` : `in ${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return diff >= 0 ? `${days}d ago` : `in ${days}d`
  return formatDateTime(value)
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—'
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat().format(value ?? 0)
}
