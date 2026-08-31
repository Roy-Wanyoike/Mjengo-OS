// Professionals directory module — service layer (stub, phase-2 agent 2-b fills this in).
//
// Purpose: the trusted-directory workflow, called from
// src/lib/actions/professionals.ts:
//   - upsert professionals (name, category, licence body/number, county…)
//   - record credential checks (who checked, method, honest finding — e.g.
//     "licence expired — renewal pending")
//   - advance the honest verification ladder 0-6 from recorded checks +
//     platform history (never claim government certification)
//   - assign professionals to parcels (surveyor/advocate/engineer/QS) and
//     update assignment status
//
// Every mutation returns a plain object; applyAction() writes the AuditEvent.

import { db } from '@/lib/db'

/** Upsert a directory entry. Stub — landing with phase 2 (agent 2-b). */
export async function upsertProfessional(_projectId: string, _payload: Record<string, unknown>) {
  await db.$queryRaw`SELECT 1` // placeholder so the db import is used; remove when implementing
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Update professional fields. Stub — landing with phase 2 (agent 2-b). */
export async function updateProfessional(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Record a credential check (honest finding). Stub — phase 2 (agent 2-b). */
export async function recordCredentialCheck(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Assign a professional to a parcel. Stub — landing with phase 2 (agent 2-b). */
export async function createAssignment(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Update an assignment status. Stub — landing with phase 2 (agent 2-b). */
export async function updateAssignment(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}
