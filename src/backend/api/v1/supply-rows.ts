// /api/v1 Phase B (supply) — row mappers shared by the three supply-resource
// handlers (supply-orders.ts, supply-order-detail.ts, project-deliveries.ts).
//
// Structural input types (no '@prisma/client' model imports): the rows come
// from EITHER modules/supply/repository.loadSupplySlice (the module's public
// read — OrderWithDetail / DeliveryWithLines) or the detail route's own
// include-read; both satisfy these shapes. Field-for-field honest projection:
//   · NO photo bytes and NO storageKey URLs anywhere — photos surface as
//     ATTACHMENT IDS ONLY (the OpenAPI description says so; the bytes are
//     served by the app's own storage seam, not by /api/v1).
//   · photoCount is the DENORMALIZED mirror receiveDelivery recomputes from
//     the real DeliveryPhoto links (an honest count, never client-supplied).
//   · short/shortLines mirror receiveDelivery's short-line predicate exactly
//     (qtyReceived < qtyOrdered — the same check that sets status
//     'discrepancy'); no new verification math is invented here.

import type { PurchaseOrderLine } from '@prisma/client'

const iso = (v: Date | null): string | null => (v ? v.toISOString() : null)

/** Fields every supply-order DTO head carries (list item = detail head). */
export interface SupplyOrderRow {
  id: string
  orderCode: string
  status: string
  supplierId: string
  supplierName: string
  requestCode: string | null
  subtotal: number
  deliveryFee: number
  total: number
  paymentSource: string
  createdByRole: string
  note: string | null
  createdAt: Date
  updatedAt: Date
  deliveries: unknown[]
}

/** The supply-order summary (id/code/status/supplier/money + deliveryCount). */
export function supplyOrderSummary(o: SupplyOrderRow) {
  return {
    id: o.id,
    orderCode: o.orderCode,
    status: o.status,
    supplierId: o.supplierId,
    supplierName: o.supplierName,
    requestCode: o.requestCode,
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    total: o.total,
    paymentSource: o.paymentSource,
    createdByRole: o.createdByRole,
    note: o.note,
    deliveryCount: o.deliveries.length,
    createdAt: iso(o.createdAt),
    updatedAt: iso(o.updatedAt),
  }
}

/** A delivery-verification record (structural: loadSupplySlice rows or the detail include). */
export interface DeliveryRow {
  id: string
  orderId: string
  status: string
  dispatchedAt: Date | null
  receivedAt: Date | null
  receivedBy: string | null
  note: string | null
  driverName: string | null
  driverPhone: string | null
  vehicleReg: string | null
  etaAt: Date | null
  departedAt: Date | null
  arrivedAt: Date | null
  gpsLat: number | null
  gpsLng: number | null
  photoCount: number
  createdAt: Date
  lines: Array<{
    id: string
    orderLineId: string
    qtyOrdered: number
    qtyReceived: number
    qtyRejected: number
    condition: string
    damageNote: string | null
  }>
  photos: Array<{
    attachmentId: string
    deliveryLineId: string | null
    attachedBy: string
    createdAt: Date
  }>
}

/**
 * One delivery-verification record against its purchase order: status, the
 * §26 driver leg, per-line ordered vs received vs rejected counts with
 * inspection condition, and evidence-photo refs as ATTACHMENT IDS ONLY.
 */
export function deliveryRecord(d: DeliveryRow, order: { orderCode: string; lines: PurchaseOrderLine[] }) {
  const orderLine = (orderLineId: string) => order.lines.find((l) => l.id === orderLineId)
  const short = (l: DeliveryRow['lines'][number]) => l.qtyReceived < l.qtyOrdered
  return {
    id: d.id,
    orderId: d.orderId,
    orderCode: order.orderCode,
    status: d.status,
    dispatchedAt: iso(d.dispatchedAt),
    receivedAt: iso(d.receivedAt),
    receivedBy: d.receivedBy,
    note: d.note,
    driverName: d.driverName,
    driverPhone: d.driverPhone,
    vehicleReg: d.vehicleReg,
    etaAt: iso(d.etaAt),
    departedAt: iso(d.departedAt),
    arrivedAt: iso(d.arrivedAt),
    gpsLat: d.gpsLat,
    gpsLng: d.gpsLng,
    photoCount: d.photoCount,
    photos: d.photos.map((p) => ({
      attachmentId: p.attachmentId,
      deliveryLineId: p.deliveryLineId,
      attachedBy: p.attachedBy,
      createdAt: iso(p.createdAt),
    })),
    lines: d.lines.map((l) => ({
      id: l.id,
      orderLineId: l.orderLineId,
      name: orderLine(l.orderLineId)?.name ?? null,
      unit: orderLine(l.orderLineId)?.unit ?? null,
      qtyOrdered: l.qtyOrdered,
      qtyReceived: l.qtyReceived,
      qtyRejected: l.qtyRejected,
      condition: l.condition,
      damageNote: l.damageNote,
      short: short(l),
    })),
    shortLines: d.lines.filter(short).length,
    createdAt: iso(d.createdAt),
  }
}
