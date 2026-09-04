import { route } from '@/backend/lib/route-kit'
import { getProjectPayload } from '@/backend/lib/mjengo'
import { procurementTotals } from '@/backend/modules/supply/insights'
import { projectDetailQuery, projectIdRef, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied } from './scope'

// /api/v1/projects/:id (Phase B, read-only) — src/app/api/v1/projects/[id]/route.ts
// is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id — one project plus its honest summary.
 *
 * ROLE SCOPING mirrors the webapp project guard (/api/project): client-role
 * sessions are pinned to their own project (a foreign id → 403 'Not
 * permitted for this project', the v1 payments precedent — resolve first,
 * pin second); every other signed-in role may read any project. Unknown id →
 * 404. No feature flag gates this resource (none of the five flags names the
 * projects surface).
 *
 * NUMBERS: every figure is an EXISTING aggregation — zero new money math.
 *   · getProjectPayload() (lib/mjengo) is the webapp's main read: its
 *     ProjectSummary supplies progressPct (budget-weighted phase progress),
 *     budgetTotal (Σ Phase.budget), budgetSpent (Σ Transaction.amount) and
 *     the plan deltas.
 *   · procurementTotals() (modules/supply/insights — the pure module the
 *     Finder dashboard consumes) supplies the procurement money view over the
 *     SAME supply slice, wired with the SAME mapping as
 *     finder/dashboard-section.tsx, so `committed` can never disagree with
 *     the webapp tile.
 *   · Task counts are plain counts of the payload's phase tasks.
 * HONEST OMISSION: project.shareToken is deliberately NOT exposed — it is a
 * bearer capability for share links, not a data field. heavyweight read (the
 * full payload aggregation), rate limit 120/min.
 */
export const GET = route(
  {
    scope: 'projects/:id GET',
    rateLimit: { bucket: 'v1.projects.get', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id GET', e, 'Project detail failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectDetailQuery)
    if (!q.ok) return q.response

    const payload = await getProjectPayload(id)
    if (!payload) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, payload.project.id)
    if (denied) return denied

    const tasks = payload.phases.flatMap((ph) => ph.tasks)
    // The exact finder-dashboard wiring (dashboard-section.tsx) over the same
    // supply slice — pure module, no drift.
    const procurement = procurementTotals(
      payload.supply.requests.map((r) => ({
        status: r.status,
        lines: r.lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })),
        quotes: r.quotes.map((qt) => ({ status: qt.status, totalLanded: qt.totalLanded })),
      })),
      payload.supply.orders.map((o) => ({
        status: o.status,
        total: o.total,
        lines: o.lines.map((l) => ({ id: l.id, name: l.name, unit: l.unit, qty: l.qty })),
        deliveries: o.deliveries.map((d) => ({
          status: d.status,
          lines: d.lines.map((dl) => ({ orderLineId: dl.orderLineId, qtyReceived: dl.qtyReceived })),
        })),
      })),
      payload.supply.approvals.map((a) => ({ decision: a.decision })),
      payload.supply.suppliers.map((s) => ({ catalogItems: s.catalogItems })),
    )

    const s = payload.summary
    return v1Ok({
      project: {
        id: payload.project.id,
        name: payload.project.name,
        client: payload.project.client,
        clientType: payload.project.clientType,
        location: payload.project.location,
        status: payload.project.status,
        // The contract budget field; the cost-plan rollup is budget.total (Σ Phase.budget).
        budget: payload.project.budget,
        startDate: payload.project.startDate.toISOString(),
        targetDate: payload.project.targetDate.toISOString(),
        createdAt: payload.project.createdAt.toISOString(),
        updatedAt: payload.project.updatedAt.toISOString(),
      },
      progressPct: s.progressPct,
      dayCount: s.dayCount,
      daysRemaining: s.daysRemaining,
      budget: {
        total: s.budgetTotal,
        spent: s.budgetSpent,
        spentPct: s.budgetSpentPct,
        plannedSpendPct: s.plannedSpendPct,
        spendVsPlanDeltaPct: s.spendVsPlanDelta,
      },
      procurement: {
        required: procurement.required,
        purchased: procurement.purchased,
        committed: procurement.committed,
        remaining: procurement.remaining,
        pendingRequests: procurement.pendingRequests,
        pendingApprovals: procurement.pendingApprovals,
        ordersInTransit: procurement.ordersInTransit,
        discrepancies: procurement.discrepancies,
      },
      tasks: {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === 'pending').length,
        inProgress: tasks.filter((t) => t.status === 'in_progress').length,
        done: tasks.filter((t) => t.status === 'done').length,
        blocked: tasks.filter((t) => t.status === 'blocked').length,
      },
      phases: payload.phases.length,
    })
  },
)
