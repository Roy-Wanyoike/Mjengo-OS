import { NextRequest, NextResponse } from 'next/server'
import { withGuard } from '@/lib/guard'
import { enforceRateLimit } from '@/lib/rate-limit'
import { buildBudgetVarianceReport } from '@/modules/reports/service'

export const dynamic = 'force-dynamic'

/**
 * Budget Variance report API (QS surface: BOQ / Cost Plan / Variations /
 * Actual Cost / Forecast / Budget Variance) — W3-B.
 *
 * GET /api/reports/budget-variance?projectId=<id>
 *   · Guard: contractor / admin / supervisor / qs (withGuard roles list) —
 *     the site team that works the cost plan. Client/finance/procurement are
 *     not on this surface (403 with the honest role message).
 *   · Rate limit: 30/min per principal (enforceRateLimit
 *     'reports.budget-variance') — the derivation walks every transaction of
 *     the project, so it is a heavyweight read, not a polling target.
 *   · projectId is REQUIRED (no default-project guessing on a report) → 400
 *     when absent; unknown project → 404 { error: 'Project not found' }.
 *   · Response CONTRACT (frontend codes against this — do not deviate):
 *       { ok: true, data: { project: { id, name, budgetTotal, spent,
 *         remaining, spentPct, progressPct },
 *         phases: [ { id, name, budget, spent, variance, variancePct,
 *           progressPct, txCount, topTransactions: [ { id, note, amount,
 *           date } ] } ],
 *         categories: [ { key, label, spent, txCount, share } ] } }
 *     variance = budget − spent (positive = under budget).
 *     Per-phase spent is an allocation (Transaction has no phaseId) — see the
 *     honest derivation notes in src/modules/reports/service.ts.
 */
export const GET = withGuard(
  async (req: NextRequest) => {
    const limited = await enforceRateLimit(req, 'reports.budget-variance', 30, 60_000)
    if (limited) return limited

    try {
      const projectId = req.nextUrl.searchParams.get('projectId')?.trim()
      if (!projectId) {
        return NextResponse.json({ error: 'projectId required' }, { status: 400 })
      }
      const report = await buildBudgetVarianceReport(projectId)
      if (!report) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
      return NextResponse.json({ ok: true, data: report })
    } catch (e) {
      console.error('[api/reports/budget-variance GET]', e)
      return NextResponse.json({ error: 'Failed to build budget variance report' }, { status: 500 })
    }
  },
  { roles: ['contractor', 'admin', 'supervisor', 'qs'] },
)
