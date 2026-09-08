import { route } from '@/backend/lib/route-kit'
import { getProjectPayload } from '@/backend/lib/mjengo'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { projectIdRef, projectSuppliersQuery, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierProjectDenied } from './scope'

// /api/v1/projects/:id/suppliers (Phase D, read-only — the supply/marketplace
// family) — src/app/api/v1/projects/[id]/suppliers/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/suppliers — the supplier catalog summary the
 * project's procurement sees (Finder §30): the marketplace directory rows
 * with their catalogs, plus the project's OWN relationship marks (saved
 * suppliers, order counts and landed totals of this project's POs).
 *
 * FEATURE FLAG (spec §81, task 9-a): the v1 supply family is gated by
 * `marketplace` — OFF → 403 'Feature disabled by feature flag (marketplace)'
 * for NON-ADMIN sessions (admins bypass; see flags.ts). The suppliers
 * catalog IS the Finder loop's directory, so the family gate applies here
 * exactly as it does to /api/v1/supply/orders.
 *
 * ROLE SCOPING: same as /api/v1/projects/:id (client pinned to their own
 * project, foreign → 403; unknown project → 404). W5-3: supplier sessions
 * are not project readers — uniform 403 (their OWN catalog is the
 * /api/supplier portal surface, never this buyer directory).
 *
 * HONEST SCOPE NOTE: Supplier rows are a GLOBAL directory (loadSupplySlice
 * loads the whole marketplace table — the same rows the webapp Finder
 * renders for this project); the project relationship is carried honestly
 * per row (savedByProject, orderCount, orderTotal computed from THIS
 * project's orders/quotes), never by silently filtering the directory.
 *
 * QUERY: ?q= free-text search on businessName/county/town (in-memory
 * contains, ASCII case-insensitive — the projects-list precedent) filters
 * BEFORE pagination. Pagination is the wallet-list pattern: a deterministic
 * (createdAt ASC, id ASC) total order sliced in the route layer. Rate limit:
 * 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/suppliers GET',
    rateLimit: { bucket: 'v1.projects.suppliers', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/suppliers GET', e, 'Project suppliers failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    // Feature flag (spec §81, task 9-a) — the uniform marketplace gate.
    const flagDenied = await requireFlagOn('marketplace', session)
    if (flagDenied) return flagDenied

    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectSuppliersQuery)
    if (!q.ok) return q.response

    const payload = await getProjectPayload(id)
    if (!payload) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, payload.project.id)
    if (denied) return denied
    // W5-3: supplier sessions are not project readers — uniform 403, no
    // buyer directory data returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    const savedIds = new Set(payload.supply.savedSupplierIds)
    // The project's OWN order relationship per supplier (this project's POs).
    const ordersBySupplier = new Map<string, { count: number; total: number }>()
    for (const o of payload.supply.orders) {
      const agg = ordersBySupplier.get(o.supplierId) ?? { count: 0, total: 0 }
      agg.count += 1
      agg.total += o.total
      ordersBySupplier.set(o.supplierId, agg)
    }

    let suppliers = payload.supply.suppliers
    if (q.data.q) {
      const needle = q.data.q.toLowerCase()
      suppliers = suppliers.filter(
        (s) =>
          s.businessName.toLowerCase().includes(needle) ||
          s.county.toLowerCase().includes(needle) ||
          (s.town ?? '').toLowerCase().includes(needle),
      )
    }
    // Deterministic keyset order: (createdAt ASC, id ASC).
    suppliers = [...suppliers].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )

    const rows = suppliers.map((s) => ({
      id: s.id,
      item: {
        id: s.id,
        businessName: s.businessName,
        county: s.county,
        town: s.town,
        phone: s.phone,
        email: s.email,
        verificationState: s.verificationState,
        reliabilityScore: s.reliabilityScore,
        responseHours: s.responseHours,
        deliveryFeeBase: s.deliveryFeeBase,
        minimumOrder: s.minimumOrder,
        freeDeliveryOver: s.freeDeliveryOver,
        deliveryZones: s.deliveryZones,
        operatingHours: s.operatingHours,
        savedByProject: savedIds.has(s.id),
        orderCount: ordersBySupplier.get(s.id)?.count ?? 0,
        orderTotal: ordersBySupplier.get(s.id)?.total ?? 0,
        catalogCount: s.catalogItems.length,
        catalog: s.catalogItems.map((c) => ({
          id: c.id,
          name: c.name,
          category: c.category,
          brand: c.brand,
          specification: c.specification,
          unit: c.unit,
          unitPrice: c.unitPrice,
          stockQty: c.stockQty,
          minOrderQty: c.minOrderQty,
          updatedAt: c.updatedAt.toISOString(),
        })),
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      },
    }))
    const p = pageOfKind(rows, q.data.limit, q.data.cursor, 'a supplier')
    if (!p.ok) return p.response

    return v1Ok(
      p.page.items.map((r) => r.item),
      { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore },
    )
  },
)
