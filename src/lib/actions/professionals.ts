// Professionals directory actions — upsert entries, record credential checks,
// assign professionals to parcels. Dispatched from lib/mjengo.ts applyAction(),
// which auto-writes the AuditEvent for every success — never log manually here.
//
// House rules:
//  - Credential findings are honest observations ("licence expired — renewal
//    pending") recorded with who checked + how.
//  - verificationState (0-6) is a platform ladder from recorded checks + history
//    — never a government certification claim.
//
// STUB (F-1): every action throws until agent 2-b lands the module.

export const PROFESSIONALS_ACTIONS = [
  'professional.upsert', // { id?, name, category, organisation?, phone?, email?, county?, licenceNumber?, licenceBody?, notes? }
  'professional.update', // { id, ...fields } — partial update of a directory entry
  'credential.record', // { professionalId, checkedBy, method: 'document_review'|'reference_call'|'registry_lookup', finding }
  'assignment.create', // { parcelId, professionalId, role: 'surveyor'|'advocate'|'engineer'|'qty_surveyor', note? }
  'assignment.update', // { id, status: 'active'|'completed'|'withdrawn', note? }
  'assignment.remove', // { id } — withdraw + remove an assignment
] as const

// ---------------- dispatcher (stub) ----------------

export async function applyProfessionalsAction(type: string, _payload: any, _projectId: string): Promise<any> {
  // Phase-2 (agent 2-b) implements the switch over PROFESSIONALS_ACTIONS here.
  throw new Error(`Not implemented yet — landing with phase 2 (professionals action: ${type})`)
}
