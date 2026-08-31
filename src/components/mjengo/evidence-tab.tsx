'use client'

import { useMemo, useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import { useMjengo } from '@/hooks/use-mjengo'
import type { ProjectPayload } from '@/lib/mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Truck, Banknote, UserCheck, Flag, FileDiff, Wallet, Camera, MessageSquare, HardHat, Receipt,
  Package, Link, ListChecks, Layers, ArrowLeftRight, Map, Bell, TriangleAlert,
  ScrollText, FileDown, CheckCheck, ShieldCheck, Loader2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/lib/format'

// ---------------- Ledger kind metadata (mirrors lib/audit kindForAction values) ----------------

const KIND_META: Record<string, { label: string; Icon: LucideIcon; tint: string }> = {
  delivery: { label: 'Deliveries', Icon: Truck, tint: 'bg-stone-100 text-stone-600' },
  wage: { label: 'Wages', Icon: Banknote, tint: 'bg-stone-100 text-stone-600' },
  attendance: { label: 'Attendance', Icon: UserCheck, tint: 'bg-stone-100 text-stone-600' },
  milestone: { label: 'Milestones', Icon: Flag, tint: 'bg-amber-100 text-amber-700' },
  variation: { label: 'Variations', Icon: FileDiff, tint: 'bg-stone-100 text-stone-600' },
  escrow: { label: 'Escrow', Icon: Wallet, tint: 'bg-amber-100 text-amber-700' },
  photo: { label: 'Photos', Icon: Camera, tint: 'bg-stone-100 text-stone-600' },
  comment: { label: 'Comments', Icon: MessageSquare, tint: 'bg-stone-100 text-stone-600' },
  project: { label: 'Project', Icon: HardHat, tint: 'bg-stone-100 text-stone-600' },
  expense: { label: 'Expenses', Icon: Receipt, tint: 'bg-stone-100 text-stone-600' },
  material: { label: 'Materials', Icon: Package, tint: 'bg-stone-100 text-stone-600' },
  share: { label: 'Share links', Icon: Link, tint: 'bg-stone-100 text-stone-600' },
  task: { label: 'Tasks', Icon: ListChecks, tint: 'bg-stone-100 text-stone-600' },
  phase: { label: 'Phases', Icon: Layers, tint: 'bg-stone-100 text-stone-600' },
  transaction: { label: 'Transactions', Icon: ArrowLeftRight, tint: 'bg-stone-100 text-stone-600' },
  site_map: { label: 'Site map', Icon: Map, tint: 'bg-stone-100 text-stone-600' },
  notification: { label: 'Notifications', Icon: Bell, tint: 'bg-stone-100 text-stone-600' },
  alert: { label: 'Alerts', Icon: TriangleAlert, tint: 'bg-red-100 text-red-600' },
}

function kindMeta(kind: string) {
  return KIND_META[kind] ?? { label: kind, Icon: ScrollText, tint: 'bg-stone-100 text-stone-600' }
}

function RoleChip({ role }: { role: string }) {
  const r = (role ?? '').toLowerCase()
  if (r === 'client') {
    return <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">client</span>
  }
  if (r === 'foreman') {
    return <span className="inline-flex items-center rounded-full bg-stone-600 px-1.5 py-0.5 text-[10px] font-medium text-stone-50">foreman</span>
  }
  if (r === 'system' || r === 'ai') {
    return <span className="inline-flex items-center rounded-full bg-stone-200 px-1.5 py-0.5 text-[10px] font-medium italic text-stone-500">{r === 'ai' ? 'ai' : 'system'}</span>
  }
  return <span className="inline-flex items-center rounded-full bg-stone-800 px-1.5 py-0.5 text-[10px] font-medium text-stone-50">contractor</span>
}

const SCROLLBAR = '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

// ---------------- PDF report ----------------

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Builds the A4 one-click PDF report. Returns the filename saved. */
async function generatePdfReport(data: ProjectPayload): Promise<string> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const { project, summary, phases, materials, transactions } = data
  const M = 14 // margin
  const W = 210
  const contentW = W - M * 2

  // Header band
  doc.setFillColor(28, 25, 23)
  doc.rect(0, 0, W, 26, 'F')
  doc.setFillColor(245, 158, 11)
  doc.rect(0, 26, W, 1.5, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('MjengoOS', M, 12)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(231, 229, 228)
  doc.text(trunc(project.name, 60), M, 19.5)

  // Subheader
  let y = 36
  doc.setTextColor(120, 113, 108)
  doc.setFontSize(9)
  doc.text(
    `${trunc(project.client, 48)} · ${trunc(project.location, 48)}`,
    M, y,
  )
  doc.text(
    `Status: ${project.status}  ·  Day ${summary.dayCount} of build  ·  ${summary.progressPct}% complete`,
    M, y + 5,
  )
  y += 14

  // KPI grid (4 cells)
  const cellW = (contentW - 3 * 4) / 4
  const kpis: Array<[string, string, string]> = [
    ['BUDGET', `KSh ${Math.round(summary.budgetSpent / 1000)}K / ${Math.round(summary.budgetTotal / 100000) / 10}M`, `${summary.budgetSpentPct}% spent`],
    ['SPEND VS PLAN', `${summary.spendVsPlanDelta >= 0 ? '+' : ''}${summary.spendVsPlanDelta}%`, summary.spendVsPlanDelta > 0 ? 'above plan' : 'on / under plan'],
    ['FUNDIS TODAY', `${summary.fundisToday}`, `${summary.fundisVerified} verified on site`],
    ['UNACKED ALERTS', `${summary.unackedAlerts}`, summary.unackedAlerts ? 'needs attention' : 'all clear'],
  ]
  for (let i = 0; i < 4; i++) {
    const x = M + i * (cellW + 4)
    doc.setDrawColor(214, 211, 209)
    doc.setFillColor(250, 250, 249)
    doc.roundedRect(x, y, cellW, 18, 1.5, 1.5, 'FD')
    doc.setFontSize(6.5)
    doc.setTextColor(120, 113, 108)
    doc.text(kpis[i][0], x + 3, y + 5.5)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10.5)
    doc.setTextColor(28, 25, 23)
    doc.text(kpis[i][1], x + 3, y + 11.5)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(120, 113, 108)
    doc.text(kpis[i][2], x + 3, y + 15.5)
  }
  y += 26

  const ensure = (needed: number) => {
    if (y + needed > 278) {
      doc.addPage()
      y = 18
    }
  }

  const tableHeader = (cols: Array<[string, number]>, title: string) => {
    ensure(16)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(28, 25, 23)
    doc.text(title, M, y)
    y += 5.5
    doc.setFillColor(231, 229, 228)
    doc.rect(M, y, contentW, 6.5, 'F')
    doc.setFontSize(7)
    doc.setTextColor(68, 64, 60)
    let x = M + 2
    for (const [label, w] of cols) {
      doc.text(label.toUpperCase(), x, y + 4.3)
      x += w
    }
    y += 6.5
  }

  const row = (cols: Array<[string, number]>, i: number) => {
    ensure(6)
    if (i % 2 === 1) {
      doc.setFillColor(250, 250, 249)
      doc.rect(M, y, contentW, 6, 'F')
    }
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(41, 37, 36)
    let x = M + 2
    for (const [text, w] of cols) {
      doc.text(trunc(text, Math.max(4, Math.floor(w / 1.55))), x, y + 4.2)
      x += w
    }
    y += 6
  }

  // Phases
  tableHeader([['Phase', 78], ['Status', 30], ['Progress', 30], ['Budget (KSh)', 40]], 'Build phases')
  phases.forEach((p, i) => {
    row([[p.name, 78], [p.status.replace('_', ' '), 30], [`${p.progress}%`, 30], [p.budget.toLocaleString('en-KE'), 40]], i)
  })
  y += 6

  // Materials on site
  const onSite = materials.filter((m) => m.onSiteQty > 0)
  tableHeader([['Material', 90], ['On site', 46], ['Stock value (KSh)', 42]], 'Materials on site')
  if (!onSite.length) {
    doc.setFontSize(7.5); doc.setTextColor(120, 113, 108); doc.text('No materials currently on site.', M + 2, y + 4.2); y += 6
  }
  onSite.forEach((m, i) => {
    row([[m.name, 90], [`${m.onSiteQty} ${m.unit}`, 46], [Math.round(m.stockValue).toLocaleString('en-KE'), 42]], i)
  })
  y += 6

  // Recent transactions (last 15)
  tableHeader([['Date', 24], ['Type', 22], ['Amount (KSh)', 30], ['Note', 102]], 'Recent transactions (last 15)')
  transactions.slice(0, 15).forEach((t, i) => {
    row([
      [format(new Date(t.date), 'd MMM yyyy'), 24],
      [t.type, 22],
      [Math.round(t.amount).toLocaleString('en-KE'), 30],
      [t.note ?? '', 102],
    ], i)
  })

  // Footer + page numbers on every page
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setDrawColor(214, 211, 209)
    doc.line(M, 285, W - M, 285)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(120, 113, 108)
    doc.text(`Generated by MjengoOS · ${format(new Date(), 'd MMM yyyy')} · Bias-free ledger available in-app`, W / 2, 290, { align: 'center' })
    doc.text(`Page ${p} of ${pages}`, W - M, 290, { align: 'right' })
  }

  const filename = `mjengo-${slugify(project.name)}-report-${new Date().toISOString().slice(0, 10)}.pdf`
  doc.save(filename)
  return filename
}

// ---------------- Component ----------------

export function EvidenceTab() {
  const { data, dispatch, actionBusy, viewMode } = useMjengo()
  const [kindFilter, setKindFilter] = useState<string>('all')
  const [pdfOpen, setPdfOpen] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)

  const events = useMemo(() => {
    if (!data) return []
    return kindFilter === 'all' ? data.auditEvents : data.auditEvents.filter((e) => e.kind === kindFilter)
  }, [data, kindFilter])

  if (!data) return null
  const alerts = data.alerts
  const busy = actionBusy !== null
  const isClient = viewMode === 'client' // clients see the ledger + anomalies; PDF/ack are site-team tools

  async function downloadPdf() {
    if (!data) return
    setPdfBusy(true)
    try {
      const filename = await generatePdfReport(data)
      setPdfOpen(false)
      toast.success(`${filename} downloaded`)
    } catch (e) {
      console.error('pdf failed', e)
      toast.error('Could not generate the PDF report')
    } finally {
      setPdfBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* ---------- a) Bias-Free Ledger ---------- */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-stone-900">
                <ScrollText className="w-5 h-5 text-amber-600" aria-hidden /> Bias-Free Ledger
              </CardTitle>
              <CardDescription>
                Chronological, append-only record of every action — who, what, when. Records can never be edited or erased.
              </CardDescription>
            </div>
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger size="sm" className="w-40 min-h-11" aria-label="Filter ledger by record kind">
                <SelectValue placeholder="All kinds" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all" className="min-h-11">All kinds</SelectItem>
                {Object.entries(KIND_META).map(([kind, meta]) => (
                  <SelectItem key={kind} value={kind} className="min-h-11">
                    <span className="flex items-center gap-2">
                      <meta.Icon className="w-3.5 h-3.5 text-stone-500" aria-hidden /> {meta.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" role="status">
              <ScrollText className="w-8 h-8 text-stone-300" aria-hidden />
              <p className="text-sm text-stone-500">
                {kindFilter === 'all'
                  ? 'No ledger records yet — every action on this project will appear here.'
                  : `No ${kindMeta(kindFilter).label.toLowerCase()} records in the ledger.`}
              </p>
            </div>
          ) : (
            <ol className="relative max-h-[28rem] overflow-y-auto pr-2 space-y-0.5 list-none" aria-label="Audit trail timeline">
              {events.map((e, i) => {
                const meta = kindMeta(e.kind)
                return (
                  <li key={e.id} className="relative flex gap-3 rounded-lg hover:bg-stone-50 transition-colors px-2 py-2.5">
                    <span aria-hidden className={`absolute left-[27px] top-12 bottom-0 w-px bg-stone-200 ${i === events.length - 1 ? 'hidden' : ''}`} />
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${meta.tint}`} aria-hidden>
                      <meta.Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium text-stone-900">{e.actor}</span>
                        <RoleChip role={e.role} />
                        <span className="text-[11px] text-stone-400" title={format(new Date(e.createdAt), 'd MMM yyyy, HH:mm')}>
                          {formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-sm text-stone-600 break-words">{e.summary}</p>
                      <p className="text-[11px] text-stone-400 tabular-nums">{format(new Date(e.createdAt), 'd MMM yyyy · HH:mm')}</p>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* ---------- b) Anomaly feed ---------- */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-stone-900">
            <TriangleAlert className="w-5 h-5 text-amber-600" aria-hidden /> Anomaly feed
          </CardTitle>
          <CardDescription>
            Discrepancies flagged between what was paid, delivered, and seen on site. Acknowledge once reviewed with the crew.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" role="status">
              <ShieldCheck className="w-8 h-8 text-stone-300" aria-hidden />
              <p className="text-sm text-stone-500">No anomalies — site activity matches the record</p>
            </div>
          ) : (
            <ul className="max-h-96 overflow-y-auto pr-2 space-y-2 list-none" aria-label="Anomaly alerts">
              {alerts.map((a) => (
                <li
                  key={a.id}
                  className={`flex gap-3 rounded-lg border p-3 transition-colors ${a.acknowledged ? 'border-stone-100 bg-stone-50/60 opacity-70' : 'border-stone-200 bg-white hover:border-stone-300'}`}
                >
                  <span
                    className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${a.severity === 'critical' ? 'bg-red-600' : a.severity === 'warning' ? 'bg-amber-500' : 'bg-stone-400'}`}
                    role="img"
                    aria-label={`${a.severity} severity`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm font-medium ${a.acknowledged ? 'text-stone-500' : 'text-stone-900'}`}>{a.title}</p>
                      {a.acknowledged && (
                        <Badge variant="outline" className="gap-1 border-stone-200 bg-stone-100 text-stone-500">
                          <CheckCheck className="w-3 h-3" aria-hidden /> Ack&rsquo;d
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-stone-500 break-words">{a.message}</p>
                    <div className="mt-1.5 flex items-center gap-3">
                      <span className="text-[11px] text-stone-400" title={format(new Date(a.createdAt), 'd MMM yyyy, HH:mm')}>
                        {formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}
                      </span>
                      {!a.acknowledged && !isClient && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5"
                          disabled={busy}
                          aria-label={`Acknowledge alert: ${a.title}`}
                          onClick={() => void dispatch('alert.ack', { id: a.id }, 'Acknowledge alert')}
                        >
                          <CheckCheck className="w-3.5 h-3.5" aria-hidden /> Acknowledge
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ---------- c) PDF report (site team only — clients get it via WhatsApp) ---------- */}
      {!isClient && (
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-stone-900">
            <FileDown className="w-5 h-5 text-amber-600" aria-hidden /> One-click PDF report
          </CardTitle>
          <CardDescription>
            A shareable A4 snapshot of the build — perfect for the WhatsApp group, the bank, or the family.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="h-11 gap-2 bg-amber-600 text-white hover:bg-amber-700"
            onClick={() => setPdfOpen(true)}
            aria-label="Generate PDF report"
          >
            <FileDown className="w-4 h-4" aria-hidden /> Generate PDF report
          </Button>

          <Dialog open={pdfOpen} onOpenChange={setPdfOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-stone-900">PDF report preview</DialogTitle>
                <DialogDescription>
                  The report is generated from the live project record — nothing is hand-edited.
                </DialogDescription>
              </DialogHeader>
              <ul className="space-y-2 text-sm text-stone-600 list-none" aria-label="Report contents">
                {[
                  'Header with project, client, location and day count',
                  'KPI grid — budget, spend vs plan, fundis verified, alerts',
                  'Build phases — status, progress and budget',
                  'Materials on site — quantities and stock value',
                  'Last 15 transactions with notes',
                  'Dated footer with page numbers (bias-free ledger stays in-app)',
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <CheckCheck className="mt-0.5 w-4 h-4 shrink-0 text-amber-600" aria-hidden /> {line}
                  </li>
                ))}
              </ul>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" className="min-h-11" onClick={() => setPdfOpen(false)}>Cancel</Button>
                <Button className="min-h-11 gap-2 bg-amber-600 text-white hover:bg-amber-700" disabled={pdfBusy} onClick={() => void downloadPdf()}>
                  {pdfBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <FileDown className="w-4 h-4" aria-hidden />}
                  {pdfBusy ? 'Building…' : 'Download PDF'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
      )}
    </div>
  )
}
