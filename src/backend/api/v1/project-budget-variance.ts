import { route } from '@/backend/lib/route-kit'
import { buildBudgetVarianceReport } from '@/backend/modules/reports/service'
import { projectIdRef, projectBudgetVarianceQuery, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok } from './respond'

// /api/v1/projects/:id/budget-variance (Phase D, read-only — the reports
// family) — src/app/api/v1/projects/[id]/budget-variance/route.ts is the
// shim. The v1 MIRROR of /api/reports/budget-variance (W3-B): same service
// call, same report contract, same role gate and the same heavyweight-read
// rate limit — only the shape of the request moved (path param instead of
// ?projectId=) and the errors adopt the v1 { error, field? } contract.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/budget-variance — the QS budget-variance report
 * (W3-B) on the v1 surface: project rollup (budgetTotal = Σ Phase.budget,
 * spent = Σ Transaction.amount — the exact ProjectSummary derivations, so it
 * can never disagree with the dashboard), per-phase three-tier attribution
 * (real phase cost-codes / milestone-linked derivation / documented
 * budget-share estimate — phaseAttribution states which mode produced the
 * numbers), categories by Transaction.type, and the 5 largest transactions
 * per phase. See modules/reports/service.ts for the derivation notes.
 *
 * ROLE SCOPING mirrors /api/reports/budget-variance exactly: contractor /
 * admin / supervisor / qs (the site team that works the cost plan) — client,
 * finance, procurement and supplier sessions are not on this surface (403
 * with the honest role message; the guard's role gate, fail closed).
 *
 * RATE LIMIT: 30/min per principal (NOT the 120/min v1 read convention — a
 * deliberate, documented deviation mirroring the app route: the derivation
 * walks every transaction of the project, so it is a heavyweight read, not a
 * polling target; the app route's own bucket is 'reports.budget-variance').
 *
 * Unknown project → 404 'Project not found' (buildBudgetVarianceReport
 * returns null — an honest "nothing here", never an empty report). Pagination
 * does not apply (one report object).
 */
export const GET = route(
  {
    scope: 'projects/:id/budget-variance GET',
    roles: ['contractor', 'admin', 'supervisor', 'qs'],
    rateLimit: { bucket: 'v1.projects.budget-variance', limit: 30, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/budget-variance GET', e, 'Failed to build budget variance report'),
  },
  async (req, _session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectBudgetVarianceQuery)
    if (!q.ok) return q.response

    // The app route's exact logic: null → 404, report → { ok, data }.
    const report = await buildBudgetVarianceReport(id)
    if (!report) return v1Err(404, 'Project not found')
    return v1Ok(report)
  },
)
