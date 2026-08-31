// Professionals module — role permissions (stub, agent 2-b implements).
//
// Working rules (Finder spec + roadmap):
//   contractor  · add/edit directory entries · record credential checks
//                · assign professionals to parcels
//   supervisor  · record credential checks (field reference calls) · view all
//   client      · view directory + checks (read-only)
//   admin       · everything the contractor can do
//   share client· read-only
//
// Honesty guardrail: findings are recorded observations. The UI must never
// present verificationState as government certification.

export type ProfessionalsRole = 'contractor' | 'supervisor' | 'client' | 'finance' | 'admin' | 'share_client'
export type ProfessionalsAction =
  | 'directory.view'
  | 'professional.upsert'
  | 'credential.record'
  | 'assignment.create'
  | 'assignment.update'

/** Role permission matrix — stub, agent 2-b implements the real checks. */
export function professionalsCan(_role: ProfessionalsRole, _action: ProfessionalsAction): boolean {
  return false // deny-by-default until phase 2 implements the matrix
}
