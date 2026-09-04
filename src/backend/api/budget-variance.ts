import { NextRequest, NextResponse } from 'next/server'
import { route, genericError } from '@/backend/lib/route-kit'
import { buildBudgetVarianceReport } from '@/backend/modules/reports/service'

// Budget Variance report API (QS surface: BOQ / Cost Plan / Variations /
// Actual Cost / Forecast / Budget Variance) — W3-B.
// src/app/api/reports/budget-variance/route.ts is the shim.
//
// GET /api/reports/budget-variance?projectId=<id>
//   · Guard: contractor / admin / supervisor / qs (route roles list) —
//     the site team that works the cost plan. Client/finance/procurement are
//     not on this surface (403 with the honest role message).
//   · Rate limit: 30/min per principal (bucket 'reports.budget-variance') —
//     the derivation walks every transaction of the project, so it is a
//     heavyweight read, not a polling target.
//   · projectId is REQUIRED (no default-project guessing on a report) → 400
//     when absent; unknown project → 404 { error: 'Project not found' }.
//   · Response CONTRACT (frontend codes against this — do not deviate):
//       { ok: true, data: { project: { id, name, budgetTotal, spent,
//         remaining, spentPct, progressPct },
//         phases: [ { id, name, budget, spent, variance, variancePct,
//           progressPct, txCount, codedSpent, codedTxnCount,
//           topTransactions: [ { id, note, amount, date } ] } ],
//         categories: [ { key, label, spent, txCount, share } ],
//         phaseAttribution: { mode, codedSpent, codedTxnCount,
//           milestoneDerivedSpent, milestoneDerivedTxnCount,
//           estimatedSpent, estimatedTxnCount } } }
//     variance = budget − spent (positive = under budget).
//     Per-phase spend is a three-tier attribution (issue #39): REAL phase
//     cost-codes (Transaction.phaseId) count directly; pre-code rows derive
//     exactly through milestone linkage; the uncoded remainder is the
//     documented budget-share estimate — phaseAttribution states which mode
//     produced the numbers. See the derivation notes in
//     src/backend/modules/reports/service.ts.
export const GET = route(
  {
    scope: 'api/reports/budget-variance GET',
    roles: ['contractor', 'admin', 'supervisor', 'qs'],
    rateLimit: { bucket: 'reports.budget-variance', limit: 30, windowMs: 60_000 },
    onError: genericError(500, 'Failed to build budget variance report'),
  },
  async (req: NextRequest) => {
    const projectId = req.nextUrl.searchParams.get('projectId')?.trim()
    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    }
    const report = await buildBudgetVarianceReport(projectId)
    if (!report) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, data: report })
  },
)
