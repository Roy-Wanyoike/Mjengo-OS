// Professionals module — role permissions.
//
// Working rules (Finder spec + roadmap §9/§12), implemented for real:
//   contractor  · add/edit directory entries · record credential checks
//                · assign professionals to parcels · update/remove assignments
//   supervisor  · record credential checks (field reference calls) · view all
//   client      · view directory + checks (read-only — also enforced server
//                side: no professionals action is in CLIENT_ACTIONS)
//   finance     · view only (payment workflows read the directory)
//   admin       · everything the contractor can do
//   share client· read-only view of the directory
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
  | 'assignment.remove'

const MATRIX: Record<ProfessionalsRole, ProfessionalsAction[]> = {
  contractor: [
    'directory.view',
    'professional.upsert',
    'credential.record',
    'assignment.create',
    'assignment.update',
    'assignment.remove',
  ],
  admin: [
    'directory.view',
    'professional.upsert',
    'credential.record',
    'assignment.create',
    'assignment.update',
    'assignment.remove',
  ],
  supervisor: ['directory.view', 'credential.record'],
  client: ['directory.view'],
  finance: ['directory.view'],
  share_client: ['directory.view'],
}

/** Role permission matrix — deny-by-default. */
export function professionalsCan(role: ProfessionalsRole, action: ProfessionalsAction): boolean {
  return (MATRIX[role] ?? []).includes(action)
}
