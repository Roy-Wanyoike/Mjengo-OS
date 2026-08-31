// Invoices module — service layer (stub, phase-2 agent 2-d fills this in).
//
// Purpose: supplier invoice lifecycle, called from src/lib/actions/invoices.ts:
//   - create/update draft invoices (from a PO or standalone)
//   - submit to the client/decision queue
//   - decide (approve / reject / dispute) — decisions belong to the payer role
//   - record payment (method + reference) → writes a Transaction ledger entry
//     (type 'material' or 'invoice'; NEVER double-count — one Transaction per
//     paid invoice, and the escrow wallet is only touched for wallet sources)
//   - 3-way match: PO lines vs invoice lines vs delivery lines — mismatch
//     BLOCKS auto-release and warns (ordered 50 / invoiced 50 / received 48 →
//     "review required"; AI recommends, an authorized human decides)
//   - A-1-lite: wallet balance recomputed from the ledger + drift warning
//   - printable invoice view data
//
// Every mutation returns a plain object; applyAction() writes the AuditEvent.

import { db } from '@/lib/db'

/** Create a draft invoice (from a PO or standalone). Stub — phase 2 (2-d). */
export async function createInvoice(_projectId: string, _payload: Record<string, unknown>) {
  await db.$queryRaw`SELECT 1` // placeholder so the db import is used; remove when implementing
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Update invoice fields while still a draft. Stub — phase 2 (agent 2-d). */
export async function updateInvoice(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Submit an invoice to the decision queue. Stub — phase 2 (agent 2-d). */
export async function submitInvoice(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Approve / reject / dispute decision. Stub — phase 2 (agent 2-d). */
export async function decideInvoice(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Record payment (method + reference) → Transaction ledger entry. Stub. */
export async function payInvoice(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** 3-way match report (PO vs invoice vs delivery lines). Stub — phase 2. */
export async function threeWayMatch(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}
