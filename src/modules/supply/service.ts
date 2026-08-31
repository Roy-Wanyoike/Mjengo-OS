// Supply & procurement (MjengoOS Finder) module — service layer (stub, agent 2-c).
//
// Purpose: the Find → Compare → Order → Approve → Pay → Deliver → Verify loop,
// called from src/lib/actions/supply.ts:
//   - search + compare suppliers (landed-cost engine:
//     product + delivery + transport + fees = total landed; weighted ranking on
//     price, distance, stock, delivery ETA, supplier reliability — show BEST
//     OVERALL, not just cheapest unit price)
//   - "Find Materials Near This Site" (project location + radius + qty + date)
//   - material request create/submit; approval rules engine (Finder §11) +
//     decisions (Approval rows)
//   - quote request/receive/decline
//   - PO lifecycle: create → approve → send → confirm → dispatch → deliver
//   - delivery receive with evidence (photos/GPS/note + per-line counts →
//     discrepancy records; ordered 50 / received 48 = flagged, human decides)
//   - notify() calls on events (approval.requested, delivery.discrepancy…)
//
// Wallet rule (Finder §2): requests do NOT charge the wallet — payment happens
// through the invoices module only. Every mutation returns a plain object;
// applyAction() writes the AuditEvent automatically.

import { db } from '@/lib/db'

/** Upsert supplier / catalog rows. Stub — landing with phase 2 (agent 2-c). */
export async function upsertSupplier(_projectId: string, _payload: Record<string, unknown>) {
  await db.$queryRaw`SELECT 1` // placeholder so the db import is used; remove when implementing
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Create a material request (draft — wallet untouched). Stub — phase 2 (2-c). */
export async function createRequest(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Submit a request for approval (approval engine decides the role). Stub. */
export async function submitRequest(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Record an approval decision on a request/order/invoice. Stub — phase 2. */
export async function decideApproval(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Request quotes from suppliers. Stub — landing with phase 2 (agent 2-c). */
export async function requestQuotes(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Receive a supplier quote (landed cost inputs). Stub — phase 2 (2-c). */
export async function receiveQuote(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Create a purchase order from a request/quote selection. Stub — phase 2. */
export async function createOrder(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** PO lifecycle advance (approve/send/confirm/dispatch/cancel). Stub — 2-c. */
export async function advanceOrder(_projectId: string, _type: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Receive a delivery with per-line counts + evidence → discrepancy. Stub. */
export async function receiveDelivery(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Landed-cost compare + ranking (read-side helper). Stub — phase 2 (2-c). */
export async function compareSuppliers(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}
