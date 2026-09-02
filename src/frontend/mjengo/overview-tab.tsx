'use client'

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Progress } from '@/frontend/ui/progress'
import { ScrollArea } from '@/frontend/ui/scroll-area'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/frontend/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/frontend/ui/dropdown-menu'
import { ExpenseDialog, type ExpenseDialogPayload } from '@/frontend/mjengo/expense-dialog'
import { TimelapseCard } from '@/frontend/mjengo/timelapse-card'
import { SiteMapCard } from '@/frontend/mjengo/site-map-card'
import { CommentThread } from '@/frontend/mjengo/photo-comments'
import {
  downloadCSV, materialsLedgerCSV, attendanceCSV, transactionsCSV, projectSummaryCSV, projectFilePrefix,
} from '@/frontend/mjengo/export-utils'
import {
  downloadDailyReportCSV, downloadWeeklyReportCSV, downloadFinancialReportCSV,
  downloadProcurementReportCSV, downloadWeeklyReportPDF,
} from '@/frontend/mjengo/report-utils'
import { HEALTH_INPUTS, type HealthSnapshot } from '@/backend/modules/intel/types'
import { useT } from '@/frontend/i18n/provider'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  AlertTriangle, TrendingUp, Users, Wallet, Camera, MessageSquareText, ShieldAlert,
  TriangleAlert, Info, CheckCircle2, Sparkles, Send, CalendarDays, MapPin, RefreshCw,
  Download, ReceiptText, HeartPulse, FileDown, ChevronDown, FileText,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatKES, dateShort } from '@/frontend/lib/format'
import { usePermissions } from '@/shared/permissions'
import { BudgetVarianceCard } from '@/frontend/mjengo/overview/variance-card'
import { ActivityTimeline } from '@/frontend/mjengo/overview/timeline'
import {
  QsBudgetCard, FinanceSnapshotCard, SystemHealthCard,
} from '@/frontend/mjengo/overview/role-cards'

 

interface PhotoAnalysis {
  summary?: string
  phaseShown?: string
  progressPct?: number
  observations?: string[]
  safety?: Array<{ issue: string; severity: string }>
  materialsVisible?: Array<{ name: string; roughQty: string }>
  qualityFlags?: string[]
  confidence?: number
}

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === 'critical') return <TriangleAlert className="w-4 h-4 text-red-600" aria-hidden />
  if (severity === 'warning') return <AlertTriangle className="w-4 h-4 text-amber-600" aria-hidden />
  return <Info className="w-4 h-4 text-stone-400" aria-hidden />
}

// ---------------- Project health card (spec §48, F-INSIGHT) ----------------

const GRADE_META: Record<string, { labelKey: string; chip: string; bar: string }> = {
  good: { labelKey: 'overview.grade.good', chip: 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-0', bar: 'bg-emerald-600' },
  attention: { labelKey: 'overview.grade.attention', chip: 'bg-amber-100 text-amber-800 hover:bg-amber-100 border-0', bar: 'bg-amber-500' },
  poor: { labelKey: 'overview.grade.poor', chip: 'bg-red-100 text-red-700 hover:bg-red-100 border-0', bar: 'bg-red-500' },
}

/**
 * Transparent health score — overall out of 100 prominent, six dimension bars
 * with grade chips and one-line summaries citing the real numbers, plus an
 * expandable "How this is computed" section (never an unexplained score).
 * Renders for BOTH roles (owner + client view).
 */
function HealthCard({ health }: { health: HealthSnapshot | null }) {
  const [showHow, setShowHow] = useState(false)
  const t = useT()

  if (!health) {
    return (
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <HeartPulse className="h-5 w-5 text-amber-600" aria-hidden /> {t('overview.health.title')}
          </CardTitle>
          <CardDescription>{t('overview.health.loading')}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const overallGrade = GRADE_META[health.overall >= 80 ? 'good' : health.overall >= 50 ? 'attention' : 'poor']

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
          <HeartPulse className="h-5 w-5 text-amber-600" aria-hidden /> {t('overview.health.title')}
        </CardTitle>
        <CardDescription>
          {t('overview.health.desc', { date: dateShort(health.computedAt) })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col sm:flex-row gap-6">
          {/* Overall score — prominent */}
          <div className="sm:w-44 shrink-0 flex flex-row sm:flex-col items-center sm:items-start justify-between gap-3">
            <div>
              <p className="text-4xl font-bold text-stone-900 tabular-nums leading-none">
                {health.overall}
                <span className="text-lg font-medium text-stone-400">/100</span>
              </p>
              <p className="text-xs text-stone-500 mt-1">{t('overview.health.overall')}</p>
            </div>
            <Badge className={`text-xs ${overallGrade.chip}`}>
              {t(overallGrade.labelKey)}
            </Badge>
          </div>

          {/* Dimension bars */}
          <div className="flex-1 space-y-3.5 min-w-0">
            {health.dimensions.map((d) => {
              const meta = GRADE_META[d.grade] ?? GRADE_META.attention
              return (
                <div key={d.key}>
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="text-sm font-medium text-stone-800">{d.label}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span className="text-sm font-bold tabular-nums text-stone-700">{d.score}</span>
                      <Badge className={`text-[10px] ${meta.chip}`}>{t(meta.labelKey)}</Badge>
                    </span>
                  </div>
                  <Progress value={d.score} className={`h-2 bg-stone-200 [&>[data-slot=progress-indicator]]:${meta.bar}`} />
                  <p className="text-[11px] text-stone-500 mt-1 leading-snug">{d.summary}</p>
                </div>
              )
            })}
          </div>
        </div>

        {/* Expandable: how each dimension is computed (spec §48 — explain the score) */}
        <div className="mt-4 border-t border-stone-100 pt-3">
          <button
            type="button"
            onClick={() => setShowHow((v) => !v)}
            aria-expanded={showHow}
            className="flex items-center gap-1.5 text-xs font-semibold text-stone-600 hover:text-stone-900 min-h-8"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showHow ? '' : '-rotate-90'}`} aria-hidden />
            {t('overview.health.how')}
          </button>
          {showHow && (
            <dl className="mt-2 space-y-2 text-xs text-stone-600" aria-label={t('overview.health.inputs')}>
              {health.dimensions.map((d) => (
                <div key={d.key} className="grid grid-cols-[110px_1fr] gap-2">
                  <dt className="font-semibold text-stone-800">{d.label}</dt>
                  <dd className="leading-snug">{HEALTH_INPUTS[d.key]}</dd>
                </div>
              ))}
              <div className="pt-1 text-[11px] text-stone-400">
                Overall = mean of the six dimension scores. Grades: Good ≥ 80 · Attention 50-79 · Poor &lt; 50.
                Every input row is queryable — same rows in, same score out.
              </div>
            </dl>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------- Reports menu (spec §49 + §79, F-INSIGHT) ----------------

const REPORT_ITEMS: Array<{ key: string; labelKey: string; kind: 'csv' | 'pdf' }> = [
  { key: 'daily', labelKey: 'overview.report.daily', kind: 'csv' },
  { key: 'weekly', labelKey: 'overview.report.weekly', kind: 'csv' },
  { key: 'financial', labelKey: 'overview.report.financial', kind: 'csv' },
  { key: 'procurement', labelKey: 'overview.report.procurement', kind: 'csv' },
  { key: 'weekly-pdf', labelKey: 'overview.report.weeklyPdf', kind: 'pdf' },
]

/** Reports popover — 4 CSV variants + the weekly PDF, all from live project data. */
function ReportsMenu({ disabled }: { disabled?: boolean }) {
  const data = useMjengo((s) => s.data)
  const t = useT()
  const [busy, setBusy] = useState<string | null>(null)

  if (!data) return null

  async function downloadReport(key: string) {
    if (busy || !data) return
    setBusy(key)
    try {
      if (key === 'daily') {
        const f = downloadDailyReportCSV(data)
        toast.success(`${f} downloaded — generated from live project data`)
      } else if (key === 'weekly') {
        const f = downloadWeeklyReportCSV(data)
        toast.success(`${f} downloaded — generated from live project data`)
      } else if (key === 'financial') {
        const f = downloadFinancialReportCSV(data)
        toast.success(`${f} downloaded — generated from live project data`)
      } else if (key === 'procurement') {
        const f = downloadProcurementReportCSV(data)
        toast.success(`${f} downloaded — generated from live project data`)
      } else if (key === 'weekly-pdf') {
        const f = await downloadWeeklyReportPDF(data)
        toast.success(`${f} downloaded — generated from live project data`)
      }
    } catch (e) {
      console.error('report download failed', e)
      toast.error('Report build failed — nothing was downloaded')
    } finally {
      setBusy(null)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={disabled || busy !== null}
          aria-label={t('overview.aria.reports')}>
          <FileDown className="w-4 h-4" aria-hidden /> {t('overview.toolbar.reports')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {REPORT_ITEMS.map((r) => (
          <DropdownMenuItem key={r.key} onSelect={() => void downloadReport(r.key)}>
            <FileText className="w-3.5 h-3.5 mr-1.5" aria-hidden /> {t(r.labelKey)}
          </DropdownMenuItem>
        ))}
        <p className="px-2 py-1.5 text-[10px] text-stone-400">{t('overview.reports.note')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function OverviewTab({ onOpenCopilot }: { onOpenCopilot: () => void }) {
  const { data, dispatch, viewMode, shareToken, clientRole, online, dataMode } = useMjengo()
  const { role, authenticated } = usePermissions()
  const t = useT()
  const [recapBusy, setRecapBusy] = useState(false)
  const [photoOpen, setPhotoOpen] = useState<string | null>(null)
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [expenseBusy, setExpenseBusy] = useState(false)

  if (!data) return null
  const s = data.summary
  const openPhoto = data.photos.find((p) => p.id === photoOpen)
  const isClient = viewMode === 'client'
  // Client identity (share link OR logged-in client role) → comments authored as the client
  const isShareClient = isClient && (Boolean(shareToken) || clientRole)
  const photoComments = openPhoto ? data.photoComments.filter((c) => c.photoId === openPhoto.id) : []

  async function generateRecap() {
    setRecapBusy(true)
    try {
      const res = await fetch('/api/ai/recap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: data?.project.id }),
      })
      const json = await res.json()
      if (json.ok) {
        toast.success('6 PM recap generated — ready to send to the client on WhatsApp')
        await useMjengo.getState().load()
      } else {
        toast.error(json.error ?? 'Failed to generate recap')
      }
    } catch {
      toast.error('Network error — AI recap needs connectivity')
    } finally {
      setRecapBusy(false)
    }
  }

  function exportCSV(kind: 'summary' | 'materials' | 'attendance' | 'transactions') {
    if (!data) return
    const prefix = projectFilePrefix(data)
    const files: Record<typeof kind, { csv: string; filename: string }> = {
      summary: { csv: projectSummaryCSV(data), filename: `${prefix}-summary.csv` },
      materials: { csv: materialsLedgerCSV(data), filename: `${prefix}-materials-ledger.csv` },
      attendance: { csv: attendanceCSV(data), filename: `${prefix}-attendance.csv` },
      transactions: { csv: transactionsCSV(data), filename: `${prefix}-transactions.csv` },
    }
    const { csv, filename } = files[kind]
    downloadCSV(filename, csv)
    toast.success(`${filename} downloaded`)
  }

  async function recordExpense(payload: ExpenseDialogPayload): Promise<boolean> {
    setExpenseBusy(true)
    try {
      return await dispatch('expense.create', payload, `Record ${payload.type} expense KSh ${payload.amount}`)
    } finally {
      setExpenseBusy(false)
    }
  }

  const spendLeads = s.budgetSpentPct - s.progressPct
  const chartData = s.spendTrend.map((t) => ({ ...t, plannedK: t.planned / 1000, actualK: t.actual / 1000 }))

  return (
    <div className="space-y-6">
      {/* Toolbar: exports + reports (reports for BOTH roles) + record expense (owner only) */}
      <div className="flex items-center gap-2 flex-wrap" role="toolbar" aria-label={t('overview.aria.toolbar')}>
        <ReportsMenu />
        {!isClient && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5" aria-label={t('overview.aria.export')}>
                  <Download className="w-4 h-4" aria-hidden /> {t('overview.toolbar.export')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => exportCSV('summary')}>{t('overview.export.summary')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportCSV('materials')}>{t('overview.export.materials')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportCSV('attendance')}>{t('overview.export.attendance')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportCSV('transactions')}>{t('overview.export.transactions')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => setExpenseOpen(true)}
            >
              <ReceiptText className="w-4 h-4" aria-hidden /> {t('overview.toolbar.recordExpense')}
            </Button>
          </>
        )}
      </div>

      {/* KPI cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" aria-label={t('overview.aria.metrics')}>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><TrendingUp className="w-3.5 h-3.5" aria-hidden /> {t('overview.kpi.progress')}</CardDescription>
            <CardTitle className="text-3xl font-bold text-stone-900 tabular-nums">{s.progressPct}%</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress value={s.progressPct} className="h-2 bg-stone-200 [&>[data-slot=progress-indicator]]:bg-amber-500" />
            <p className="text-xs text-stone-500">{t('overview.kpi.progressNote', { day: s.dayCount, remaining: s.daysRemaining })}</p>
          </CardContent>
        </Card>

        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Wallet className="w-3.5 h-3.5" aria-hidden /> {t('overview.kpi.budget')}</CardDescription>
            <CardTitle className="text-3xl font-bold text-stone-900 tabular-nums">{s.budgetSpentPct}%</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress value={s.budgetSpentPct} className={`h-2 bg-stone-200 [&>[data-slot=progress-indicator]]:${spendLeads > 8 ? 'bg-red-500' : 'bg-emerald-600'}`} />
            <p className="text-xs text-stone-500">
              {t('overview.kpi.budgetOf', { spent: formatKES(s.budgetSpent, true), total: formatKES(s.budgetTotal, true), pct: s.plannedSpendPct })}
              {spendLeads > 0 ? ` · ${t('overview.kpi.ahead', { pts: spendLeads })}` : ` · ${t('overview.kpi.underPlan')}`}
            </p>
          </CardContent>
        </Card>

        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Users className="w-3.5 h-3.5" aria-hidden /> {t('overview.kpi.crew')}</CardDescription>
            <CardTitle className="text-3xl font-bold text-stone-900 tabular-nums">{s.fundisToday}<span className="text-lg text-stone-400 font-medium">/{s.fundisExpected}</span></CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-stone-500">
              {t('overview.kpi.crewNote', { wages: formatKES(s.wagesToday), unpaid: formatKES(s.wagesUnpaid, true) })}
            </p>
          </CardContent>
        </Card>

        <Card className={`shadow-sm ${s.unackedAlerts > 0 ? 'border-red-200 bg-red-50/50' : 'border-stone-200'}`}>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><ShieldAlert className="w-3.5 h-3.5" aria-hidden /> {t('overview.kpi.alerts')}</CardDescription>
            <CardTitle className="text-3xl font-bold text-stone-900 tabular-nums">{s.unackedAlerts}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-stone-500">
              {s.unackedAlerts > 0 ? t('overview.kpi.alertsOpen') : t('overview.kpi.alertsClear')}
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Project health score (spec §48) — both roles */}
      <HealthCard health={data.intel.health} />

      {/* Role dashboard sections (W3-F1 · spec §1660-1700) — ADDITIVE only:
          the default contractor view is untouched; each card renders null for
          roles it does not apply to. Variance: qs+contractor+admin; BOQ summary:
          qs; payments/wallet: finance; system health: admin. */}
      {authenticated && role !== 'client' && (
        <section className="space-y-6" aria-label={t('overview.aria.roleDashboard')}>
          <QsBudgetCard />
          <BudgetVarianceCard />
          <FinanceSnapshotCard />
          <SystemHealthCard />
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Burn-down chart */}
        <Card className="lg:col-span-2 border-stone-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg text-stone-900">{t('overview.burn.title')}</CardTitle>
            <CardDescription>
              {t('overview.burn.desc', { pts: Math.abs(spendLeads) })}
              {spendLeads > 8 ? t('overview.burn.review') : t('overview.burn.onTrack')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64" role="img" aria-label={t('overview.aria.burnChart')}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#78716c' }} />
                  <YAxis tick={{ fontSize: 12, fill: '#78716c' }} tickFormatter={(v) => `${v}K`} />
                  <ReTooltip
                     formatter={(value: number, name: string) => [formatKES(value * 1000), name]}
                     contentStyle={{ borderRadius: 8, border: '1px solid #e7e5e4', fontSize: 13 }}
                   />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine y={s.progressPct * 10} stroke="transparent" />
                  <Line type="monotone" dataKey="plannedK" name="Planned spend" stroke="#a8a29e" strokeDasharray="6 4" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="actualK" name="Actual spend" stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 3, fill: '#f59e0b' }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-stone-500">
              <span>{t('overview.burn.footer', { progress: s.progressPct, spent: s.budgetSpentPct })}</span>
              <span className="font-medium text-stone-700">{t('overview.burn.remaining', { amount: formatKES(s.budgetTotal - s.budgetSpent, true) })}</span>
            </div>
          </CardContent>
        </Card>

        {/* Phase progress */}
        <Card className="border-stone-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg text-stone-900">{t('overview.phases.title')}</CardTitle>
            <CardDescription>{t('overview.phases.desc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.phases.map((p) => (
              <div key={p.id}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-stone-800 flex items-center gap-2">
                    {p.order}. {p.name}
                    {p.status === 'in_progress' && <Badge className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100 border-0">{t('overview.phases.active')}</Badge>}
                    {p.status === 'done' && <Badge className="text-[10px] bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-0">{t('overview.phases.done')}</Badge>}
                  </span>
                  <span className="text-sm font-bold tabular-nums text-stone-700">{p.progress}%</span>
                </div>
                <Progress value={p.progress} className={`h-2 bg-stone-200 [&>[data-slot=progress-indicator]]:${p.status === 'done' ? 'bg-emerald-600' : p.status === 'in_progress' ? 'bg-amber-500' : 'bg-stone-400'}`} />
                <p className="text-[11px] text-stone-400 mt-1">{t('overview.phases.tasks', { done: p.tasks.filter((tk) => tk.status === 'done').length, total: p.tasks.length, budget: formatKES(p.budget, true) })}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Site evidence: Day-1 → today time-lapse + interactive site map */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6" aria-label={t('overview.aria.evidence')}>
        <TimelapseCard />
        <SiteMapCard />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* AI alerts feed */}
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-lg text-stone-900 flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-amber-600" aria-hidden /> {t('overview.alerts.title')}
              </CardTitle>
              <CardDescription>{t('overview.alerts.desc')}</CardDescription>
            </div>
            {!isClient && (
              <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={onOpenCopilot}>
                <Sparkles className="w-4 h-4" aria-hidden /> {t('overview.alerts.scan')}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-80 pr-3 -mr-3">
              <div className="space-y-3">
                {data.alerts.map((a) => (
                  <div key={a.id} className={`rounded-lg border p-3 ${a.acknowledged ? 'border-stone-200 bg-stone-50 opacity-70' : a.severity === 'critical' ? 'border-red-200 bg-red-50/60' : a.severity === 'warning' ? 'border-amber-200 bg-amber-50/60' : 'border-stone-200'}`}>
                    <div className="flex items-start gap-2">
                      <SeverityIcon severity={a.severity} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-stone-800">{a.title}</span>
                          <Badge variant="outline" className="text-[10px] capitalize">{a.type}</Badge>
                        </div>
                        <p className="text-xs text-stone-600 mt-1 leading-relaxed">{a.message}</p>
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-[10px] text-stone-400 flex items-center gap-1">
                            <CalendarDays className="w-3 h-3" aria-hidden /> {dateShort(a.createdAt)}
                          </span>
                          {!a.acknowledged && !isClient && (
                            <Button size="sm" variant="ghost" className="h-6 text-xs gap-1" onClick={() => void dispatch('alert.ack', { id: a.id }, 'Acknowledge alert')}>
                              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> {t('overview.alerts.ack')}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                {data.alerts.length === 0 && <p className="text-sm text-stone-400 py-6 text-center">{t('overview.alerts.empty')}</p>}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Photo evidence strip */}
        <Card className="border-stone-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg text-stone-900 flex items-center gap-2">
              <Camera className="w-5 h-5 text-amber-600" aria-hidden /> {t('overview.photos.title')}
            </CardTitle>
            <CardDescription>{t('overview.photos.desc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2">
              {data.photos.slice(0, 6).map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPhotoOpen(p.id)}
                  className="group relative aspect-[4/3] rounded-lg overflow-hidden border border-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  aria-label={t('overview.photos.aria', { caption: p.caption ?? t('overview.photos.sitePhoto') })}
                >
                  <img src={p.url} alt={p.caption ?? t('overview.photos.sitePhoto')} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1">
                    <p className="text-[9px] text-white font-medium truncate">{p.caption ?? t('overview.photos.sitePhoto')}</p>
                  </div>
                  {p.analysis && (
                    <span className="absolute top-1 right-1 bg-amber-500 text-stone-950 text-[9px] font-bold px-1.5 py-0.5 rounded">{t('overview.photos.ai')}</span>
                  )}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Daily recap */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-lg text-stone-900 flex items-center gap-2">
              <MessageSquareText className="w-5 h-5 text-amber-600" aria-hidden /> {t('overview.recap.title')}
            </CardTitle>
            <CardDescription>{t('overview.recap.desc')}</CardDescription>
          </div>
          {!isClient && (
            <Button
              size="sm"
              onClick={() => void generateRecap()}
              disabled={recapBusy || !online}
              title={dataMode === 'data_saver'
                ? 'Data Saver on — the recap is a text-only digest (no images fetched)'
                : undefined}
              className="gap-1.5 shrink-0 bg-amber-600 hover:bg-amber-700 text-white"
            >
              {recapBusy ? <RefreshCw className="w-4 h-4 animate-spin" aria-hidden /> : <Send className="w-4 h-4" aria-hidden />}
              {recapBusy ? t('overview.recap.writing') : dataMode === 'data_saver' ? t('overview.recap.saver') : t('overview.recap.generate')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {data.recaps.length > 0 ? (
            <ScrollArea className="max-h-64 pr-3 -mr-3">
              <div className="space-y-3">
                {data.recaps.map((r) => (
                  <div key={r.id} className="max-w-2xl ml-auto bg-emerald-50 border border-emerald-200 rounded-2xl rounded-br-sm px-4 py-3">
                    <p className="text-[11px] text-emerald-700 font-semibold mb-1 flex items-center gap-1.5 justify-end">
                      {t('overview.recap.day', { day: r.day, date: dateShort(r.createdAt) })} <MapPin className="w-3 h-3" aria-hidden />
                    </p>
                    <pre className="whitespace-pre-wrap font-sans text-sm text-stone-800 leading-relaxed">{r.content}</pre>
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <p className="text-sm text-stone-400 py-4 text-center">{t('overview.recap.empty')}</p>
          )}
        </CardContent>
      </Card>

      {/* Unified activity timeline (W3-F1 · spec §44 Project → Activity) —
          all OWNER roles, fed by the payload's auditEvents (no new fetch);
          hidden on the client surface and when the trail is empty. */}
      {!isClient && <ActivityTimeline />}

      {/* Record expense dialog (owner only) */}
      <ExpenseDialog
        open={expenseOpen}
        onOpenChange={setExpenseOpen}
        onSubmit={recordExpense}
        submitting={expenseBusy}
      />

      {/* Photo analysis dialog (comment thread pinned to the same evidence) */}
      <Dialog open={Boolean(photoOpen)} onOpenChange={(v) => !v && setPhotoOpen(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {openPhoto && (
            <>
              <DialogHeader>
                <DialogTitle className="text-stone-900">{t('overview.photo.title')}</DialogTitle>
                <DialogDescription>{openPhoto.caption} · {dateShort(openPhoto.createdAt)}</DialogDescription>
              </DialogHeader>
              <img src={openPhoto.url} alt={openPhoto.caption ?? t('overview.photos.sitePhoto')} className="w-full rounded-lg border border-stone-200" />
              {openPhoto.analysis ? (
                <PhotoAnalysisBody analysis={JSON.parse(openPhoto.analysis) as PhotoAnalysis} />
              ) : (
                <div className="text-sm text-stone-500 bg-stone-50 border border-stone-200 rounded-lg p-4">
                  {t('overview.photo.notAnalyzed')}
                </div>
              )}
              <div className="border-t border-stone-200 pt-4">
                <CommentThread
                  photo={{ id: openPhoto.id, url: openPhoto.url, caption: openPhoto.caption }}
                  comments={photoComments}
                  canResolve={!isClient}
                  defaultAuthor={isShareClient ? data.project.client : 'Site Manager'}
                  defaultRole={isShareClient ? 'client' : 'contractor'}
                  onAdd={async (message) => {
                    await dispatch('comment.add', {
                      photoId: openPhoto.id,
                      author: isShareClient ? data.project.client : 'Site Manager',
                      role: isShareClient ? 'client' : 'contractor',
                      message,
                    }, 'Photo comment')
                  }}
                  onResolve={async (id) => {
                    await dispatch('comment.resolve', { id }, 'Resolve photo comment')
                  }}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function PhotoAnalysisBody({ analysis }: { analysis: PhotoAnalysis }) {
  const t = useT()
  return (
    <div className="space-y-4 text-sm">
      {analysis.summary && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="font-medium text-amber-900">{analysis.summary}</p>
          {typeof analysis.progressPct === 'number' && (
            <p className="text-xs text-amber-700 mt-1">{t('overview.photo.visualEstimate', { pct: analysis.progressPct, phase: analysis.phaseShown ?? '—', conf: Math.round((analysis.confidence ?? 0) * 100) })}</p>
          )}
        </div>
      )}
      {analysis.observations && analysis.observations.length > 0 && (
        <div>
          <h4 className="font-semibold text-stone-800 mb-1.5">{t('overview.photo.observations')}</h4>
          <ul className="list-disc pl-5 space-y-1 text-stone-600">
            {analysis.observations.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
        </div>
      )}
      {analysis.safety && analysis.safety.length > 0 && (
        <div>
          <h4 className="font-semibold text-red-700 mb-1.5 flex items-center gap-1.5"><TriangleAlert className="w-4 h-4" aria-hidden /> {t('overview.photo.safety')}</h4>
          <ul className="space-y-1">
            {analysis.safety.map((sf, i) => (
              <li key={i} className="flex items-center gap-2 text-red-700 bg-red-50 border border-red-200 rounded-md px-2.5 py-1.5 text-xs">
                <Badge className={sf.severity === 'high' ? 'bg-red-600' : 'bg-amber-500'}>{sf.severity}</Badge> {sf.issue}
              </li>
            ))}
          </ul>
        </div>
      )}
      {analysis.materialsVisible && analysis.materialsVisible.length > 0 && (
        <div>
          <h4 className="font-semibold text-stone-800 mb-1.5">{t('overview.photo.materials')}</h4>
          <div className="flex flex-wrap gap-1.5">
            {analysis.materialsVisible.map((m, i) => (
              <Badge key={i} variant="outline" className="text-xs bg-stone-50">{m.name}: {m.roughQty}</Badge>
            ))}
          </div>
        </div>
      )}
      {analysis.qualityFlags && analysis.qualityFlags.length > 0 && (
        <div>
          <h4 className="font-semibold text-stone-800 mb-1.5">{t('overview.photo.workmanship')}</h4>
          <ul className="list-disc pl-5 space-y-1 text-stone-600 text-xs">
            {analysis.qualityFlags.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
