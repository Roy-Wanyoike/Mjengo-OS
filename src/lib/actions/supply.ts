// MjengoOS Finder (supply & procurement) actions — requests, approvals, quotes,
// purchase orders, deliveries. Dispatched from lib/mjengo.ts applyAction(),
// which auto-writes the AuditEvent for every success — never log manually here.
//
// House rules (Finder spec):
//  - A request NEVER charges the wallet — payment flows through invoices only.
//  - The approval-rules engine (project-configurable, spec §11) decides WHICH
//    ROLE approves; under-limit may auto-approve, over-limit chains
//    supervisor → contractor → client → finance.
//  - Delivery receive captures ground truth (photos + GPS + per-line counts);
//    ordered ≠ received creates a DISCREPANCY record for review, never an
//    accusation. Payment does not auto-release on unmatched amounts.
//  - notify() (module notify) fires on events: approval.requested,
//    delivery.discrepancy, order.confirmed, quote.received…
//
// STUB (F-1): every action throws until agent 2-c lands the module.

export const SUPPLY_ACTIONS = [
  'supplier.upsert', // { id?, businessName, county, town?, phone?, email?, deliveryZones?, deliveryFeeBase?, ... }
  'catalog.upsert', // { supplierId, id?, name, unit, unitPrice, stockQty?, minOrderQty? }
  'request.create', // { lines: [{ materialName, unit, qty }], notes?, requestedByRole, requestedByName } — draft, wallet untouched
  'request.update', // { id, lines?, notes? } — edit while DRAFT
  'request.submit', // { id } — enters the approval engine
  'request.decide', // { id, decision: 'approve'|'reject', by, note? } — approval decision via rules
  'quote.request', // { requestId, supplierIds: string[] } — ask suppliers to quote
  'quote.receive', // { id, unitPrice, deliveryFee?, transportFee?, fees?, deliveryEta?, stockOk? } — landed-cost inputs
  'quote.decline', // { id, reason? } — supplier declined
  'order.create', // { requestId?, supplierId, lines: [{ name, unit, qty, unitPrice }], deliveryFee?, paymentSource?, createdByRole, note? }
  'order.update', // { id, note? } — edit while DRAFT
  'order.approve', // { id, by, note? } — via approval rules (Approval row + ledger)
  'order.send', // { id } — PO sent to supplier
  'order.confirm', // { id, note? } — supplier confirms availability/delivery/charge
  'order.dispatch', // { id, note? } — dispatch creates an OrderDelivery (DISPATCHED)
  'order.cancel', // { id, reason } — cancel with reason
  'order.close', // { id, note? } — close after completion
  'delivery.receive', // { orderId, lines: [{ orderLineId, qtyReceived }], receivedBy, note?, photoCount?, gpsLat?, gpsLng? } — per-line counts → discrepancy
  'delivery.dispatch', // { deliveryId, note? } — re-dispatch / update dispatch info
  'rule.upsert', // { id?, minAmount, maxAmount?, approverRole, priority?, active? } — approval policy
  'rule.delete', // { id } — remove an approval rule
  'supply.compare', // { materialName, qty, unit, radiusKm? } — landed-cost compare + ranking (read-side)
] as const

// ---------------- dispatcher (stub) ----------------

export async function applySupplyAction(type: string, _payload: any, _projectId: string): Promise<any> {
  // Phase-2 (agent 2-c) implements the switch over SUPPLY_ACTIONS here.
  throw new Error(`Not implemented yet — landing with phase 2 (supply action: ${type})`)
}
