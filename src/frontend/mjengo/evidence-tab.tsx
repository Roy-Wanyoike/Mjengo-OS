'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import type { ProjectPayload } from '@/backend/lib/mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import {
  Truck, Banknote, UserCheck, Flag, FileDiff, Wallet, Camera, MessageSquare, HardHat, Receipt,
  Package, Link, ListChecks, Layers, ArrowLeftRight, Map, Bell, TriangleAlert,
  ScrollText, FileDown, CheckCheck, ShieldCheck, Loader2, Fingerprint,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'

// ---------------- Ledger kind metadata (mirrors lib/audit kindForAction values) ----------------
// `label` carries the DICT KEY (ev.kind.*) — rendered through t() at the use
// sites (the SelectItem row and the empty-state line). Unknown kinds fall
// back to the raw kind string, which t() passes through unchanged.

const KIND_META: Record<string, { label: string; Icon: LucideIcon; tint: string }> = {
  delivery: { label: 'ev.kind.delivery', Icon: Truck, tint: 'bg-stone-100 text-stone-600' },
  wage: { label: 'ev.kind.wage', Icon: Banknote, tint: 'bg-stone-100 text-stone-600' },
  attendance: { label: 'ev.kind.attendance', Icon: UserCheck, tint: 'bg-stone-100 text-stone-600' },
  milestone: { label: 'ev.kind.milestone', Icon: Flag, tint: 'bg-amber-100 text-amber-700' },
  variation: { label: 'ev.kind.variation', Icon: FileDiff, tint: 'bg-stone-100 text-stone-600' },
  escrow: { label: 'ev.kind.escrow', Icon: Wallet, tint: 'bg-amber-100 text-amber-700' },
  photo: { label: 'ev.kind.photo', Icon: Camera, tint: 'bg-stone-100 text-stone-600' },
  comment: { label: 'ev.kind.comment', Icon: MessageSquare, tint: 'bg-stone-100 text-stone-600' },
  project: { label: 'ev.kind.project', Icon: HardHat, tint: 'bg-stone-100 text-stone-600' },
  expense: { label: 'ev.kind.expense', Icon: Receipt, tint: 'bg-stone-100 text-stone-600' },
  material: { label: 'ev.kind.material', Icon: Package, tint: 'bg-stone-100 text-stone-600' },
  share: { label: 'ev.kind.share', Icon: Link, tint: 'bg-stone-100 text-stone-600' },
  task: { label: 'ev.kind.task', Icon: ListChecks, tint: 'bg-stone-100 text-stone-600' },
  phase: { label: 'ev.kind.phase', Icon: Layers, tint: 'bg-stone-100 text-stone-600' },
  transaction: { label: 'ev.kind.transaction', Icon: ArrowLeftRight, tint: 'bg-stone-100 text-stone-600' },
  site_map: { label: 'ev.kind.site_map', Icon: Map, tint: 'bg-stone-100 text-stone-600' },
  notification: { label: 'ev.kind.notification', Icon: Bell, tint: 'bg-stone-100 text-stone-600' },
  alert: { label: 'ev.kind.alert', Icon: TriangleAlert, tint: 'bg-red-100 text-red-600' },
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

// ---------------- Evidence authenticity (W6-3) ----------------

/** One advisory insight row (mirror of modules/ai/authenticity.ts view shape). */
interface InsightRow {
  id: string
  targetType: string
  targetId: string
  packId: string | null
  kind: string
  source: string
  severity: string
  confidence: string | null
  detail: Record<string, unknown>
  createdAt: string
}

interface ScreenResponse {
  ok?: boolean
  insights?: InsightRow[]
  error?: string
  outcome?: {
    ran?: boolean
    hashed?: number
    duplicateInsights?: number
    vision?: { insights?: number; skipped?: string | null }
  }
}

/** Source badge: rule-computed (dhash) vs model-computed (vision) — the labeling honesty property. */
function SourceBadge({ source, kind, confidence }: { source: string; kind: string; confidence: string | null }) {
  const t = useT()
  const isRule = source === 'dhash'
  const kindLabel =
    kind === 'duplicate' ? t('auth.badge.duplicate')
      : kind === 'phase_mismatch' ? t('auth.badge.phase')
        : kind === 'render_suspect' ? t('auth.badge.render')
          : kind
  return (
    <Badge
      variant="outline"
      className={isRule ? 'gap-1 border-stone-200 bg-stone-100 text-stone-600' : 'gap-1 border-violet-200 bg-violet-50 text-violet-700'}
    >
      <Fingerprint className="w-3 h-3" aria-hidden /> {kindLabel} · {isRule ? t('auth.badge.rule') : t('auth.badge.ai')}
      {!isRule && confidence ? ` · ${t('auth.confidence', { level: confidence })}` : ''}
    </Badge>
  )
}

/** One finding line, composed from the structured detail (deterministic, i18n'd). */
function insightText(t: ReturnType<typeof useT>, row: InsightRow): string {
  const d = row.detail ?? {}
  const distance = typeof d.hammingDistance === 'number' ? d.hammingDistance : 0
  if (row.kind === 'duplicate') {
    const match = typeof d.match === 'string' ? d.match : ''
    if (match === 'cross_pack') {
      return t('auth.dup.crossPack', {
        milestone: typeof d.matchedMilestoneName === 'string' && d.matchedMilestoneName
          ? d.matchedMilestoneName
          : t('auth.dup.priorPack'),
        distance,
      })
    }
    if (match === 'within_pack') return t('auth.dup.withinPack', { distance })
    return t('auth.dup.history', {
      photo: typeof d.matchedPhotoId === 'string' ? d.matchedPhotoId.slice(-6) : '—',
      distance,
    })
  }
  if (row.kind === 'phase_mismatch') {
    return t('auth.phase.detail', {
      shown: typeof d.phaseShown === 'string' ? d.phaseShown : 'unknown',
      claimed: typeof d.phaseClaimed === 'string' ? d.phaseClaimed : '—',
    })
  }
  if (row.kind === 'render_suspect') {
    const tells = Array.isArray(d.tells)
      ? d.tells.filter((x): x is string => typeof x === 'string')
      : typeof d.tell === 'string' ? [d.tell] : []
    return t('auth.render.detail', { tell: tells.join(' · ') || '—' })
  }
  return typeof d.observation === 'string' ? d.observation : row.kind
}

/**
 * The W6-3 evidence authenticity section — dHash duplicate flags + vision
 * phase-consistency flags over the project's evidence photos. ADVISORY ONLY
 * (the honesty band says it in both languages); the whole section rides the
 * `ai` feature flag (flag OFF → hidden, per the single-switch design), and
 * the "Run authenticity screen" button is site-team only (clients read the
 * findings — transparency for the payer, controls for the builder).
 */
function AuthenticitySection({
  projectId,
  aiFlag,
  isClient,
  photos,
}: {
  projectId: string | null
  aiFlag: boolean
  isClient: boolean
  photos: ProjectPayload['photos']
}) {
  const t = useT()
  const [rows, setRows] = useState<InsightRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRows = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/ai/authenticity-screen?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' })
      if (res.status === 403 || res.status === 401) {
        // Flag flipped off / session expired between render and fetch — the
        // section hides on the next payload; here it just stays empty.
        setRows([])
        return
      }
      const json = (await res.json()) as ScreenResponse
      if (!json.ok || !json.insights) {
        setError(json.error ?? t('auth.error'))
        return
      }
      setRows(json.insights)
    } catch {
      setError(t('auth.error'))
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  // Fetch the advisory rows once the flag is on and we have a project.
  useEffect(() => {
    if (!aiFlag || !projectId) return
    void loadRows()
  }, [aiFlag, projectId, loadRows])

  async function runScreen() {
    if (!projectId) return
    setRunning(true)
    try {
      const res = await fetch('/api/ai/authenticity-screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      const json = (await res.json()) as ScreenResponse
      if (!res.ok || !json.ok) {
        toast.error(json.error ?? t('auth.error'))
        return
      }
      setRows(json.insights ?? [])
      const outcome = json.outcome
      if (outcome?.ran) {
        toast.success(t('auth.ran', {
          hashed: outcome.hashed ?? 0,
          duplicates: outcome.duplicateInsights ?? 0,
          vision: outcome.vision?.insights ?? 0,
        }))
        const skipped = outcome.vision?.skipped
        if (skipped) toast.info(`${t('auth.ranSkipped')} (${skipped})`)
      } else {
        // Honest no-op (flag off between render and run, or no photos).
        toast.info(t('auth.emptyAfter'))
      }
    } catch {
      toast.error(t('auth.error'))
    } finally {
      setRunning(false)
    }
  }

  if (!aiFlag) return null // the single `ai` switch hides the whole section

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-stone-900">
              <Fingerprint className="w-5 h-5 text-amber-600" aria-hidden /> {t('auth.title')}
            </CardTitle>
            <CardDescription>{t('auth.desc')}</CardDescription>
          </div>
          {!isClient && projectId && (
            <Button
              size="sm"
              variant="outline"
              className="h-9 gap-1.5"
              disabled={running || loading}
              aria-label={t('auth.run')}
              onClick={() => void runScreen()}
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Fingerprint className="w-3.5 h-3.5" aria-hidden />}
              {running ? t('auth.running') : t('auth.run')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {/* The honesty band — this flag never gates anything. */}
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="note">
          {t('auth.honesty')}
        </p>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        {loading && rows === null && <p className="py-6 text-center text-sm text-stone-500">{t('auth.loading')}</p>}
        {!loading && rows !== null && rows.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" role="status">
            <ShieldCheck className="w-8 h-8 text-stone-300" aria-hidden />
            <p className="text-sm text-stone-500">{t('auth.empty')}</p>
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="max-h-96 overflow-y-auto pr-2 space-y-2 list-none" aria-label={t('auth.title')}>
            {rows.map((row) => {
              const photo = photos.find((p) => p.id === row.targetId)
              const matchedPhoto = row.kind === 'duplicate' && typeof row.detail.matchedPhotoId === 'string'
                ? photos.find((p) => p.id === row.detail.matchedPhotoId)
                : null
              const sev = row.severity === 'critical' ? 'bg-red-600' : row.severity === 'warning' ? 'bg-amber-500' : 'bg-stone-400'
              return (
                <li key={row.id} className="flex gap-3 rounded-lg border border-stone-200 bg-white p-3">
                  <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${sev}`} role="img" aria-label={`${row.severity}`} />
                  {photo ? (
                    <img
                      src={photo.url}
                      alt={photo.caption ?? t('auth.title')}
                      className="h-14 w-20 shrink-0 rounded-md border border-stone-200 object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md border border-stone-200 bg-stone-50" aria-hidden>
                      <Camera className="h-5 w-5 text-stone-300" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <SourceBadge source={row.source} kind={row.kind} confidence={row.confidence} />
                      {matchedPhoto && (
                        <span className="text-[11px] text-stone-400">{t('auth.dup.matches')}: {matchedPhoto.caption ?? matchedPhoto.id.slice(-6)}</span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-stone-700 break-words">{insightText(t, row)}</p>
                    <p className="text-[11px] text-stone-400 tabular-nums" title={format(new Date(row.createdAt), 'd MMM yyyy, HH:mm')}>
                      {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------- Component ----------------

export function EvidenceTab() {
  const { data, dispatch, actionBusy, viewMode } = useMjengo()
  const t = useT()
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
  const aiFlag = data.intel.flags.ai // W6-3: the single `ai` switch gates the authenticity section

  async function downloadPdf() {
    if (!data) return
    setPdfBusy(true)
    try {
      const filename = await generatePdfReport(data)
      setPdfOpen(false)
      toast.success(t('ev.pdf.downloaded', { file: filename }))
    } catch (e) {
      console.error('pdf failed', e)
      toast.error(t('ev.pdf.failed'))
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
                <ScrollText className="w-5 h-5 text-amber-600" aria-hidden /> {t('ev.ledger.title')}
              </CardTitle>
              <CardDescription>
                {t('ev.ledger.desc')}
              </CardDescription>
            </div>
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger size="sm" className="w-40 min-h-11" aria-label={t('ev.ledger.filterAria')}>
                <SelectValue placeholder={t('ev.ledger.allKinds')} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all" className="min-h-11">{t('ev.ledger.allKinds')}</SelectItem>
                {Object.entries(KIND_META).map(([kind, meta]) => (
                  <SelectItem key={kind} value={kind} className="min-h-11">
                    <span className="flex items-center gap-2">
                      <meta.Icon className="w-3.5 h-3.5 text-stone-500" aria-hidden /> {t(meta.label)}
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
                  ? t('ev.ledger.emptyAll')
                  : t('ev.ledger.emptyKind', { kind: t(kindMeta(kindFilter).label).toLowerCase() })}
              </p>
            </div>
          ) : (
            <ol className="relative max-h-[28rem] overflow-y-auto pr-2 space-y-0.5 list-none" aria-label={t('ev.ledger.timelineAria')}>
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

      {/* ---------- a2) Evidence authenticity (W6-3, flag-gated) ---------- */}
      <AuthenticitySection
        projectId={data.project.id}
        aiFlag={aiFlag}
        isClient={isClient}
        photos={data.photos}
      />

      {/* ---------- b) Anomaly feed ---------- */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-stone-900">
            <TriangleAlert className="w-5 h-5 text-amber-600" aria-hidden /> {t('ev.anom.title')}
          </CardTitle>
          <CardDescription>
            {t('ev.anom.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" role="status">
              <ShieldCheck className="w-8 h-8 text-stone-300" aria-hidden />
              <p className="text-sm text-stone-500">{t('ev.anom.empty')}</p>
            </div>
          ) : (
            <ul className="max-h-96 overflow-y-auto pr-2 space-y-2 list-none" aria-label={t('ev.anom.listAria')}>
              {alerts.map((a) => (
                <li
                  key={a.id}
                  className={`flex gap-3 rounded-lg border p-3 transition-colors ${a.acknowledged ? 'border-stone-100 bg-stone-50/60 opacity-70' : 'border-stone-200 bg-white hover:border-stone-300'}`}
                >
                  <span
                    className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${a.severity === 'critical' ? 'bg-red-600' : a.severity === 'warning' ? 'bg-amber-500' : 'bg-stone-400'}`}
                    role="img"
                    aria-label={t('ev.anom.severityAria', { sev: a.severity })}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm font-medium ${a.acknowledged ? 'text-stone-500' : 'text-stone-900'}`}>{a.title}</p>
                      {a.acknowledged && (
                        <Badge variant="outline" className="gap-1 border-stone-200 bg-stone-100 text-stone-500">
                          <CheckCheck className="w-3 h-3" aria-hidden /> {t('ev.anom.ackd')}
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
                          aria-label={t('ev.anom.ackAria', { title: a.title })}
                          onClick={() => void dispatch('alert.ack', { id: a.id }, 'Acknowledge alert')}
                        >
                          <CheckCheck className="w-3.5 h-3.5" aria-hidden /> {t('ev.anom.ack')}
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
            <FileDown className="w-5 h-5 text-amber-600" aria-hidden /> {t('ev.pdf.title')}
          </CardTitle>
          <CardDescription>
            {t('ev.pdf.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="h-11 gap-2 bg-amber-600 text-white hover:bg-amber-700"
            onClick={() => setPdfOpen(true)}
            aria-label={t('ev.pdf.generateAria')}
          >
            <FileDown className="w-4 h-4" aria-hidden /> {t('ev.pdf.generate')}
          </Button>

          <Dialog open={pdfOpen} onOpenChange={setPdfOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-stone-900">{t('ev.pdf.previewTitle')}</DialogTitle>
                <DialogDescription>
                  {t('ev.pdf.previewDesc')}
                </DialogDescription>
              </DialogHeader>
              <ul className="space-y-2 text-sm text-stone-600 list-none" aria-label={t('ev.pdf.contentsAria')}>
                {[
                  t('ev.pdf.itemHeader'),
                  t('ev.pdf.itemKpi'),
                  t('ev.pdf.itemPhases'),
                  t('ev.pdf.itemMaterials'),
                  t('ev.pdf.itemTransactions'),
                  t('ev.pdf.itemFooter'),
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <CheckCheck className="mt-0.5 w-4 h-4 shrink-0 text-amber-600" aria-hidden /> {line}
                  </li>
                ))}
              </ul>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="outline" className="min-h-11" onClick={() => setPdfOpen(false)}>{t('ev.pdf.cancel')}</Button>
                <Button className="min-h-11 gap-2 bg-amber-600 text-white hover:bg-amber-700" disabled={pdfBusy} onClick={() => void downloadPdf()}>
                  {pdfBusy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <FileDown className="w-4 h-4" aria-hidden />}
                  {pdfBusy ? t('ev.pdf.building') : t('ev.pdf.download')}
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
