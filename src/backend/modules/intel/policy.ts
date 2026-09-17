// Intel module — role permissions.
//
// Intel is read-mostly. The engines run on demand or on events:
//   contractor / supervisor / client / finance / admin · view intel (risk,
//     digests, price trends, reliability breakdowns, MjengoScore)
//   contractor / admin                                     · recompute risk + digest
//   contractor / admin                                     · recompute MjengoScore
//   contractor / supervisor / admin                        · record price points
//   contractor / admin                                     · recompute reliability
//   share client                                           · view intel (digest +
//     prices are client-friendly)
//
// Guardrails: risk findings describe patterns ("spend 12% ahead of plan"),
// never people ("thief"). Scores are deterministic + versioned so a finding
// can always be traced back to its rule. The MjengoScore describes contractor
// trust from evidence rows — it gates nothing, approves nothing.

export type IntelRole = 'contractor' | 'supervisor' | 'client' | 'finance' | 'admin' | 'share_client'
export type IntelAction =
  | 'intel.view' | 'risk.recompute' | 'score.recompute' | 'digest.generate'
  | 'price.record' | 'reliability.recompute'

const MATRIX: Record<IntelRole, IntelAction[]> = {
  contractor: ['intel.view', 'risk.recompute', 'score.recompute', 'digest.generate', 'price.record', 'reliability.recompute'],
  admin: ['intel.view', 'risk.recompute', 'score.recompute', 'digest.generate', 'price.record', 'reliability.recompute'],
  supervisor: ['intel.view', 'price.record'],
  client: ['intel.view'],
  finance: ['intel.view'],
  share_client: ['intel.view'],
}

/** Role permission matrix — implemented per the rules above. */
export function intelCan(role: IntelRole, action: IntelAction): boolean {
  return MATRIX[role]?.includes(action) ?? false
}
