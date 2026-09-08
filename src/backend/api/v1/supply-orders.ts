import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { loadSupplySlice } from '@/backend/modules/supply/repository'
import { supplyOrdersQuery, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierSessionId } from './scope'
import { supplyOrderSummary } from './supply-rows'

// /api/v1/supply/orders (Phase B, read-only) —
// src/app/api/v1/supply/orders/route.ts is the shim.

/**
 * GET /api/v1/supply/orders — the purchase orders of ONE project.
 *
 * FEATURE FLAG (spec §81, task 9-a): the v1 supply family is gated by
 * `marketplace` — OFF → 403 'Feature disabled by feature flag (marketplace)'
 * for NON-ADMIN sessions (admins bypass; see flags.ts). This mirrors the
 * webapp: the flag hides the Finder tab entry for non-admins, and the v1
 * wallet family is gated the same way by `wallet`.
 *
 * ROLE SCOPING mirrors the webapp data guard: every signed-in role may read
 * (the Finder tab is visible to the whole site team + client); CLIENT-role
 * sessions are pinned to their own project — a foreign projectId → 403
 * 'Not permitted for this project' (the v1 payments precedent). SUPPLIER
 * sessions (W5-3) read the same resource ROW-PINNED to their own supplierId:
 * the list returns exactly their purchase orders in that project (a project
 * they have never sold to yields an honest empty page — never another
 * supplier's rows); a supplier with no linked supplier row → 403 (fail
 * closed, the client no-project pin's mirror).
 *
 * QUERY: projectId REQUIRED (the Finder surface is project-scoped — absent →
 * 400 'projectId must not be empty', mirroring the budget-variance report's
 * no-default-project-guessing rule); unknown project → 404; ?status= one of
 * the nine PurchaseOrder statuses (filters before pagination); ?limit +
 * ?cursor (order id of the last item of the previous page; a cursor that
 * falls out of the filtered list → 400).
 *
 * DATA: loadSupplySlice(projectId) is the supply module's public read — the
 * exact procurement network the webapp Finder tab renders (orders arrive
 * createdAt DESC with their deliveries; the id tiebreak below pins a
 * deterministic total order for the keyset). The per-project order set is
 * bounded in practice, so pagination slices in the route layer — the
 * wallet-list pattern. Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'supply/orders GET',
    rateLimit: { bucket: 'v1.supply.orders', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('supply/orders GET', e, 'Failed to list supply orders'),
  },
  async (req, session) => {
    // Feature flag (spec §81, task 9-a) — the uniform marketplace gate.
    const flagDenied = await requireFlagOn('marketplace', session)
    if (flagDenied) return flagDenied

    const q = validateQuery(req, supplyOrdersQuery)
    if (!q.ok) return q.response
    const projectId = q.data.projectId

    // Unknown project → 404 (an honest "nothing here", not an empty page).
    const project = await db.project.findUnique({ where: { id: projectId } })
    if (!project) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, projectId)
    if (denied) return denied
    // W5-3 supplier row pin: their orders only (fail closed with no link).
    const supplierId = supplierSessionId(session)
    if (session.user.role === 'supplier' && !supplierId) {
      return v1Err(403, 'Supplier account has no supplier linked')
    }

    const slice = await loadSupplySlice(projectId)
    let orders = slice.orders
    if (supplierId) {
      orders = orders.filter((o) => o.supplierId === supplierId)
    }
    if (q.data.status) {
      orders = orders.filter((o) => o.status === q.data.status)
    }
    // Deterministic keyset order: (createdAt DESC, id DESC).
    orders = [...orders].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )

    const p = pageOfKind(orders, q.data.limit, q.data.cursor, 'an order')
    if (!p.ok) return p.response
    return v1Ok(p.page.items.map(supplyOrderSummary), {
      nextCursor: p.page.nextCursor,
      hasMore: p.page.hasMore,
    })
  },
)
