export function formatKES(n: number, compact = false): string {
  if (compact && Math.abs(n) >= 1_000_000) return `KSh ${(n / 1_000_000).toFixed(1)}M`
  if (compact && Math.abs(n) >= 10_000) return `KSh ${Math.round(n / 1000)}K`
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

export function timeEAT(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-KE', {
    timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export function dateShort(d: string | Date): string {
  return new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' })
}

export function relativeDays(ago: number): string {
  if (ago === 0) return 'Today'
  if (ago === 1) return 'Yesterday'
  return `${ago}d ago`
}

export function daysBetween(a: Date | string, b: Date | string = new Date()): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000))
}
