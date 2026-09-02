// Invoice actions — supplier invoice lifecycle: draft → submitted → decided →
// paid. Dispatched from lib/mjengo.ts applyAction(), which auto-writes the
// AuditEvent for every success — never log manually here.
//
// House rules:
//  - Paying an invoice writes exactly ONE Transaction ledger entry (no double
//    counting with the seeded historical ledger).
//  - The 3-way match (PO vs invoice vs delivery) BLOCKS auto-release on
//    mismatch — warn, an authorized human decides (acknowledgeMismatch).
//  - Only the client (or finance / a share link) decides and pays; the role
//    is resolved server-side from the session, never from the payload.
//
// All logic lives in src/backend/modules/invoices/service.ts — this file only routes.

import {
  createInvoice,
  updateInvoice,
  submitInvoice,
  decideInvoice,
  payInvoice,
  threeWayCheck,
} from '@/backend/modules/invoices/service'

export const INVOICE_ACTIONS = [
  'invoice.create', // { orderId?, supplierId?, lines: [{ name, qty, unitPrice }], tax?, dueDate?, note? } — draft
  'invoice.update', // { id, lines?, tax?, dueDate?, note? } — edit while DRAFT · { id, status: 'disputed', note } — dispute while SUBMITTED/APPROVED
  'invoice.submit', // { id } — into the client/finance decision queue
  'invoice.decide', // { id, decision: 'approve'|'reject', by?, note? } — client decision
  'invoice.pay', // { id, method: 'mpesa'|'bank'|'card'|'wallet'|'cash', reference?, costCode?, acknowledgeMismatch?, by? } — provider seam + double-entry ledger (ledgerTxnId on the Transaction row)
  'invoice.threeWayCheck', // { id } — PO vs invoice vs delivery match report (warn-only)
] as const

// ---------------- dispatcher ----------------

export async function applyInvoiceAction(type: string, payload: any, projectId: string): Promise<any> {
  switch (type) {
    case 'invoice.create':
      return createInvoice(projectId, payload ?? {})
    case 'invoice.update':
      return updateInvoice(projectId, payload ?? {})
    case 'invoice.submit':
      return submitInvoice(projectId, payload ?? {})
    case 'invoice.decide':
      return decideInvoice(projectId, payload ?? {})
    case 'invoice.pay':
      return payInvoice(projectId, payload ?? {})
    case 'invoice.threeWayCheck':
      return threeWayCheck(projectId, payload ?? {})
    default:
      throw new Error(`Unknown invoice action: ${type}`)
  }
}
