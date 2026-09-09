'use client'

// Report builders (spec §49 reporting + §79 export) — pure functions over the
// live ProjectPayload: 4 CSV variants (daily / weekly / financial /
// procurement) plus a Weekly PDF. Every row comes from real project data and
// each file opens with an honest generated-at stamp — no fabricated facts.
//
// CSV serialization reuses the RFC-4180 helpers from export-utils.ts (shared,
// unchanged). The A4 PDF helper block is deliberately duplicated from
// evidence-tab.tsx (per ownership: no cross-import) — same 20 lines, same look.

import type { ProjectPayload } from '@/backend/lib/mjengo'
import { toCSV, downloadCSV, projectFilePrefix, type CSVRow } from '@/frontend/mjengo/export-utils'

function isoDate(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10)
}

function isoDateTime(d: Date | string): string {
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function isToday(d: Date | string): boolean {
  const t = new Date(new Date().getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10) // EAT today
  return new Date(d).toISOString().slice(0, 10) === t
}

/** Prepend the title + generated-at header rows shared by every CSV report. */
function reportHeader(title: string, p: ProjectPayload): CSVRow[] {
  return [
    { A: title, B: '', C: '', D: '', E: '', F: '', G: '', H: '' },
    { A: `Project: ${p.project.name}`, B: `Client: ${p.project.client}`, C: `Location: ${p.project.location}`, D: '', E: '', F: '', G: '', H: '' },
    { A: `Generated: ${isoDateTime(new Date())} from live project data (day ${p.summary.dayCount})`, B: '', C: '', D: '', E: '', F: '', G: '', H: '' },
    { A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' },
  ]
}

// ---------------- Daily report (attendance · movements · transactions today) ----------------

export function buildDailyReportCSV(p: ProjectPayload): string {
  const rows: CSVRow[] = reportHeader('MjengoOS — Daily Site Report', p)

  rows.push({ A: 'ATTENDANCE TODAY', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Worker', B: 'Role', C: 'Status', D: 'Wage (KES)', E: 'Paid', F: '', G: '', H: '' })
  for (const w of p.workers) {
    rows.push({
      A: w.name, B: w.role, C: w.todayStatus.status ?? '—',
      D: Math.round(w.todayStatus.wage), E: w.todayStatus.paid ? 'yes' : 'no',
      F: '', G: '', H: '',
    })
  }

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'SITE STORE MOVEMENTS TODAY', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Material', B: 'Movement', C: 'Qty', D: 'Unit', E: 'Reference', F: 'Recorded by', G: '', H: '' })
  const movementsToday = p.inventory.movements.filter((m) => isToday(m.createdAt))
  for (const m of movementsToday) {
    rows.push({ A: m.materialName, B: m.type, C: m.quantity, D: m.unit, E: m.reference ?? '—', F: m.recordedBy, G: '', H: '' })
  }
  if (movementsToday.length === 0) rows.push({ A: '(no stock movements recorded today)', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'TRANSACTIONS TODAY', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Type', B: 'Amount (KES)', C: 'Method', D: 'Reference', E: 'Note', F: '', G: '', H: '' })
  const txToday = p.transactions.filter((t) => isToday(t.date))
  for (const t of txToday) {
    rows.push({ A: t.type, B: Math.round(t.amount), C: t.method, D: t.reference ?? '—', E: t.note ?? '', F: '', G: '', H: '' })
  }
  if (txToday.length === 0) rows.push({ A: '(no transactions recorded today)', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: `Crew ${p.summary.fundisToday}/${p.summary.fundisExpected} today · wages ${Math.round(p.summary.wagesToday)} KES · unacked alerts ${p.summary.unackedAlerts}`, B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  return toCSV(rows)
}

// ---------------- Weekly report (spend trend · milestones decided · alerts) ----------------

export function buildWeeklyReportCSV(p: ProjectPayload): string {
  const rows: CSVRow[] = reportHeader('MjengoOS — Weekly Report', p)

  rows.push({ A: 'SPEND TREND (week · planned vs actual, KES)', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Week', B: 'Planned', C: 'Actual', D: 'Delta', E: '', F: '', G: '', H: '' })
  for (const t of p.summary.spendTrend) {
    rows.push({ A: t.label, B: Math.round(t.planned), C: Math.round(t.actual), D: Math.round(t.actual - t.planned), E: '', F: '', G: '', H: '' })
  }

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'MILESTONE DECISIONS', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Milestone', B: 'Amount (KES)', C: 'Status', D: 'Decided by', E: 'Decided at', F: '', G: '', H: '' })
  const decided = p.milestones.filter((m) => m.decidedAt)
  for (const m of decided) {
    rows.push({ A: m.name, B: Math.round(m.amount), C: m.status, D: m.decidedBy ?? '—', E: isoDate(m.decidedAt as Date), F: '', G: '', H: '' })
  }
  if (decided.length === 0) rows.push({ A: '(no milestone decisions on record)', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'ALERTS (latest 20)', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Severity', B: 'Title', C: 'Acknowledged', D: 'Created', E: '', F: '', G: '', H: '' })
  for (const a of p.alerts.slice(0, 20)) {
    rows.push({ A: a.severity, B: a.title, C: a.acknowledged ? 'yes' : 'no', D: isoDate(a.createdAt), E: '', F: '', G: '', H: '' })
  }

  return toCSV(rows)
}

// ---------------- Financial report (budget lines · ledger · escrow) ----------------

export function buildFinancialReportCSV(p: ProjectPayload): string {
  const rows: CSVRow[] = reportHeader('MjengoOS — Financial Report', p)

  rows.push({ A: 'BUDGET LINES (phases)', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Phase', B: 'Budget (KES)', C: 'Progress %', D: 'Status', E: '', F: '', G: '', H: '' })
  for (const ph of p.phases) {
    rows.push({ A: ph.name, B: Math.round(ph.budget), C: ph.progress, D: ph.status, E: '', F: '', G: '', H: '' })
  }
  rows.push({ A: 'TOTAL', B: Math.round(p.summary.budgetTotal), C: p.summary.progressPct, D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'DOUBLE-ENTRY LEDGER TRANSACTIONS', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Ref', B: 'Description', C: 'Occurred', D: 'Status', E: 'Posted by', F: 'Total (KES)', G: '', H: '' })
  for (const lt of p.finance.ledger.transactions) {
    rows.push({ A: lt.ref, B: lt.description, C: isoDate(lt.occurredAt), D: lt.status, E: `${lt.postedBy} (${lt.postedRole})`, F: Math.round(lt.total), G: '', H: '' })
  }
  if (p.finance.ledger.transactions.length === 0) rows.push({ A: '(no ledger transactions posted)', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'ESCROW', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({
    A: 'Balance (KES)', B: p.escrow ? Math.round(p.escrow.balance) : 0,
    C: 'Committed (KES)', D: Math.round(p.finance.committed),
    E: 'Remaining after commitments (KES)', F: Math.round(p.finance.remaining),
    G: '', H: '',
  })

  return toCSV(rows)
}

// ---------------- Procurement report (requests · POs · discrepancies) ----------------

export function buildProcurementReportCSV(p: ProjectPayload): string {
  const rows: CSVRow[] = reportHeader('MjengoOS — Procurement Report', p)

  rows.push({ A: 'MATERIAL REQUESTS BY STATUS', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Request', B: 'Status', C: 'Lines', D: 'Created', E: '', F: '', G: '', H: '' })
  for (const r of p.supply.requests) {
    rows.push({ A: r.requestCode, B: r.status, C: r.lines.length, D: isoDate(r.createdAt), E: '', F: '', G: '', H: '' })
  }

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'PURCHASE ORDERS', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Order', B: 'Supplier', C: 'Status', D: 'Subtotal (KES)', E: 'Delivery fee (KES)', F: 'Total (KES)', G: '', H: '' })
  for (const o of p.supply.orders) {
    rows.push({ A: o.orderCode, B: o.supplierName, C: o.status, D: Math.round(o.subtotal), E: Math.round(o.deliveryFee), F: Math.round(o.total), G: '', H: '' })
  }

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'DELIVERY DISCREPANCIES (received vs ordered)', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: 'Order', B: 'Line', C: 'Ordered', D: 'Received', E: 'Short', F: 'Evidence photos', G: '', H: '' })
  let discrepancies = 0
  for (const o of p.supply.orders) {
    // OrderDeliveryLine carries quantities only — line names live on the PO lines.
    const lineNames = new Map(o.lines.map((l) => [l.id, l.name]))
    for (const d of o.deliveries) {
      // Line-scoped DeliveryPhoto links are the discrepancy evidence for
      // exactly that line's count (issue "Photo attachments on delivery
      // verification") — referenced here by relation, like the banner does.
      const photosByLine = new Map<string, number>()
      for (const ph of d.photos) {
        if (ph.deliveryLineId) {
          photosByLine.set(ph.deliveryLineId, (photosByLine.get(ph.deliveryLineId) ?? 0) + 1)
        }
      }
      for (const l of d.lines) {
        if (d.status === 'discrepancy' || l.qtyReceived < l.qtyOrdered) {
          discrepancies += 1
          const photoCount = photosByLine.get(l.id) ?? 0
          rows.push({
            A: o.orderCode,
            B: lineNames.get(l.orderLineId) ?? `line ${l.orderLineId}`,
            C: l.qtyOrdered,
            D: l.qtyReceived,
            E: Math.round(l.qtyOrdered - l.qtyReceived),
            F: photoCount > 0 ? `${photoCount} photo${photoCount === 1 ? '' : 's'}` : '',
            G: '',
            H: '',
          })
        }
      }
    }
  }
  if (discrepancies === 0) rows.push({ A: '(no delivery discrepancies on record)', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  return toCSV(rows)
}

// ---------------- Weekly PDF (jsPDF — A4 helpers duplicated from evidence-tab) ----------------

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Builds the A4 weekly PDF and triggers the browser download. Returns the filename. */
export async function downloadWeeklyReportPDF(p: ProjectPayload): Promise<string> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const M = 14 // margin
  const W = 210
  const contentW = W - M * 2
  const { project, summary } = p

  // Header band (same pattern as the evidence report)
  doc.setFillColor(28, 25, 23)
  doc.rect(0, 0, W, 26, 'F')
  doc.setFillColor(245, 158, 11)
  doc.rect(0, 26, W, 1.5, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('MjengoOS — Weekly Report', M, 12)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(231, 229, 228)
  doc.text(trunc(project.name, 60), M, 19.5)

  let y = 36
  doc.setTextColor(120, 113, 108)
  doc.setFontSize(9)
  doc.text(`${trunc(project.client, 48)} · ${trunc(project.location, 48)}`, M, y)
  doc.text(
    `Generated ${isoDateTime(new Date())} from live project data · Day ${summary.dayCount} · ${summary.progressPct}% complete`,
    M, y + 5,
  )
  y += 14

  // KPI row
  const kpis: Array<[string, string]> = [
    ['BUDGET', `KSh ${Math.round(summary.budgetSpent).toLocaleString('en-KE')} / ${Math.round(summary.budgetTotal).toLocaleString('en-KE')}`],
    ['SPEND VS PLAN', `${summary.spendVsPlanDelta >= 0 ? '+' : ''}${summary.spendVsPlanDelta}%`],
    ['CREW TODAY', `${summary.fundisToday}/${summary.fundisExpected}`],
    ['UNACKED ALERTS', `${summary.unackedAlerts}`],
  ]
  const cellW = (contentW - 3 * 4) / 4
  for (let i = 0; i < 4; i++) {
    const x = M + i * (cellW + 4)
    doc.setFillColor(245, 245, 244)
    doc.roundedRect(x, y, cellW, 16, 2, 2, 'F')
    doc.setFontSize(7)
    doc.setTextColor(120, 113, 108)
    doc.text(kpis[i][0], x + 3, y + 5)
    doc.setFontSize(10)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(28, 25, 23)
    doc.text(trunc(kpis[i][1], 24), x + 3, y + 11)
    doc.setFont('helvetica', 'normal')
  }
  y += 24

  // Spend trend table
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(28, 25, 23)
  doc.text('Spend trend — planned vs actual', M, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(68, 64, 60)
  for (const t of summary.spendTrend) {
    doc.text(
      `${t.label.padEnd(4)} planned KSh ${Math.round(t.planned).toLocaleString('en-KE')} · actual KSh ${Math.round(t.actual).toLocaleString('en-KE')} · delta ${t.actual - t.planned >= 0 ? '+' : ''}${Math.round(t.actual - t.planned).toLocaleString('en-KE')}`,
      M, y,
    )
    y += 5
    if (y > 250) { doc.addPage(); y = 20 }
  }
  y += 4

  // Phase progress
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(28, 25, 23)
  doc.text('Phases', M, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(68, 64, 60)
  for (const ph of p.phases) {
    doc.text(`${trunc(ph.name, 40)} — ${ph.status}, ${ph.progress}% · KSh ${Math.round(ph.budget).toLocaleString('en-KE')}`, M, y)
    y += 5
    if (y > 250) { doc.addPage(); y = 20 }
  }
  y += 4

  // Milestone decisions
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(28, 25, 23)
  doc.text('Milestone decisions', M, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(68, 64, 60)
  const decided = p.milestones.filter((m) => m.decidedAt)
  if (decided.length === 0) {
    doc.text('(no milestone decisions on record)', M, y)
    y += 5
  }
  for (const m of decided) {
    doc.text(`${trunc(m.name, 40)} — ${m.status} · KSh ${Math.round(m.amount).toLocaleString('en-KE')} · ${m.decidedBy ?? '—'} ${m.decidedAt ? isoDate(m.decidedAt) : ''}`, M, y)
    y += 5
    if (y > 250) { doc.addPage(); y = 20 }
  }
  y += 4

  // Open alerts
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(28, 25, 23)
  doc.text('Open alerts', M, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(68, 64, 60)
  const open = p.alerts.filter((a) => !a.acknowledged)
  if (open.length === 0) {
    doc.text('(all alerts acknowledged)', M, y)
    y += 5
  }
  for (const a of open.slice(0, 12)) {
    doc.text(`[${a.severity}] ${trunc(a.title, 58)}`, M, y)
    y += 5
    if (y > 250) { doc.addPage(); y = 20 }
  }

  // Footer
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setFontSize(7)
    doc.setTextColor(168, 162, 158)
    doc.text(`Generated from live MjengoOS project data · ${isoDate(new Date())} · page ${i} of ${pages}`, M, 292)
  }

  const filename = `${projectFilePrefix(p)}-weekly.pdf`
  doc.save(filename)
  return filename
}

// ---------------- convenience wrappers (toast at the call site) ----------------

export function downloadDailyReportCSV(p: ProjectPayload): string {
  const filename = `${projectFilePrefix(p)}-daily.csv`
  downloadCSV(filename, buildDailyReportCSV(p))
  return filename
}

export function downloadWeeklyReportCSV(p: ProjectPayload): string {
  const filename = `${projectFilePrefix(p)}-weekly.csv`
  downloadCSV(filename, buildWeeklyReportCSV(p))
  return filename
}

export function downloadFinancialReportCSV(p: ProjectPayload): string {
  const filename = `${projectFilePrefix(p)}-financial.csv`
  downloadCSV(filename, buildFinancialReportCSV(p))
  return filename
}

export function downloadProcurementReportCSV(p: ProjectPayload): string {
  const filename = `${projectFilePrefix(p)}-procurement.csv`
  downloadCSV(filename, buildProcurementReportCSV(p))
  return filename
}
