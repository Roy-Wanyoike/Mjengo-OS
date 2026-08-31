// Invoices module — role permissions (stub, agent 2-d implements).
//
// Working rules (Finder spec §8-§14 + money house rules):
//   client     · decide submitted invoices (approve/reject/dispute) · pay
//   contractor · create drafts · submit · view (approve only within limits)
//   finance    · approve invoices · release payments · reconcile
//   supervisor · view (no decisions)
//   admin      · everything except impersonating the client decision
//
// Hard gates:
//   - payment never auto-releases when the 3-way match fails (warn + human)
//   - paying records exactly ONE Transaction ledger entry (no double count)
//   - paidByRole records WHO released the money (accountability trail)

export type InvoicesRole = 'contractor' | 'supervisor' | 'client' | 'finance' | 'admin' | 'share_client'
export type InvoicesAction =
  | 'invoice.view'
  | 'invoice.create'
  | 'invoice.update'
  | 'invoice.submit'
  | 'invoice.decide'
  | 'invoice.pay'
  | 'invoice.dispute'
  | 'invoice.threeWayCheck'

/** Role permission matrix — stub, agent 2-d implements the real checks. */
export function invoicesCan(_role: InvoicesRole, _action: InvoicesAction): boolean {
  return false // deny-by-default until phase 2 implements the matrix
}
