// Supply & procurement (Finder) module — role permissions (stub, agent 2-c).
//
// Finder spec §1 — who can INITIATE vs APPROVE vs PAY. Anyone authorized can
// request; the SYSTEM controls approval bands (§11) and payment:
//
//   Role             | Can
//   -----------------+-----------------------------------------------------------
//   client           | request · create orders · approve in band · pay invoices ·
//                    | set spending limits (approval rules)
//   contractor       | request · create orders · approve within limits · manage
//                    | suppliers/catalog · receive deliveries
//   site supervisor  | request · order within authorized limits · confirm delivery
//                    | (e.g. cannot approve above KES 100,000)
//   procurement off. | request quotes · compare · negotiate · create POs
//   finance          | approve invoices · release payments · reconcile
//
// Default approval bands (project-configurable ApprovalRule rows, spec §11):
//   < KES 10,000        → supervisor
//   KES 10,000–50,000   → contractor
//   KES 50,000–250,000  → client
//   > KES 250,000       → client + finance (chain)
//
// Payment NEVER auto-releases on unmatched 3-way totals (PO vs invoice vs
// delivery) — warn and let a human decide.

export type SupplyRole =
  | 'client' | 'contractor' | 'supervisor' | 'procurement' | 'finance' | 'admin' | 'share_client'
export type SupplyAction =
  | 'request.create' | 'request.submit'
  | 'quote.request' | 'quote.receive'
  | 'order.create' | 'order.approve' | 'order.send' | 'order.confirm'
  | 'order.dispatch' | 'order.cancel'
  | 'delivery.receive'
  | 'supplier.upsert' | 'catalog.upsert' | 'rule.upsert'
  | 'supply.view'

/** Role permission matrix — stub, agent 2-c implements the real checks. */
export function supplyCan(_role: SupplyRole, _action: SupplyAction): boolean {
  return false // deny-by-default until phase 2 implements the matrix
}

/** Resolve the approver role for an amount via the project's active rules. */
export function resolveApproverRole(_rules: Array<{ minAmount: number; maxAmount: number | null; approverRole: string; priority: number; active: boolean }>, _amount: number): string | null {
  return null // stub — agent 2-c implements first-match-by-priority
}
