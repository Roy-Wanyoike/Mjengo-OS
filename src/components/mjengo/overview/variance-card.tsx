'use client'

// Budget Variance drill-down (W3-F1 · QS surface, spec §1660-1700 budget
// control). Renders on the Overview tab for qs + contractor + admin roles.
//
// Data: GET /api/reports/budget-variance?projectId=<id> (backend W3-B) —
//   { ok: true, data: { project: { name, budgetTotal, spent, remaining,
//     spentPct, progressPct }, phases: [{ name, budget, spent, variance,
//     variancePct, progressPct, txCount, topTransactions: [{ note, amount,
//     date }] }], categories: [{ key, label, spent, txCount, share }] } }
//
// Variance sign convention: budget − spent (accounting standard — positive is
// favourable/under budget). The badge is derived locally from budget vs spent
// so the Under/Over wording stays honest regardless of the number's sign:
//   under budget → emerald · overspend ≤10% → amber · overspend >10% → red.

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { usePermissions } from '@/lib/permissions'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Scale, ChevronDown, RefreshCw, TriangleAlert, Loader2, ReceiptText, BarChart3,
} from 'lucide-react'
import { formatKES, dateShort } from '@/lib/format'

// ---------------- API contract types (mirror of W3-B route) ----------------

interface VarianceTx {
  note: string
  amount: number
  date: string
}

interface VariancePhase {
  name: string
  budget: number
  spent: number
  variance: number
  variancePct: number
  progressPct: number
  txCount: number
  topTransactions: VarianceTx[]
}

interface VarianceCategory {
  key: string
  label: string
  spent: number
  txCount: number
  share: number // 0-100 share of total spend
}

interface VarianceData {
  project: {
    name: string
    budgetTotal: number
    spent: number
    remaining: number
    spentPct: number
    progressPct: number
  }
  phases: VariancePhase[]
  categories: VarianceCategory[]
}

interface VarianceResponse {
  ok: boolean
  data?: VarianceData
  error?: string
}

/** Roles that see the QS variance surface on the overview tab. */
const VARIANCE_ROLES: readonly string[] = ['qs', 'contractor', 'admin']

/** Under/Over badge meta derived from budget vs spent (sign-agnostic). */
function varianceBadge(budget: number, spent: number): { label: string; cls: string } {
  if (spent > budget) {
    const overspendPct = budget > 0 ? ((spent - budget) / budget) * 100 : Infinity
    return overspendPct > 10
      ? { label: 'Over budget', cls: 'bg-red-100 text-red-700 hover:bg-red-100 border-0' }
      : { label: 'Slight overspend', cls: 'bg-amber-100 text-amber-800 hover:bg-amber-100 border-0' }
  }
  return { label: 'Under budget', cls: 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-0' }
}

// ---------------- component ----------------

export function BudgetVarianceCard() {
  const { role, authenticated } = usePermissions()
  const projectId = useMjengo((s) => s.data?.project?.id ?? null)

  const [data, setData] = useState<VarianceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<{ status: number | null; message: string } | null>(null)
  const [openPhase, setOpenPhase] = useState<string | null>(null)

  const allowed = authenticated && role !== null && VARIANCE_ROLES.includes(role)

  const fetchReport = useCallback(
    async (initial: boolean) => {
      if (!projectId) return
      if (initial) setLoading(true)
      else setRefreshing(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/reports/budget-variance?projectId=${encodeURIComponent(projectId)}`,
          { cache: 'no-store' },
        )
        const json = (await res.json()) as VarianceResponse
        if (!res.ok || !json.ok || !json.data) {
          setError({
            status: res.status,
            message: res.status === 403
              ? 'Your role cannot view this budget report.'
              : res.status === 404
                ? 'This report is not available for the project yet.'
                : json.error ?? `Report request failed (${res.status}).`,
          })
          setData(null)
          return
        }
        setData(json.data)
      } catch {
        setError({ status: null, message: 'Network error — could not reach the budget report.' })
        setData(null)
      } finally {
        if (initial) setLoading(false)
        else setRefreshing(false)
      }
    },
    [projectId],
  )

  useEffect(() => {
    if (allowed) void fetchReport(true)
  }, [allowed, fetchReport])

  // Not one of the variance roles → nothing on the dashboard (role gating
  // also happens in overview-tab; this is defense in depth).
  if (!allowed) return null

  // ---------------- states ----------------

  if (loading) {
    return (
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <Scale className="w-5 h-5 text-amber-600" aria-hidden /> Budget variance
          </CardTitle>
          <CardDescription>QS drill-down — phase budgets vs actual spend</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
          </div>
          <Skeleton className="h-40 rounded-lg" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="border-amber-200 bg-amber-50/60 shadow-sm" role="alert">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <Scale className="w-5 h-5 text-amber-600" aria-hidden /> Budget variance
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-start gap-3">
          <TriangleAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" aria-hidden />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">Variance report unavailable</p>
            <p className="text-xs text-amber-800 mt-0.5">{error.message}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 gap-1.5 min-h-9"
              disabled={refreshing}
              onClick={() => void fetchReport(false)}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden /> Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const p = data.project
  const spendLeads = p.spentPct - p.progressPct

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <Scale className="w-5 h-5 text-amber-600" aria-hidden /> Budget variance
          </CardTitle>
          <CardDescription>
            {p.name} · phase budgets vs actual spend · QS drill-down
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 shrink-0 min-h-9"
          disabled={refreshing}
          onClick={() => void fetchReport(false)}
          aria-label="Refresh budget variance report"
        >
          {refreshing
            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            : <RefreshCw className="w-4 h-4" aria-hidden />}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Summary strip */}
        <div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Budget</p>
              <p className="text-base sm:text-lg font-bold text-stone-900 tabular-nums">{formatKES(p.budgetTotal, true)}</p>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Spent</p>
              <p className="text-base sm:text-lg font-bold text-stone-900 tabular-nums">{formatKES(p.spent, true)}</p>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Remaining</p>
              <p className={`text-base sm:text-lg font-bold tabular-nums ${p.remaining < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                {formatKES(p.remaining, true)}
              </p>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
              <p className="text-[11px] font-medium text-stone-500 uppercase tracking-wide">Build progress</p>
              <p className="text-base sm:text-lg font-bold text-stone-900 tabular-nums">{p.progressPct}%</p>
            </div>
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-stone-500 mb-1">
              <span>Spend {p.spentPct}% of budget</span>
              <span>
                {spendLeads > 0
                  ? `Spend leads work by ${spendLeads} pts`
                  : `Spend trails work by ${Math.abs(spendLeads)} pts`}
              </span>
            </div>
            <Progress
              value={Math.max(0, Math.min(100, p.spentPct))}
              aria-label={`Spent ${p.spentPct}% of budget`}
              className={`h-2.5 bg-stone-200 [&>[data-slot=progress-indicator]]:${spendLeads > 8 ? 'bg-red-500' : spendLeads > 0 ? 'bg-amber-500' : 'bg-emerald-600'}`}
            />
          </div>
        </div>

        {/* Phase variance table (expandable rows) */}
        <div>
          <h3 className="text-sm font-semibold text-stone-800 mb-2 flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4 text-stone-400" aria-hidden /> Phase budget vs actual
          </h3>
          {data.phases.length === 0 ? (
            <p className="text-sm text-stone-400 py-6 text-center border border-dashed border-stone-200 rounded-lg">
              No phase budgets recorded for this project yet.
            </p>
          ) : (
            <div className="border border-stone-200 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent bg-stone-50">
                      <TableHead className="text-xs text-stone-500">Phase</TableHead>
                      <TableHead className="text-xs text-stone-500 text-right">Budget</TableHead>
                      <TableHead className="text-xs text-stone-500 text-right">Spent</TableHead>
                      <TableHead className="text-xs text-stone-500 text-right">Variance</TableHead>
                      <TableHead className="text-xs text-stone-500 text-right hidden sm:table-cell">Progress</TableHead>
                      <TableHead className="w-10" aria-label="Expand phase transactions" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.phases.map((ph) => {
                      const open = openPhase === ph.name
                      const badge = varianceBadge(ph.budget, ph.spent)
                      const over = ph.spent > ph.budget
                      const varianceAbs = Math.abs(
                        Number.isFinite(ph.variance) ? ph.variance : ph.budget - ph.spent,
                      )
                      return (
                        <Fragment key={ph.name}>
                          <TableRow
                            className={over ? 'bg-red-50/40' : undefined}
                          >
                            <TableCell className="font-medium text-stone-800">
                              {ph.name}
                              <span className="block text-[10px] text-stone-400 sm:hidden">{ph.txCount} tx</span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-stone-700 text-sm">{formatKES(ph.budget, true)}</TableCell>
                            <TableCell className="text-right tabular-nums text-stone-900 text-sm font-semibold">{formatKES(ph.spent, true)}</TableCell>
                            <TableCell className="text-right">
                              <span className="flex flex-col items-end gap-0.5">
                                <span className={`text-sm font-bold tabular-nums ${over ? 'text-red-600' : 'text-emerald-700'}`}>
                                  {over ? '−' : '+'}{formatKES(varianceAbs, true)}
                                </span>
                                <Badge className={`text-[10px] ${badge.cls}`}>{badge.label}</Badge>
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-stone-600 text-sm hidden sm:table-cell">
                              {ph.progressPct}%
                              <span className="block text-[10px] text-stone-400">{ph.txCount} tx</span>
                            </TableCell>
                            <TableCell>
                              <button
                                type="button"
                                onClick={() => setOpenPhase(open ? null : ph.name)}
                                aria-expanded={open}
                                aria-label={`${open ? 'Hide' : 'Show'} top transactions for ${ph.name}`}
                                className="w-9 h-9 flex items-center justify-center rounded-md hover:bg-stone-100 transition-colors text-stone-500"
                                disabled={ph.topTransactions.length === 0}
                              >
                                {ph.topTransactions.length > 0 && (
                                  <ChevronDown className={`w-4 h-4 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden />
                                )}
                              </button>
                            </TableCell>
                          </TableRow>
                          {open && ph.topTransactions.length > 0 && (
                            <TableRow className="bg-stone-50/60 hover:bg-stone-50/60">
                              <TableCell colSpan={6} className="py-3">
                                <p className="text-[11px] font-semibold text-stone-500 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                                  <ReceiptText className="w-3.5 h-3.5" aria-hidden /> Top transactions in {ph.name}
                                </p>
                                <ul className="max-h-64 overflow-y-auto pr-1 space-y-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full">
                                  {ph.topTransactions.map((tx, i) => (
                                    <li key={i} className="flex items-center justify-between gap-3 text-xs border-b border-stone-100 last:border-b-0 pb-1.5 last:pb-0">
                                      <span className="text-stone-600 truncate" title={tx.note}>{tx.note || 'Untitled transaction'}</span>
                                      <span className="flex items-center gap-2 shrink-0 tabular-nums">
                                        <span className="text-stone-400">{dateShort(tx.date)}</span>
                                        <span className="font-semibold text-stone-800">{formatKES(tx.amount, true)}</span>
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        {/* Spend by category — horizontal share bars */}
        {data.categories.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-stone-800 mb-2">Spend by category</h3>
            <ul className="space-y-2.5">
              {data.categories.map((cat) => (
                <li key={cat.key}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm text-stone-700 font-medium truncate">{cat.label}</span>
                    <span className="flex items-center gap-2 shrink-0 text-xs">
                      <span className="text-stone-400">{cat.txCount} tx</span>
                      <span className="font-semibold tabular-nums text-stone-800">{formatKES(cat.spent, true)}</span>
                      <span className="tabular-nums text-stone-500">{Math.round(cat.share)}%</span>
                    </span>
                  </div>
                  <div
                    className="h-2 rounded-full bg-stone-200 overflow-hidden"
                    role="img"
                    aria-label={`${cat.label}: ${Math.round(cat.share)}% of spend, ${formatKES(cat.spent, true)}`}
                  >
                    <div
                      className="h-full rounded-full bg-amber-500"
                      style={{ width: `${Math.max(1, Math.min(100, cat.share))}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
