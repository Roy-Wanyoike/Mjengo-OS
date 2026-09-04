import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { orderRef, supplyOrderDetailQuery, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied } from './scope'
import { deliveryRecord, supplyOrderSummary } from './supply-rows'

// /api/v1/supply/orders/:id (Phase B, read-only) —
// src/app/api/v1/supply/orders/[id]/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/supply/orders/:id — one purchase order with its lines and its
 * delivery-verification records (per-line counts, inspection condition,
 * evidence-photo refs as attachment ids only — no bytes, no storage URLs).
 *
 * FEATURE FLAG: gated by `marketplace` like the rest of the v1 supply family
 * (OFF → 403 for non-admins; admins bypass).
 *
 * ROLE SCOPING: resolve first, pin second (the v1 payments precedent) — the
 * id (cuid) OR orderCode (e.g. PO-2026-000012) resolves the order, then a
 * client-role session must be pinned to the order's own project (else 403
 * 'Not permitted for this project'). Unknown order → 404.
 *
 * DATA (honest seam note): the supply module has no public single-order read
 * (its public read is the whole loadSupplySlice network), so the detail rows
 * are read here with the same includes — the wallet-transactions precedent
 * ("route-layer implementation; the module is left untouched"). Pagination
 * does not apply (one object). Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'supply/orders/:id GET',
    rateLimit: { bucket: 'v1.supply.order.get', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('supply/orders/:id GET', e, 'Supply order detail failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    // Feature flag (spec §81, task 9-a) — the uniform marketplace gate.
    const flagDenied = await requireFlagOn('marketplace', session)
    if (flagDenied) return flagDenied

    const { id } = await ctx.params
    const idRef = orderRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, supplyOrderDetailQuery)
    if (!q.ok) return q.response

    const order = await db.purchaseOrder.findFirst({
      where: { OR: [{ id }, { orderCode: id }] },
      include: {
        lines: true,
        supplier: true,
        request: { select: { requestCode: true } },
        deliveries: {
          include: { lines: true, photos: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    })
    if (!order) return v1Err(404, 'Order not found')
    const denied = clientProjectDenied(session, order.projectId)
    if (denied) return denied

    return v1Ok({
      ...supplyOrderSummary({
        id: order.id,
        orderCode: order.orderCode,
        status: order.status,
        supplierId: order.supplierId,
        supplierName: order.supplier.businessName,
        requestCode: order.request?.requestCode ?? null,
        subtotal: order.subtotal,
        deliveryFee: order.deliveryFee,
        total: order.total,
        paymentSource: order.paymentSource,
        createdByRole: order.createdByRole,
        note: order.note,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        deliveries: order.deliveries,
      }),
      lines: order.lines.map((l) => ({
        id: l.id,
        name: l.name,
        unit: l.unit,
        qty: l.qty,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      })),
      deliveries: order.deliveries.map((d) => deliveryRecord(d, order)),
    })
  },
)
