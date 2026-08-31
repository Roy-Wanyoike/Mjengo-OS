// MjengoOS professionals directory actions — upsert entries, record credential
// checks, assign professionals to parcels. Dispatched from lib/mjengo.ts
// applyAction(), which auto-writes the AuditEvent for every success — never
// log manually here.
//
// House rules:
//  - Credential findings are honest observations ("licence expired — renewal
//    pending") recorded with who checked + how.
//  - verificationState (0-6) is a platform ladder from recorded checks + history
//    — never a government certification claim. LSK/EBK/BORAQS stay the
//    authoritative sources; MjengoOS does not issue licences.
//  - Clients are read-only on the directory (no professionals action is in
//    CLIENT_ACTIONS; see src/modules/professionals/policy.ts for the matrix).
//
// Thin controller, fat service: this dispatcher only routes; every rule lives
// in src/modules/professionals/service.ts.

import {
  upsertProfessional,
  updateProfessional,
  recordCredentialCheck,
  createAssignment,
  updateAssignment,
  removeAssignment,
} from '@/modules/professionals/service'

export const PROFESSIONALS_ACTIONS = [
  'professional.upsert', // { id?, name, category, organisation?, phone?, email?, county?, licenceNumber?, licenceBody?, notes? } — new entries start UNVERIFIED (state 0)
  'professional.update', // { id, ...fields, verificationState? } — state moves are deliberate
  'credential.record', // { professionalId, method: 'document_review'|'reference_call'|'registry_lookup', finding, checkedBy? } — records a CredentialCheck, ladder +1 (max 5)
  'assignment.create', // { parcelId, professionalId, role: 'surveyor'|'advocate'|'engineer'|'qty_surveyor', note? } → INVITED
  'assignment.update', // { id, status: 'invited'|'active'|'done' } (+ legacy completed/withdrawn)
  'assignment.remove', // { id } — withdraw + remove an assignment
] as const

// ---------------- dispatcher ----------------

export async function applyProfessionalsAction(type: string, payload: any, projectId: string): Promise<any> {
  switch (type) {
    case 'professional.upsert':
      return upsertProfessional(projectId, payload ?? {})
    case 'professional.update':
      return updateProfessional(projectId, payload ?? {})
    case 'credential.record':
      return recordCredentialCheck(projectId, payload ?? {})
    case 'assignment.create':
      return createAssignment(projectId, payload ?? {})
    case 'assignment.update':
      return updateAssignment(projectId, payload ?? {})
    case 'assignment.remove':
      return removeAssignment(projectId, payload ?? {})
    default:
      throw new Error(`Unknown professionals action: ${type}`)
  }
}
