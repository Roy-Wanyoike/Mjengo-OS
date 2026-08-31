// Invoices module — role permissions.
//
// Working rules (Finder spec §8-§14 + money house rules):
//   client     · decide submitted invoices (approve/reject) · pay approved
//               invoices · file disputes (invoice.update { status: 'disputed' })
//   contractor · create drafts · edit drafts · submit to the queue · run the
//               3-way check · view everything (decisions/payments are NOT theirs)
//   finance    · decide + pay (when a finance login exists; paidByRole records it)
//   supervisor · view + run checks (no decisions)
//   admin      · everything except impersonating the client decision — the
//               money gates stay human and role-honest
//   share_client (share link, no session) · decide + pay — /api/share already
//               restricts share-link traffic to the client allowlist, so a
//               null-role caller reaching the appliers is client-gated upstream.
//
// Hard gates (enforced in service.ts, mirrored here for documentation):
//   - payment never auto-releases when the 3-way match fails — the payer must
//     explicitly acknowledge the discrepancy (warn + human decides)
//   - paying records exactly ONE Transaction ledger entry (no double count)
//   - paidByRole records WHO released the money (accountability trail)
//   - the invoice must be APPROVED before invoice.pay succeeds

import { currentActor } from './session'

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

/** Decisions & money belong to the payer role (client / finance / share link). */
export const DECIDER_ROLES: InvoicesRole[] = ['client', 'finance', 'share_client']

/** Role permission matrix. */
export function invoicesCan(role: InvoicesRole, action: InvoicesAction): boolean {
  switch (action) {
    case 'invoice.view':
    case 'invoice.threeWayCheck':
      return true // every project role sees the money trail honestly
    case 'invoice.create':
    case 'invoice.update':
    case 'invoice.submit':
      // draft work + dispute FILING is payer-side; drafts are site-team work.
      // (invoice.update { status: 'disputed' } is gated to deciders in the service.)
      return role === 'contractor' || role === 'supervisor' || role === 'admin' || role === 'finance'
    case 'invoice.decide':
    case 'invoice.pay':
    case 'invoice.dispute':
      return DECIDER_ROLES.includes(role)
    default:
      return false // deny-by-default
  }
}

/**
 * Map a resolved session role onto the matrix. No session (null) means the
 * call arrived through the share-link route, which only forwards
 * client-allowlisted actions → 'share_client'.
 */
export function roleForSession(sessionRole: string | null): InvoicesRole {
  if (sessionRole === null) return 'share_client'
  if (sessionRole === 'client') return 'client'
  if (sessionRole === 'finance') return 'finance'
  if (sessionRole === 'supervisor') return 'supervisor'
  if (sessionRole === 'admin') return 'admin'
  return 'contractor'
}

/** Convenience for documentation/tests: would the current session role allow this action? */
export async function currentSessionCan(action: InvoicesAction): Promise<boolean> {
  const actor = await currentActor()
  return invoicesCan(roleForSession(actor.role), action)
}
