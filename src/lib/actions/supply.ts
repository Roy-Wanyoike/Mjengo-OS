// MjengoOS Finder (supply & procurement) actions — the Find → Compare →
// Request → Approve → Order → Deliver → Verify loop. Dispatched from
// lib/mjengo.ts applyAction(), which auto-writes the AuditEvent for every
// success — never log manually here.
//
// House rules (Finder spec):
//  - A request NEVER charges the wallet — payment flows through invoices (2-d).
//  - The approval-rules engine (project-configurable, spec §11) decides WHICH
//    ROLE approves; under-limit may auto-approve, over-limit chains
//    supervisor → contractor → client → finance.
//  - Delivery receive captures ground truth (photos + GPS + per-line counts);
//    ordered ≠ received creates a DISCREPANCY record for review, never an
//    accusation. Payment does not auto-release on unmatched amounts.
//  - Notifications on events: approval.requested, request.approved,
//    order.sent, delivery.received, delivery.discrepancy (direct
//    db.notification.create — the notification center reads all rows).
//
// Thin controller, fat service: this dispatcher only routes; every rule lives
// in src/modules/supply/service.ts (pure math in compare.ts / insights.ts).

import {
  compareSuppliers,
  upsertSupplier,
  upsertCatalogItem,
  createRequest,
  updateRequest,
  submitRequest,
  decideApproval,
  requestQuotes,
  receiveQuote,
  declineQuote,
  createOrder,
  updateOrder,
  approveOrder,
  sendOrder,
  confirmOrder,
  dispatchOrder,
  cancelOrder,
  closeOrder,
  receiveDelivery,
  updateDispatch,
  upsertRule,
  deleteRule,
} from '@/modules/supply/service'

export const SUPPLY_ACTIONS = [
  'supplier.upsert', // { id?, businessName, county, town?, phone?, email?, deliveryFeeBase?, … } — network-global rows
  'catalog.upsert', // { supplierId, id?, name, unit, unitPrice, stockQty?, minOrderQty? }
  'request.create', // { lines: [{ materialName, unit, qty }], notes? } — draft, wallet untouched
  'request.update', // { id, lines?, notes? } — edit while DRAFT
  'request.submit', // { id } — enters the approval engine (§11 bands, est from quotes/catalog)
  'request.decide', // { id, decision: 'approve'|'reject', note? } — actor role must match a PENDING approval
  'quote.request', // { requestId, supplierIds: string[] } — ask suppliers to quote
  'quote.receive', // { id, unitPrice, deliveryFee?, transportFee?, fees?, deliveryEta?, stockOk? } — landed-cost inputs
  'quote.decline', // { id, reason? } — supplier declined
  'order.create', // { requestId, supplierId, quoteId?, paymentSource?, note? } — from an APPROVED request; PO-YYYY-000NNN
  'order.update', // { id, note? } — note edits (v1 orders are born approved)
  'order.approve', // { id, note? } — band-checked (only for draft/pending orders)
  'order.send', // { id } — PO sent to supplier (+notification)
  'order.confirm', // { id, note? } — supplier confirms availability/delivery/charge (simulated)
  'order.dispatch', // { orderId } — dispatch creates an OrderDelivery (DISPATCHED)
  'order.cancel', // { id, reason } — cancel with reason (from SENT/CONFIRMED)
  'order.close', // { id, note? } — close after verified delivery (from DELIVERED)
  'delivery.receive', // { deliveryId, lines: [{ orderLineId, qtyReceived }], note?, photoCount?, gpsLat?, gpsLng? } — per-line counts → discrepancy
  'delivery.dispatch', // { deliveryId, note? } — update dispatch info
  'rule.upsert', // { id?, minAmount, maxAmount?, approverRole, priority?, active? } — approval policy (§11)
  'rule.delete', // { id } — remove an approval rule
  'supply.compare', // { materialName, qty, radiusKm?, deliveryDay? } — landed-cost compare + ranking (read-side)
] as const

// ---------------- dispatcher ----------------

export async function applySupplyAction(type: string, payload: any, projectId: string): Promise<any> {
  switch (type) {
    case 'supplier.upsert':
      return upsertSupplier(projectId, payload ?? {})
    case 'catalog.upsert':
      return upsertCatalogItem(projectId, payload ?? {})
    case 'request.create':
      return createRequest(projectId, payload ?? {})
    case 'request.update':
      return updateRequest(projectId, payload ?? {})
    case 'request.submit':
      return submitRequest(projectId, payload ?? {})
    case 'request.decide':
      return decideApproval(projectId, payload ?? {})
    case 'quote.request':
      return requestQuotes(projectId, payload ?? {})
    case 'quote.receive':
      return receiveQuote(projectId, payload ?? {})
    case 'quote.decline':
      return declineQuote(projectId, payload ?? {})
    case 'order.create':
      return createOrder(projectId, payload ?? {})
    case 'order.update':
      return updateOrder(projectId, payload ?? {})
    case 'order.approve':
      return approveOrder(projectId, payload ?? {})
    case 'order.send':
      return sendOrder(projectId, payload ?? {})
    case 'order.confirm':
      return confirmOrder(projectId, payload ?? {})
    case 'order.dispatch':
      return dispatchOrder(projectId, payload ?? {})
    case 'order.cancel':
      return cancelOrder(projectId, payload ?? {})
    case 'order.close':
      return closeOrder(projectId, payload ?? {})
    case 'delivery.receive':
      return receiveDelivery(projectId, payload ?? {})
    case 'delivery.dispatch':
      return updateDispatch(projectId, payload ?? {})
    case 'rule.upsert':
      return upsertRule(projectId, payload ?? {})
    case 'rule.delete':
      return deleteRule(projectId, payload ?? {})
    case 'supply.compare':
      return compareSuppliers(projectId, payload ?? {})
    default:
      throw new Error(`Unknown supply action: ${type}`)
  }
}
