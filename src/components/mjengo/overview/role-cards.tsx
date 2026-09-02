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

import { useCallback, useEffect, useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { usePermissions } from '@/lib/permissions'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Server, RefreshCw, Activity, ListChecks, Wallet, Clock, TriangleAlert, CircleCheck,
} from 'lucide-react'
import { formatKES } from '@/lib/format'

/** "KSh x · as of 14:32" style honesty stamp from the store's lastSyncAt. */
function SyncStamp() {
  const lastSyncAt = useMjengo((s) => s.lastSyncAt)
  if (!lastSyncAt) return <span>from the loaded project payload</span>
  const t = new Date(lastSyncAt).toLocaleTimeString('en-KE', {
    timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  return <span>as of {t} EAT · last project sync</span>
}

// ---------------- QS · BOQ / cost summary ----------------

export function QsBudgetCard() {
  const { role, authenticated } = usePermissions()
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
          <ListChecks className="w-5 h-5 text-amber-600" aria-hidden /> QS cost position
        </CardTitle>
        <CardDescription>
          BOQ and cost summary <SyncStamp />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Budget</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">{formatKES(s.budgetTotal, true)}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Spent</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">{formatKES(s.budgetSpent, true)}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Remaining</p>
            <p className={`text-base font-bold tabular-nums ${remaining < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
              {formatKES(remaining, true)}
            </p>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-xs text-stone-500 mb-1">
            <span>Spent {s.budgetSpentPct}% · planned {s.plannedSpendPct}%</span>
            <span className={s.spendVsPlanDelta > 0 ? 'text-red-600' : 'text-emerald-700'}>
              {s.spendVsPlanDelta > 0
                ? `${s.spendVsPlanDelta} pts over plan`
                : `${Math.abs(s.spendVsPlanDelta)} pts under plan`}
            </span>
          </div>
          <Progress
            value={Math.max(0, Math.min(100, s.budgetSpentPct))}
            aria-label={`Spent ${s.budgetSpentPct}% of budget`}
            className={`h-2.5 bg-stone-200 [&>[data-slot=progress-indicator]]:${s.spendVsPlanDelta > 0 ? 'bg-amber-500' : 'bg-emerald-600'}`}
          />
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-stone-500 border-t border-stone-100 pt-3">
          <span>
            {boqs.length} BOQ{boqs.length === 1 ? '' : 's'} · {approved.length} approved
            {latestBoq && ` · latest "${latestBoq.name}" (${formatKES(latestBoq.total, true)})`}
          </span>
          {boqs.length === 0 && <span>no BOQs raised yet</span>}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------- Finance · payments / wallet snapshot ----------------

export function FinanceSnapshotCard() {
  const { role, authenticated } = usePermissions()
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
          <Wallet className="w-5 h-5 text-amber-600" aria-hidden /> Payments &amp; wallet
        </CardTitle>
        <CardDescription>
          Escrow, wallet and payer queue <SyncStamp />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Escrow</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">{formatKES(escrowBalance, true)}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Wallet</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">
              {finance?.wallet ? formatKES(finance.wallet.balance, true) : '—'}
            </p>
            {finance?.wallet && <p className="text-[10px] text-stone-400 truncate">{finance.wallet.code}</p>}
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
            <p className="text-[11px] font-medium text-amber-800 uppercase tracking-wide">Payer queue</p>
            <p className="text-base font-bold text-amber-900 tabular-nums">{pendingRequests.length} pending</p>
            <p className="text-[10px] text-amber-700">{formatKES(pendingAmount, true)}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Committed</p>
            <p className="text-base font-bold text-stone-900 tabular-nums">{formatKES(finance?.committed ?? 0, true)}</p>
            <p className="text-[10px] text-stone-400">{formatKES(finance?.remaining ?? 0, true)} free</p>
          </div>
        </div>
        <p className="text-xs text-stone-500 mt-3 flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden />
          {releaseRequested > 0
            ? `${releaseRequested} milestone release${releaseRequested === 1 ? '' : 's'} awaiting approval · `
            : 'No milestone releases pending · '}
          Open the Money tab to act on the queue.
        </p>
        {!hasMoneyData && (
          <p className="text-[11px] text-stone-400 mt-1.5 border-t border-stone-100 pt-2">
            No wallet or payment data in the current payload — reload the page to re-sync the money core.
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
      if (!res.ok) setError(json.error ?? `Probe failed (${res.status})`)
    } catch {
      setError('Network error — the health probe is unreachable.')
      setHealth(null)
    } finally {
      setLoading(false)
    }
  }, [])

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
      ? { label: 'Unreachable', cls: 'bg-red-100 text-red-700 hover:bg-red-100 border-0', Icon: TriangleAlert }
      : jobs && jobs.failed > 0
        ? { label: 'Attention — failed jobs', cls: 'bg-red-100 text-red-700 hover:bg-red-100 border-0', Icon: TriangleAlert }
        : jobs && (jobs.retrying > 0 || jobs.queued > 0)
          ? { label: 'Degraded — job backlog', cls: 'bg-amber-100 text-amber-800 hover:bg-amber-100 border-0', Icon: TriangleAlert }
          : { label: 'Healthy', cls: 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-0', Icon: CircleCheck }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-2 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <Server className="w-5 h-5 text-amber-600" aria-hidden /> System health
          </CardTitle>
          <CardDescription>Live /api/health probe — DB round-trip, job queue, row counts</CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 shrink-0 min-h-9"
          disabled={loading}
          onClick={() => void fetchHealth()}
          aria-label="Refresh system health"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          <span className="hidden sm:inline">Refresh</span>
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
                {health?.uptimeSec !== undefined ? ` · up ${Math.floor(health.uptimeSec / 60)}m` : ''}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Jobs queued</p>
                <p className="text-base font-bold text-stone-900 tabular-nums">{jobs ? jobs.queued : '—'}</p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Retrying</p>
                <p className={`text-base font-bold tabular-nums ${jobs && jobs.retrying > 0 ? 'text-amber-600' : 'text-stone-900'}`}>
                  {jobs ? jobs.retrying : '—'}
                </p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Failed</p>
                <p className={`text-base font-bold tabular-nums ${jobs && jobs.failed > 0 ? 'text-red-600' : 'text-stone-900'}`}>
                  {jobs ? jobs.failed : '—'}
                </p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide flex items-center gap-1">
                  <Activity className="w-3 h-3" aria-hidden /> Rows
                </p>
                <p className="text-sm font-bold text-stone-900 tabular-nums">
                  {counts ? `${counts.projects}P · ${counts.workers}W · ${counts.notifications}N` : '—'}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-stone-400 border-t border-stone-100 pt-2.5">
              Liveness is a process-local check with a real DB round-trip — job counts are
              point-in-time row counts, not queue-depth gauges (honest scope, Doc A §45).
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
