// Land & Property module — service layer (stub, phase-2 agent 2-a fills this in).
//
// Purpose: parcel lifecycle + title-search evidence flow, called from
// src/lib/actions/land.ts (never directly from a route):
//   - create/update parcels and set honest record status (searching/verified/flagged)
//   - attach parcel documents (existing upload API supplies the storageKey)
//   - request a registry title search, receive the registry result
//   - transcription-vs-registry consistency check (document extractedText vs
//     search resultSummary → consistent / mismatch / pending; mismatch is an
//     anomaly FLAG for human review, never an accusation)
//   - build the Property Passport card data (parcel + docs + searches + assignments)
//
// Every mutation returns a plain object; lib/mjengo.ts applyAction() writes the
// AuditEvent automatically — never log manually here.

import { db } from '@/lib/db'

/** Create a parcel. Stub — landing with phase 2 (agent 2-a). */
export async function createParcel(_projectId: string, _payload: Record<string, unknown>) {
  await db.$queryRaw`SELECT 1` // placeholder so the db import is used; remove when implementing
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Update parcel fields / status. Stub — landing with phase 2 (agent 2-a). */
export async function updateParcel(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Attach a document to a parcel. Stub — landing with phase 2 (agent 2-a). */
export async function attachParcelDocument(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Request a registry title search. Stub — landing with phase 2 (agent 2-a). */
export async function requestTitleSearch(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Receive a registry result + run the consistency check. Stub — phase 2 (2-a). */
export async function receiveTitleSearch(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Mark a received search as reviewed (human decision). Stub — phase 2 (2-a). */
export async function reviewTitleSearch(_projectId: string, _payload: Record<string, unknown>) {
  throw new Error('Not implemented yet — landing with phase 2')
}
