import type { ProjectPayload } from '@/backend/lib/mjengo'

/**
 * Pure CSV export helpers for MjengoOS.
 * KSh amounts are plain rounded numbers (no "KSh" prefix) so Excel can sum them.
 * Dates are ISO date-only strings (YYYY-MM-DD).
 */

export type CSVRow = Record<string, string | number | null>

/** Serialize rows (first row = header) to CSV with RFC-4180 quote escaping. */
export function toCSV(rows: Array<Record<string, string | number | null>>): string {
  const escapeCell = (cell: string | number | null): string => {
    const raw = cell === null || cell === undefined ? '' : String(cell)
    return `"${raw.replace(/"/g, '""')}"`
  }
  return rows.map((row) => Object.values(row).map(escapeCell).join(',')).join('\r\n')
}

/** Trigger a browser download of `csv` as `filename` (UTF-8 BOM so Excel reads KSh text correctly). */
export function downloadCSV(filename: string, csv: string): void {
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function isoDateOnly(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10)
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

/** Materials inventory ledger: delivered vs consumed vs on-site stock value. */
export function materialsLedgerCSV(p: ProjectPayload): string {
  const rows: CSVRow[] = [
    {
      Material: 'Material', Unit: 'Unit', 'Unit Price': 'Unit Price',
      'Delivered Qty': 'Delivered Qty', 'Delivered Cost': 'Delivered Cost',
      'Consumed Qty': 'Consumed Qty', 'On-site Qty': 'On-site Qty', 'Stock Value': 'Stock Value',
    },
    ...p.materials.map((m) => ({
      Material: m.name,
      Unit: m.unit,
      'Unit Price': Math.round(m.unitPrice),
      'Delivered Qty': m.deliveredQty,
      'Delivered Cost': Math.round(m.deliveredCost),
      'Consumed Qty': m.consumedQty,
      'On-site Qty': m.onSiteQty,
      'Stock Value': Math.round(m.stockValue),
    })),
  ]
  return toCSV(rows)
}

/** Fundi attendance & wages for the current day + week. */
export function attendanceCSV(p: ProjectPayload): string {
  const statusLabel = (s: string | null): string => {
    if (!s) return '—'
    return s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  }
  const rows: CSVRow[] = [
    {
      Worker: 'Worker', Role: 'Role', 'Daily Rate': 'Daily Rate',
      'Today Status': 'Today Status', 'Today Wage': 'Today Wage',
      Paid: 'Paid', 'Week Earnings': 'Week Earnings',
    },
    ...p.workers.map((w) => ({
      Worker: w.name,
      Role: w.role,
      'Daily Rate': Math.round(w.dailyRate),
      'Today Status': statusLabel(w.todayStatus.status),
      'Today Wage': Math.round(w.todayStatus.wage),
      Paid: w.todayStatus.paid ? 'Yes' : 'No',
      'Week Earnings': Math.round(w.weekEarnings),
    })),
  ]
  return toCSV(rows)
}

/** Money trail: every transaction on the project. */
export function transactionsCSV(p: ProjectPayload): string {
  const rows: CSVRow[] = [
    { Date: 'Date', Type: 'Type', Amount: 'Amount', Method: 'Method', Reference: 'Reference', Note: 'Note' },
    ...p.transactions.map((t) => ({
      Date: isoDateOnly(t.date),
      Type: t.type,
      Amount: Math.round(t.amount),
      Method: t.method,
      Reference: t.reference ?? '—',
      Note: t.note ?? '',
    })),
  ]
  return toCSV(rows)
}

/** One-page project snapshot as key,value rows. */
export function projectSummaryCSV(p: ProjectPayload): string {
  const s = p.summary
  const rows: Array<{ key: string; value: string | number }> = [
    { key: 'key', value: 'value' },
    { key: 'Project', value: p.project.name },
    { key: 'Client', value: p.project.client || '—' },
    { key: 'Location', value: p.project.location || '—' },
    { key: 'Status', value: p.project.status },
    { key: 'Day count', value: s.dayCount },
    { key: 'Progress %', value: s.progressPct },
    { key: 'Budget total', value: Math.round(s.budgetTotal) },
    { key: 'Budget spent', value: Math.round(s.budgetSpent) },
    { key: 'Spend vs plan delta %', value: s.spendVsPlanDelta },
    { key: 'Fundis today', value: s.fundisToday },
    { key: 'Unacked alerts', value: s.unackedAlerts },
  ]
  return toCSV(rows)
}

/** Convenience: suggested filename prefix for a project. */
export function projectFilePrefix(p: ProjectPayload): string {
  return `mjengo-${slug(p.project.name)}`
}
