// Invoice actions — supplier invoice lifecycle: draft → submitted → decided →
// paid. Dispatched from lib/mjengo.ts applyAction(), which auto-writes the
// AuditEvent for every success — never log manually here.
//
// House rules:
//  - Paying an invoice writes exactly ONE Transaction ledger entry (no double
//    counting with the seeded historical ledger).
//  - The 3-way match (PO vs invoice vs delivery) BLOCKS auto-release on
//    mismatch — warn, an authorized human decides.
//  - The client decides approvals; finance releases payments.
//
// STUB (F-1): every action throws until agent 2-d lands the module.

export const INVOICE_ACTIONS = [
  'invoice.create', // { orderId?, supplierId?, lines: [{ name, qty, unitPrice }], tax?, dueDate?, note? } — draft
  'invoice.update', // { id, lines?, tax?, dueDate?, note? } — edit while DRAFT
  'invoice.submit', // { id } — into the client/finance decision queue
  'invoice.decide', // { id, decision: 'approve'|'reject'|'dispute', by, note? } — client decision
  'invoice.pay', // { id, method: 'mpesa'|'bank'|'card'|'wallet'|'cash', reference?, paidByRole, by? } — writes Transaction
  'invoice.threeWayCheck', // { id } — PO vs invoice vs delivery match report (warn-only)
] as const

// ---------------- dispatcher (stub) ----------------

export async function applyInvoiceAction(type: string, _payload: any, _projectId: string): Promise<any> {
  // Phase-2 (agent 2-d) implements the switch over INVOICE_ACTIONS here.
  throw new Error(`Not implemented yet — landing with phase 2 (invoice action: ${type})`)
}
