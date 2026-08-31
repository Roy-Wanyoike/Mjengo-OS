// Professionals directory module — types for the `professionals` slice.
//
// The slice carries the global professional directory with recorded credential
// checks, plus the project-scoped parcel assignments (surveyor / advocate /
// engineer / QS) so both the Professionals section and Land parcel cards can
// render assignments. verificationState is an honest 0-6 ladder — never a
// government certification claim.

import type { Professional, CredentialCheck, ParcelAssignment } from '@prisma/client'

// ---- domain enums ----

export type ProfessionalCategory = 'surveyor' | 'advocate' | 'engineer' | 'qty_surveyor' | 'architect'
export type LicenceBody = 'LSK' | 'EBK' | 'BORAQS' | 'other'
export type CheckMethod = 'document_review' | 'reference_call' | 'registry_lookup'

/**
 * Honest verification ladder (0-6):
 * 0 unrecorded · 1 details captured · 2 document reviewed · 3 reference checked
 * 4 registry-lookup consistent · 5 platform transaction history · 6 trusted
 */
export type VerificationState = 0 | 1 | 2 | 3 | 4 | 5 | 6

// ---- slice shapes ----

/** Directory entry with its recorded checks + project assignment count. */
export interface ProfessionalWithChecks extends Professional {
  credentialChecks: CredentialCheck[]
  assignmentCount: number
}

/** Project-scoped assignment flattened for list rendering. */
export interface AssignmentDetail extends ParcelAssignment {
  professionalName: string
  parcelPlotNumber: string
  parcelCounty: string
}

/** The `professionals` slice of ProjectPayload — populated by repository.loadProfessionalsSlice. */
export interface ProfessionalsSlice {
  professionals: ProfessionalWithChecks[]
  assignments: AssignmentDetail[]
}

export const EMPTY_PROFESSIONALS_SLICE: ProfessionalsSlice = { professionals: [], assignments: [] }
