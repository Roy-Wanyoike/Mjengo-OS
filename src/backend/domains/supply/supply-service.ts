import { db } from '@/lib/db'
import type { MjengoSessionUser } from '@/lib/auth'
import { badRequest, fieldNonNeg, fieldPos, fieldStr, notFound, optionalId } from '@/backend/core/http'
import { logAudit } from '@/backend/core/audit'

/**
 * Supply-chain trust service.
 *
 * HONESTY RULES
 *  · A mismatch is stated plainly ("short delivery", "N% above benchmark") —
 *    never called fraud, never a "score".
 *  · Supplier trust counters are recomputed from the order ledger after every
 *    verification, so the directory always reflects evidence, not opinion.
 *
 * TRUST RULES (recomputeSupplierTrust)
 *  · status "verified"   — ≥80% of orders verified AND fewer than 2 mismatches
 *  · status "watchlist"  — <50% verified OR ≥2 mismatches
 *  · status "new"        — no order history yet
 *  · onTimeRate counts verified deliveries over all delivered orders
 *  · priceFairness counts non-price-mismatch orders over ALL orders
 */

const ORDER_INCLUDE = { supplier: { select: { name: true } } } as const

/** Recompute a supplier's trust counters + status from their order ledger. */
export async function recomputeSupplierTrust(supplierId: string) {
  return db.$transaction(async (tx) => {
    const orders = await tx.supplyOrder.findMany({ where: { supplierId } })
    const total = orders.length
    const verified = orders.filter((o) => o.status === 'verified').length
    const mismatched = orders.filter((o) => o.status === 'mismatch').length
    const delivered = orders.filter(
      (o) => o.status === 'verified' || o.status === 'mismatch' || o.status === 'delivered',
    )
    const onTime = orders.filter((o) => o.status === 'verified').length
    const fair = orders.filter((o) => o.status !== 'mismatch' || !o.issue?.includes('price')).length
    const onTimeRate = delivered.length > 0 ? Math.round((onTime / delivered.length) * 100) : 0
    const priceFairness = total > 0 ? Math.round((fair / total) * 100) : 0
    const status =
      total === 0
        ? 'new'
        : verified / total >= 0.8 && mismatched < 2
          ? 'verified'
          : verified / total < 0.5 || mismatched >= 2
            ? 'watchlist'
            : 'new'
    return tx.supplier.update({
      where: { id: supplierId },
      data: { totalDeliveries: delivered.length, verifiedDeliveries: verified, onTimeRate, priceFairness, status },
    })
  })
}

/** GET payload: full supplier directory, project orders, market benchmarks. */
export async function listSupplyData(projectId: string | null) {
  const [suppliers, orders, benchmarks] = await Promise.all([
    db.supplier.findMany({ orderBy: { name: 'asc' } }),
    db.supplyOrder.findMany({
      where: projectId ? { projectId } : undefined,
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    }),
    db.priceBenchmark.findMany({ orderBy: { material: 'asc' } }),
  ])
  return { suppliers, orders, benchmarks }
}

/** action=order.create — record a new order against the market benchmark. */
export async function createOrder(body: Record<string, unknown>, actor: MjengoSessionUser) {
  const supplierId = fieldStr(body.supplierId, 'Pick a supplier from the directory')
  const materialName = fieldStr(body.materialName, 'Material name is required')
  const quantity = fieldPos(body.quantity, 'Quantity must be greater than 0')
  const unit = fieldStr(body.unit, 'Unit is required (bag, tonne, lorry…)')
  const unitCost = fieldPos(body.unitCost, 'Unit cost and market benchmark must be greater than 0')
  const marketCost = fieldPos(body.marketCost, 'Unit cost and market benchmark must be greater than 0')
  const projectId = optionalId(body.projectId)

  const supplier = await db.supplier.findUnique({ where: { id: supplierId } })
  if (!supplier) badRequest('Pick a supplier from the directory')

  const order = await db.supplyOrder.create({
    data: {
      supplierId: supplier.id,
      projectId,
      materialName,
      quantity,
      unit,
      unitCost,
      marketCost,
      totalCost: Math.round(quantity * unitCost),
      status: 'ordered',
    },
    include: ORDER_INCLUDE,
  })

  if (projectId) {
    await logAudit(projectId, 'supply', actor, `Supply order created: ${quantity} ${unit} ${materialName} from ${supplier.name} (KES ${order.totalCost.toLocaleString()})`)
  }
  return { ok: true, order }
}

/** action=order.deliver — the truck arrived; verification comes next. */
export async function markDelivered(body: Record<string, unknown>, actor: MjengoSessionUser) {
  const orderId = fieldStr(body.orderId, 'Order id required')
  const order = await db.supplyOrder.findUnique({ where: { id: orderId } })
  if (!order) notFound('Order not found')
  if (order.status !== 'ordered') {
    badRequest(`Only ordered items can be marked delivered (this one is ${order.status})`)
  }

  const updated = await db.supplyOrder.update({
    where: { id: order.id },
    data: { status: 'delivered', deliveredAt: new Date() },
    include: ORDER_INCLUDE,
  })
  if (order.projectId) {
    await logAudit(order.projectId, 'supply', actor, `Delivery received: ${order.quantity} ${order.unit} ${order.materialName} from ${updated.supplier.name} — awaiting verification`)
  }
  return { ok: true, order: updated }
}

/**
 * action=order.verify — record what ACTUALLY arrived vs what was invoiced.
 * Mismatch rules (stated plainly, never as "fraud"):
 *  · deliveredQuantity < ordered → "Short delivery"
 *  · unitCost > marketCost × 1.1 → "N% above benchmark"
 */
export async function verifyDelivery(body: Record<string, unknown>, actor: MjengoSessionUser) {
  const orderId = fieldStr(body.orderId, 'Order id required')
  const deliveredQty = fieldNonNeg(body.deliveredQuantity, 'Enter how many units actually arrived')

  const order = await db.supplyOrder.findUnique({ where: { id: orderId } })
  if (!order) notFound('Order not found')
  if (order.status !== 'delivered') {
    badRequest('Verify happens after delivery (mark it delivered first)')
  }

  let status: string = 'verified'
  let issue: string | null = null
  if (deliveredQty < order.quantity) {
    status = 'mismatch'
    issue = `Short delivery: ${deliveredQty} of ${order.quantity} ${order.unit} received vs invoiced`
  } else if (order.unitCost > order.marketCost * 1.1) {
    status = 'mismatch'
    const pct = Math.round(((order.unitCost - order.marketCost) / order.marketCost) * 100)
    issue = `unit price ${pct}% above benchmark (KES ${order.unitCost.toLocaleString()} vs ${order.marketCost.toLocaleString()})`
  }

  const updated = await db.supplyOrder.update({
    where: { id: order.id },
    data: { status, issue, verifiedAt: new Date() },
    include: ORDER_INCLUDE,
  })
  const supplier = await recomputeSupplierTrust(order.supplierId)

  if (order.projectId) {
    const verdict = status === 'verified'
      ? `Delivery verified: ${order.quantity} ${order.unit} ${order.materialName} matches invoice and market price`
      : `Mismatch recorded honestly: ${issue} (${updated.supplier.name} → ${supplier.status})`
    await logAudit(order.projectId, 'supply', actor, verdict)
  }
  return { ok: true, order: updated, supplier }
}
