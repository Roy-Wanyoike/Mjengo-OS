import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { loadSupplySlice } from '@/backend/modules/supply/repository'
import { projectIdRef, projectDeliveriesQuery, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied } from './scope'
import { deliveryRecord } from './supply-rows'

// /api/v1/projects/:id/deliveries (Phase B, read-only — the supply resource's
// delivery-verification surface, nested under its project) —
// src/app/api/v1/projects/[id]/deliveries/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/deliveries — the delivery-verification records of
 * one project: every OrderDelivery against every purchase order of the
 * project (status, driver leg, per-line ordered vs received vs rejected
 * counts, inspection condition, discrepancy flags, photo refs as ATTACHMENT
 * IDS ONLY — no photo bytes and no storage URLs in /api/v1; the OpenAPI
 * description says so explicitly).
 *
 * FEATURE FLAG (spec §81, task 9-a): gated by `marketplace` — this is the
 * supply loop's ground truth (the same data the Finder deliveries tab
 * renders), so the v1 supply family gate applies: OFF → 403 for non-admin
 * sessions (admins bypass; see flags.ts). The projects resource itself is
 * NOT flag-gated (no flag names it); only this supply-owned subresource is.
 *
 * ROLE SCOPING: client-role sessions pinned to their own project (foreign →
 * 403); unknown project → 404; every other signed-in role may read.
 *
 * QUERY: ?status= (dispatched|in_transit|arrived|received|discrepancy,
 * filters before pagination) + ?limit/?cursor (delivery id of the last item
 * of the previous page; a cursor that falls out of the filtered list → 400).
 *
 * DATA: loadSupplySlice(projectId) — the supply module's public read (the
 * deliveries ride the orders' include). Flattened and ordered (createdAt
 * DESC, id DESC) for a deterministic keyset; the per-project delivery set is
 * bounded in practice, so pagination slices in the route layer (the
 * wallet-list pattern). Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/deliveries GET',
    rateLimit: { bucket: 'v1.projects.deliveries', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/deliveries GET', e, 'Project deliveries failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    // Feature flag (spec §81, task 9-a) — the uniform marketplace gate.
    const flagDenied = await requireFlagOn('marketplace', session)
    if (flagDenied) return flagDenied

    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectDeliveriesQuery)
    if (!q.ok) return q.response

    // Unknown project → 404 (an honest "nothing here", not an empty page).
    const project = await db.project.findUnique({ where: { id } })
    if (!project) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, id)
    if (denied) return denied

    const slice = await loadSupplySlice(id)
    // pageOfKind needs { id } rows; carry the owning order alongside for
    // orderCode + line-name lookups.
    let rows = slice.orders.flatMap((o) => o.deliveries.map((d) => ({ id: d.id, d, o })))
    if (q.data.status) {
      rows = rows.filter((r) => r.d.status === q.data.status)
    }
    // Deterministic keyset order: (createdAt DESC, id DESC).
    rows = [...rows].sort(
      (a, b) =>
        b.d.createdAt.getTime() - a.d.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )

    const p = pageOfKind(rows, q.data.limit, q.data.cursor, 'a delivery')
    if (!p.ok) return p.response
    return v1Ok(
      p.page.items.map(({ d, o }) => deliveryRecord(d, o)),
      { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore },
    )
  },
)
