// Intel module — role permissions (stub, agent 2-e implements).
//
// Intel is read-mostly. The engines run on demand or on events:
//   contractor / supervisor / client / finance / admin · view intel (risk,
//     digests, price trends); recompute allowed for contractor + admin
//   share client · view intel (digest + prices are client-friendly)
//
// Guardrails: risk findings describe patterns ("spend 12% ahead of plan"),
// never people ("thief"). Scores are deterministic + versioned so a finding
// can always be traced back to its rule.

export type IntelRole = 'contractor' | 'supervisor' | 'client' | 'finance' | 'admin' | 'share_client'
export type IntelAction = 'intel.view' | 'risk.recompute' | 'digest.generate' | 'price.record'

/** Role permission matrix — stub, agent 2-e implements the real checks. */
export function intelCan(_role: IntelRole, _action: IntelAction): boolean {
  return false // deny-by-default until phase 2 implements the matrix
}
