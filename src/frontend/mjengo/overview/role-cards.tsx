'use client'

// Role-aware dashboard cards (W3-F1 · spec §1660-1700 role dashboards).
// Extra sections the Overview tab renders ON TOP of the default contractor
// view, per role — the default cards are never removed:
//   · qs      → QsBudgetCard (BOQ + cost summary from the payload)
//   · finance → FinanceSnapshotCard (escrow/wallet/payment snapshot)
//   · admin   → SystemHealthCard (live /api/health probe)
// Every number is derived from the loaded project payload (or, for admin,
// the real health endpoint) — nothing is fabricated. The qs + finance cards
// carry an honest "as of last sync" stamp (the payload is persisted locally
// and may briefly trail the server).
//
// All copy flows through useT() (overview.qs / overview.fin / overview.health
// families — issue #125).

import { useCallback, useEffect, useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { usePermissions } from '@/shared/permissions'
import { useT } from '@/frontend/i18n/provider'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Progress } from '@/frontend/ui/progress'
import { Skeleton } from '@/frontend/ui/skeleton'
import {
  Server, RefreshCw, Activity, ListChecks, Wallet, Clock, TriangleAlert, CircleCheck,
} from 'lucide-react'
import { formatKES } from '@/frontend/lib/format'

/** "KSh x · as of 14:32" style honesty stamp from the store's lastSyncAt. */
function SyncStamp() {
  const t = useT()
  const lastSyncAt = useMjengo((s) => s.lastSyncAt)
  if (!lastSyncAt) return <span>{t('overview.role.fromPayload')}</span>
  const time = new Date(lastSyncAt).toLocaleTimeString('en-KE', {
    timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  return <span>{t('overview.role.asOf', { time })}</span>
}

// ---------------- QS · BOQ / cost summary ----------------

export function QsBudgetCard() {
  const { role, authenticated } = usePermissions()
  const t = useT()
  const data = useMjengo((s) => s.data)

  if (!authenticated || role !== 'qs' || !data) return null

  const s = data.summary
  const boqs = data.boq?.boqs ?? []
  const approved = boqs.filter((b) => b.status === 'approved')
  const latestBoq = boqs.length > 0
    ? boqs.reduce((a, b) => (new Date(b.createdAt) > new Date(a.createdAt) ? b : a))
    : null
  const remaining = s.budgetTotal - s.budgetSpent

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
          <ListChecks className="w-5 h-5 text-amber-600" aria-hidden /> {t('overview.qs.title')}
        </CardTitle>
        <CardDescription>
          {t('overview.qs.desc')} <SyncStamp />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">{t('overview.qs.budget')}</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">{formatKES(s.budgetTotal, true)}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">{t('overview.qs.spent')}</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">{formatKES(s.budgetSpent, true)}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">{t('overview.qs.remaining')}</p>
            <p className={`text-base font-bold tabular-nums ${remaining < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
              {formatKES(remaining, true)}
            </p>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-xs text-stone-500 mb-1">
            <span>{t('overview.qs.spentPlanned', { spent: s.budgetSpentPct, planned: s.plannedSpendPct })}</span>
            <span className={s.spendVsPlanDelta > 0 ? 'text-red-600' : 'text-emerald-700'}>
              {s.spendVsPlanDelta > 0
                ? t('overview.qs.overPlan', { pts: s.spendVsPlanDelta })
                : t('overview.qs.underPlan', { pts: Math.abs(s.spendVsPlanDelta) })}
            </span>
          </div>
          <Progress
            value={Math.max(0, Math.min(100, s.budgetSpentPct))}
            aria-label={t('overview.qs.progressAria', { pct: s.budgetSpentPct })}
            className={`h-2.5 bg-stone-200 [&>[data-slot=progress-indicator]]:${s.spendVsPlanDelta > 0 ? 'bg-amber-500' : 'bg-emerald-600'}`}
          />
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-stone-500 border-t border-stone-100 pt-3">
          <span>
            {latestBoq
              ? t('overview.qs.boqLine', {
                count: boqs.length,
                approved: approved.length,
                name: latestBoq.name,
                total: formatKES(latestBoq.total, true),
              })
              : t('overview.qs.boqCount', { count: boqs.length, approved: approved.length })}
          </span>
          {boqs.length === 0 && <span>{t('overview.qs.noBoqs')}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------- Finance · payments / wallet snapshot ----------------

export function FinanceSnapshotCard() {
  const { role, authenticated } = usePermissions()
  const t = useT()
  const data = useMjengo((s) => s.data)

  if (!authenticated || role !== 'finance' || !data) return null

  const finance = data.finance
  const escrowBalance = data.escrow?.balance ?? 0
  const pendingRequests = (finance?.paymentRequests ?? []).filter((pr) => pr.status === 'pending')
  const pendingAmount = pendingRequests.reduce((sum, pr) => sum + pr.amount, 0)
  const releaseRequested = data.milestones.filter((m) => m.status === 'release_requested').length
  const hasMoneyData = finance && (finance.wallet !== null || finance.paymentRequests.length > 0)

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
          <Wallet className="w-5 h-5 text-amber-600" aria-hidden /> {t('overview.fin.title')}
        </CardTitle>
        <CardDescription>
          {t('overview.fin.desc')} <SyncStamp />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">{t('overview.fin.escrow')}</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">{formatKES(escrowBalance, true)}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">{t('overview.fin.wallet')}</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">
              {finance?.wallet ? formatKES(finance.wallet.balance, true) : '—'}
            </p>
            {finance?.wallet && <p className="text-[10px] text-stone-400 truncate">{finance.wallet.code}</p>}
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
            <p className="text-[11px] font-medium text-amber-800 uppercase tracking-wide">{t('overview.fin.payerQueue')}</p>
            <p className="text-base font-bold text-amber-900 tabular-nums">{t('overview.fin.pending', { count: pendingRequests.length })}</p>
            <p className="text-[10px] text-amber-700">{formatKES(pendingAmount, true)}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">{t('overview.fin.committed')}</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">{formatKES(finance?.committed ?? 0, true)}</p>
            <p className="text-[10px] text-stone-400">{t('overview.fin.free', { amount: formatKES(finance?.remaining ?? 0, true) })}</p>
          </div>
        </div>
        <p className="text-xs text-stone-500 mt-3 flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden />
          {releaseRequested > 0
            ? t('overview.fin.releasePending', { count: releaseRequested })
            : t('overview.fin.noReleasePending')}{' '}
          {t('overview.fin.openMoneyTab')}
        </p>
        {!hasMoneyData && (
          <p className="text-[11px] text-stone-400 mt-1.5 border-t border-stone-100 pt-2">
            {t('overview.fin.noMoneyData')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------- Admin · system health (live /api/health probe) ----------------

interface HealthJson {
  ok: boolean
  db?: string
  dbLatencyMs?: number
  uptimeSec?: number
  jobs?: { queued: number; retrying: number; failed: number } | null
  counts?: { projects: number; workers: number; notifications: number } | null
  error?: string
}

export function SystemHealthCard() {
  const { role, authenticated } = usePermissions()
  const t = useT()

  const [health, setHealth] = useState<HealthJson | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchHealth = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // /api/health is an unauthenticated liveness probe (W2) — no session needed
      const res = await fetch('/api/health', { cache: 'no-store' })
      const json = (await res.json()) as HealthJson
      setHealth(json)
      if (!res.ok) setError(json.error ?? t('overview.sys.probeFailed', { status: res.status }))
    } catch {
      setError(t('overview.sys.networkError'))
      setHealth(null)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (authenticated && role === 'admin') void fetchHealth()
  }, [authenticated, role, fetchHealth])

  if (!authenticated || role !== 'admin') return null

  const jobs = health?.jobs ?? null
  const counts = health?.counts ?? null
  // Honest overall state: green only when db is up AND nothing is stuck;
  // amber for retrying/queued backlog; red for failed jobs or db down.
  const state =
    !health || !health.ok || health.db === 'down'
      ? { label: t('overview.sys.state.unreachable'), cls: 'bg-red-100 text-red-700 hover:bg-red-100 border-0', Icon: TriangleAlert }
      : jobs && jobs.failed > 0
        ? { label: t('overview.sys.state.attention'), cls: 'bg-red-100 text-red-700 hover:bg-red-100 border-0', Icon: TriangleAlert }
        : jobs && (jobs.retrying > 0 || jobs.queued > 0)
          ? { label: t('overview.sys.state.degraded'), cls: 'bg-amber-100 text-amber-800 hover:bg-amber-100 border-0', Icon: TriangleAlert }
          : { label: t('overview.sys.state.healthy'), cls: 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-0', Icon: CircleCheck }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-2 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <Server className="w-5 h-5 text-amber-600" aria-hidden /> {t('overview.sys.title')}
          </CardTitle>
          <CardDescription>{t('overview.sys.desc')}</CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 shrink-0 min-h-9"
          disabled={loading}
          onClick={() => void fetchHealth()}
          aria-label={t('overview.sys.refreshAria')}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          <span className="hidden sm:inline">{t('overview.sys.refresh')}</span>
        </Button>
      </CardHeader>
      <CardContent>
        {loading && !health ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
          </div>
        ) : error && !health ? (
          <div className="flex items-start gap-3 text-sm" role="alert">
            <TriangleAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden />
            <p className="text-stone-600">{error}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className={`text-xs ${state.cls}`}>
                <state.Icon className="w-3.5 h-3.5 mr-1" aria-hidden /> {state.label}
              </Badge>
              <span className="text-xs text-stone-500 tabular-nums">
                db {health?.db ?? '—'}{health?.dbLatencyMs !== undefined ? ` · ${health.dbLatencyMs}ms` : ''}
                {health?.uptimeSec !== undefined ? ` · ${t('overview.sys.up', { mins: Math.floor(health.uptimeSec / 60) })}` : ''}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">{t('overview.sys.jobsQueued')}</p>
                <p className="text-base font-bold text-stone-900 tabular-nums">{jobs ? jobs.queued : '—'}</p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">{t('overview.sys.retrying')}</p>
                <p className={`text-base font-bold tabular-nums ${jobs && jobs.retrying > 0 ? 'text-amber-600' : 'text-stone-900'}`}>
                  {jobs ? jobs.retrying : '—'}
                </p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">{t('overview.sys.failed')}</p>
                <p className={`text-base font-bold tabular-nums ${jobs && jobs.failed > 0 ? 'text-red-600' : 'text-stone-900'}`}>
                  {jobs ? jobs.failed : '—'}
                </p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide flex items-center gap-1">
                  <Activity className="w-3 h-3" aria-hidden /> {t('overview.sys.rows')}
                </p>
                <p className="text-sm font-bold text-stone-900 tabular-nums">
                  {counts ? t('overview.sys.rowsCount', { projects: counts.projects, workers: counts.workers, notifications: counts.notifications }) : '—'}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-stone-400 border-t border-stone-100 pt-2.5">
              {t('overview.sys.footnote')}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
