'use client'

// Report builders (spec §49 reporting + §79 export) — pure functions over the
// live ProjectPayload: 4 CSV variants (daily / weekly / financial /
// procurement) plus a Weekly PDF. Every row comes from real project data and
// each file opens with an honest generated-at stamp — no fabricated facts.
//
// ISSUE #125: report CONTENT honors the active locale — every builder takes
// the caller's t() (useT from the rendering component) and all header/label
// copy flows through the report.* dict family (en + sw). Data rows stay
// verbatim (names, enum values from the DB, notes) — only presentation copy
// translates. Filenames stay ASCII/English on purpose (download portability).
//
// CSV serialization reuses the RFC-4180 helpers from export-utils.ts (shared,
// unchanged). The A4 PDF helper block is deliberately duplicated from
// evidence-tab.tsx (per ownership: no cross-import) — same 20 lines, same look.

import type { ProjectPayload } from '@/backend/lib/mjengo'
import type { TranslateFn } from '@/frontend/i18n/types'
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
function reportHeader(t: TranslateFn, title: string, p: ProjectPayload): CSVRow[] {
  return [
    { A: title, B: '', C: '', D: '', E: '', F: '', G: '', H: '' },
    { A: t('report.h.project', { name: p.project.name }), B: t('report.h.client', { client: p.project.client }), C: t('report.h.location', { location: p.project.location }), D: '', E: '', F: '', G: '', H: '' },
    { A: t('report.h.generated', { stamp: isoDateTime(new Date()), day: p.summary.dayCount }), B: '', C: '', D: '', E: '', F: '', G: '', H: '' },
    { A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' },
  ]
}

// ---------------- Daily report (attendance · movements · transactions today) ----------------

export function buildDailyReportCSV(t: TranslateFn, p: ProjectPayload): string {
  const rows: CSVRow[] = reportHeader(t, t('report.daily.title'), p)

  rows.push({ A: t('report.daily.attendance'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.daily.col.worker'), B: t('report.daily.col.role'), C: t('report.daily.col.status'), D: t('report.daily.col.wage'), E: t('report.daily.col.paid'), F: '', G: '', H: '' })
  for (const w of p.workers) {
    rows.push({
      A: w.name, B: w.role, C: w.todayStatus.status ?? '—',
      D: Math.round(w.todayStatus.wage), E: w.todayStatus.paid ? t('report.yes') : t('report.no'),
      F: '', G: '', H: '',
    })
  }

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.daily.movements'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.daily.col.material'), B: t('report.daily.col.movement'), C: t('report.daily.col.qty'), D: t('report.daily.col.unit'), E: t('report.daily.col.reference'), F: t('report.daily.col.recordedBy'), G: '', H: '' })
  const movementsToday = p.inventory.movements.filter((m) => isToday(m.createdAt))
  for (const m of movementsToday) {
    rows.push({ A: m.materialName, B: m.type, C: m.quantity, D: m.unit, E: m.reference ?? '—', F: m.recordedBy, G: '', H: '' })
  }
  if (movementsToday.length === 0) rows.push({ A: t('report.daily.noMovements'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.daily.transactions'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.daily.col.type'), B: t('report.daily.col.amount'), C: t('report.daily.col.method'), D: t('report.daily.col.reference'), E: t('report.daily.col.note'), F: '', G: '', H: '' })
  const txToday = p.transactions.filter((tr) => isToday(tr.date))
  for (const tr of txToday) {
    rows.push({ A: tr.type, B: Math.round(tr.amount), C: tr.method, D: tr.reference ?? '—', E: tr.note ?? '', F: '', G: '', H: '' })
  }
  if (txToday.length === 0) rows.push({ A: t('report.daily.noTransactions'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.daily.crewLine', { today: p.summary.fundisToday, expected: p.summary.fundisExpected, wages: Math.round(p.summary.wagesToday), alerts: p.summary.unackedAlerts }), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  return toCSV(rows)
}

// ---------------- Weekly report (spend trend · milestones decided · alerts) ----------------

export function buildWeeklyReportCSV(t: TranslateFn, p: ProjectPayload): string {
  const rows: CSVRow[] = reportHeader(t, t('report.weekly.title'), p)

  rows.push({ A: t('report.weekly.spendTrend'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.weekly.col.week'), B: t('report.weekly.col.planned'), C: t('report.weekly.col.actual'), D: t('report.weekly.col.delta'), E: '', F: '', G: '', H: '' })
  for (const tr of p.summary.spendTrend) {
    rows.push({ A: tr.label, B: Math.round(tr.planned), C: Math.round(tr.actual), D: Math.round(tr.actual - tr.planned), E: '', F: '', G: '', H: '' })
  }

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.weekly.milestones'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.weekly.col.milestone'), B: t('report.weekly.col.amount'), C: t('report.weekly.col.status'), D: t('report.weekly.col.decidedBy'), E: t('report.weekly.col.decidedAt'), F: '', G: '', H: '' })
  const decided = p.milestones.filter((m) => m.decidedAt)
  for (const m of decided) {
    rows.push({ A: m.name, B: Math.round(m.amount), C: m.status, D: m.decidedBy ?? '—', E: isoDate(m.decidedAt as Date), F: '', G: '', H: '' })
  }
  if (decided.length === 0) rows.push({ A: t('report.weekly.noMilestones'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.weekly.alerts'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.weekly.col.severity'), B: t('report.weekly.col.title'), C: t('report.weekly.col.acknowledged'), D: t('report.weekly.col.created'), E: '', F: '', G: '', H: '' })
  for (const a of p.alerts.slice(0, 20)) {
    rows.push({ A: a.severity, B: a.title, C: a.acknowledged ? t('report.yes') : t('report.no'), D: isoDate(a.createdAt), E: '', F: '', G: '', H: '' })
  }

  return toCSV(rows)
}

// ---------------- Financial report (budget lines · ledger · escrow) ----------------

export function buildFinancialReportCSV(t: TranslateFn, p: ProjectPayload): string {
  const rows: CSVRow[] = reportHeader(t, t('report.financial.title'), p)

  rows.push({ A: t('report.financial.budgetLines'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.financial.col.phase'), B: t('report.financial.col.budget'), C: t('report.financial.col.progress'), D: t('report.financial.col.status'), E: '', F: '', G: '', H: '' })
  for (const ph of p.phases) {
    rows.push({ A: ph.name, B: Math.round(ph.budget), C: ph.progress, D: ph.status, E: '', F: '', G: '', H: '' })
  }
  rows.push({ A: t('report.financial.total'), B: Math.round(p.summary.budgetTotal), C: p.summary.progressPct, D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.financial.ledger'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.financial.col.ref'), B: t('report.financial.col.description'), C: t('report.financial.col.occurred'), D: t('report.financial.col.status'), E: t('report.financial.col.postedBy'), F: t('report.financial.col.total'), G: '', H: '' })
  for (const lt of p.finance.ledger.transactions) {
    rows.push({ A: lt.ref, B: lt.description, C: isoDate(lt.occurredAt), D: lt.status, E: `${lt.postedBy} (${lt.postedRole})`, F: Math.round(lt.total), G: '', H: '' })
  }
  if (p.finance.ledger.transactions.length === 0) rows.push({ A: t('report.financial.noLedger'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.financial.escrow'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({
    A: t('report.financial.balance'), B: p.escrow ? Math.round(p.escrow.balance) : 0,
    C: t('report.financial.committed'), D: Math.round(p.finance.committed),
    E: t('report.financial.remainingAfter'), F: Math.round(p.finance.remaining),
    G: '', H: '',
  })

  return toCSV(rows)
}

// ---------------- Procurement report (requests · POs · discrepancies) ----------------

export function buildProcurementReportCSV(t: TranslateFn, p: ProjectPayload): string {
  const rows: CSVRow[] = reportHeader(t, t('report.procurement.title'), p)

  rows.push({ A: t('report.procurement.requests'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.procurement.col.request'), B: t('report.procurement.col.status'), C: t('report.procurement.col.lines'), D: t('report.procurement.col.created'), E: '', F: '', G: '', H: '' })
  for (const r of p.supply.requests) {
    rows.push({ A: r.requestCode, B: r.status, C: r.lines.length, D: isoDate(r.createdAt), E: '', F: '', G: '', H: '' })
  }

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.procurement.orders'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.procurement.col.order'), B: t('report.procurement.col.supplier'), C: t('report.procurement.col.status'), D: t('report.procurement.col.subtotal'), E: t('report.procurement.col.deliveryFee'), F: t('report.procurement.col.total'), G: '', H: '' })
  for (const o of p.supply.orders) {
    rows.push({ A: o.orderCode, B: o.supplierName, C: o.status, D: Math.round(o.subtotal), E: Math.round(o.deliveryFee), F: Math.round(o.total), G: '', H: '' })
  }

  rows.push({ A: '', B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.procurement.discrepancies'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })
  rows.push({ A: t('report.procurement.col.order'), B: t('report.procurement.col.line'), C: t('report.procurement.col.ordered'), D: t('report.procurement.col.received'), E: t('report.procurement.col.short'), F: t('report.procurement.col.evidencePhotos'), G: '', H: '' })
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
            B: lineNames.get(l.orderLineId) ?? t('report.procurement.lineFallback', { id: l.orderLineId }),
            C: l.qtyOrdered,
            D: l.qtyReceived,
            E: Math.round(l.qtyOrdered - l.qtyReceived),
            F: photoCount > 0 ? (photoCount === 1 ? t('report.procurement.photoOne', { count: photoCount }) : t('report.procurement.photoMany', { count: photoCount })) : '',
            G: '',
            H: '',
          })
        }
      }
    }
  }
  if (discrepancies === 0) rows.push({ A: t('report.procurement.noDiscrepancies'), B: '', C: '', D: '', E: '', F: '', G: '', H: '' })

  return toCSV(rows)
}

// ---------------- Weekly PDF (jsPDF — A4 helpers duplicated from evidence-tab) ----------------

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Builds the A4 weekly PDF and triggers the browser download. Returns the filename. */
export async function downloadWeeklyReportPDF(t: TranslateFn, p: ProjectPayload): Promise<string> {
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
  doc.text(t('report.weekly.title'), M, 12)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(231, 229, 228)
  doc.text(trunc(project.name, 60), M, 19.5)

  let y = 36
  doc.setTextColor(120, 113, 108)
  doc.setFontSize(9)
  doc.text(`${trunc(project.client, 48)} · ${trunc(project.location, 48)}`, M, y)
  doc.text(
    t('report.pdf.generated', { stamp: isoDateTime(new Date()), day: summary.dayCount, pct: summary.progressPct }),
    M, y + 5,
  )
  y += 14

  // KPI row
  const kpis: Array<[string, string]> = [
    [t('report.pdf.kpiBudget'), `KSh ${Math.round(summary.budgetSpent).toLocaleString('en-KE')} / ${Math.round(summary.budgetTotal).toLocaleString('en-KE')}`],
    [t('report.pdf.kpiSpendVsPlan'), `${summary.spendVsPlanDelta >= 0 ? '+' : ''}${summary.spendVsPlanDelta}%`],
    [t('report.pdf.kpiCrew'), `${summary.fundisToday}/${summary.fundisExpected}`],
    [t('report.pdf.kpiAlerts'), `${summary.unackedAlerts}`],
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
  doc.text(t('report.pdf.spendTrend'), M, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(68, 64, 60)
  for (const tr of summary.spendTrend) {
    doc.text(
      t('report.pdf.trendLine', {
        week: tr.label.padEnd(4),
        planned: Math.round(tr.planned).toLocaleString('en-KE'),
        actual: Math.round(tr.actual).toLocaleString('en-KE'),
        delta: `${tr.actual - tr.planned >= 0 ? '+' : ''}${Math.round(tr.actual - tr.planned).toLocaleString('en-KE')}`,
      }),
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
  doc.text(t('report.pdf.phases'), M, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(68, 64, 60)
  for (const ph of p.phases) {
    doc.text(t('report.pdf.phaseLine', { name: trunc(ph.name, 40), status: ph.status, progress: ph.progress, budget: Math.round(ph.budget).toLocaleString('en-KE') }), M, y)
    y += 5
    if (y > 250) { doc.addPage(); y = 20 }
  }
  y += 4

  // Milestone decisions
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(28, 25, 23)
  doc.text(t('report.pdf.milestones'), M, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(68, 64, 60)
  const decided = p.milestones.filter((m) => m.decidedAt)
  if (decided.length === 0) {
    doc.text(t('report.weekly.noMilestones'), M, y)
    y += 5
  }
  for (const m of decided) {
    doc.text(t('report.pdf.milestoneLine', { name: trunc(m.name, 40), status: m.status, amount: Math.round(m.amount).toLocaleString('en-KE'), by: m.decidedBy ?? '—', date: m.decidedAt ? isoDate(m.decidedAt) : '' }), M, y)
    y += 5
    if (y > 250) { doc.addPage(); y = 20 }
  }
  y += 4

  // Open alerts
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(28, 25, 23)
  doc.text(t('report.pdf.alerts'), M, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(68, 64, 60)
  const open = p.alerts.filter((a) => !a.acknowledged)
  if (open.length === 0) {
    doc.text(t('report.pdf.allAcknowledged'), M, y)
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
    doc.text(t('report.pdf.footer', { date: isoDate(new Date()), page: i, pages }), M, 292)
  }

  const filename = `${projectFilePrefix(p)}-weekly.pdf`
  doc.save(filename)
  return filename
}

// ---------------- convenience wrappers (toast at the call site) ----------------

export function downloadDailyReportCSV(t: TranslateFn, p: ProjectPayload): string {
  const filename = `${projectFilePrefix(p)}-daily.csv`
  downloadCSV(filename, buildDailyReportCSV(t, p))
  return filename
}

export function downloadWeeklyReportCSV(t: TranslateFn, p: ProjectPayload): string {
  const filename = `${projectFilePrefix(p)}-weekly.csv`
  downloadCSV(filename, buildWeeklyReportCSV(t, p))
  return filename
}

export function downloadFinancialReportCSV(t: TranslateFn, p: ProjectPayload): string {
  const filename = `${projectFilePrefix(p)}-financial.csv`
  downloadCSV(filename, buildFinancialReportCSV(t, p))
  return filename
}

export function downloadProcurementReportCSV(t: TranslateFn, p: ProjectPayload): string {
  const filename = `${projectFilePrefix(p)}-procurement.csv`
  downloadCSV(filename, buildProcurementReportCSV(t, p))
  return filename
}
