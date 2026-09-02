// Professionals directory module — types for the `professionals` slice.
//
// The slice carries the global professional directory with recorded credential
// checks, plus the project-scoped parcel assignments (surveyor / advocate /
// engineer / QS) so both the Professionals section and Land parcel cards can
// render assignments. verificationState is an honest 0-6 ladder — never a
// government certification claim.
//
// Agent 2-b: storage keeps the F-1/seed convention (lowercase snake_case
// strings in the plain-text Prisma columns). Action payloads may send the
// UPPER_SNAKE spec form (SURVEYOR, DOCUMENT_REVIEW, INVITED…) — the service
// normalizes both. Labels here are the single source for the UI.

import type { Professional, CredentialCheck, ParcelAssignment } from '@prisma/client'

// ---- domain enums (stored values, matching prisma/schema.prisma + seeds) ----

export type ProfessionalCategory =
  | 'surveyor'
  | 'advocate'
  | 'engineer'
  | 'qty_surveyor'
  | 'architect'
  | 'contractor'
export type LicenceBody = 'LSK' | 'EBK' | 'BORAQS' | 'other'
export type CheckMethod = 'document_review' | 'reference_call' | 'registry_lookup'
export type AssignmentRole = 'surveyor' | 'advocate' | 'engineer' | 'qty_surveyor'
/** INVITED → ACTIVE → DONE (+ legacy seeded states completed/withdrawn). */
export type AssignmentStatus = 'invited' | 'active' | 'done' | 'completed' | 'withdrawn'

export const PROFESSIONAL_CATEGORIES = [
  'surveyor',
  'advocate',
  'engineer',
  'qty_surveyor',
  'architect',
  'contractor',
] as const

export const CATEGORY_LABELS: Record<ProfessionalCategory, string> = {
  surveyor: 'Land surveyor',
  advocate: 'Advocate',
  engineer: 'Engineer',
  qty_surveyor: 'Quantity surveyor',
  architect: 'Architect',
  contractor: 'Contractor',
}

/** Regulator/registration body that ISSUES the licence (MjengoOS never does). */
export const LICENCE_BODIES = ['LSK', 'EBK', 'BORAQS', 'other'] as const
export const LICENCE_BODY_LABELS: Record<LicenceBody, string> = {
  LSK: 'LSK — Law Society of Kenya',
  EBK: 'EBK — Engineers Board of Kenya',
  BORAQS: 'BORAQS — Board of Registration of Architects & QS',
  other: 'Other body',
}

export const CHECK_METHODS = ['document_review', 'reference_call', 'registry_lookup'] as const
export const CHECK_METHOD_LABELS: Record<CheckMethod, string> = {
  document_review: 'Document review',
  reference_call: 'Reference call',
  registry_lookup: 'Registry lookup',
}

export const ASSIGNMENT_ROLES = ['surveyor', 'advocate', 'engineer', 'qty_surveyor'] as const
export const ASSIGNMENT_ROLE_LABELS: Record<AssignmentRole, string> = {
  surveyor: 'Surveyor',
  advocate: 'Advocate',
  engineer: 'Engineer',
  qty_surveyor: 'Quantity surveyor',
}

export const ASSIGNMENT_STATUSES = ['invited', 'active', 'done', 'withdrawn'] as const
export const ASSIGNMENT_STATUS_LABELS: Record<string, string> = {
  invited: 'Invited',
  active: 'Active',
  done: 'Done',
  completed: 'Done',
  withdrawn: 'Withdrawn',
}

// ---- the honest verification ladder (0-6, seven rungs) ----
//
// verificationState counts what MjengoOS has RECORDED about an entry — it is
// not, and never becomes, a claim that a regulator confirmed anything. LSK,
// EBK and BORAQS remain the authoritative sources; the platform records the
// checks people performed and what they found.

export interface LadderRung {
  level: number
  label: string
  /** What a recorded check that reaches this rung typically was. */
  hint: string
}

export const VERIFICATION_LADDER: LadderRung[] = [
  { level: 0, label: 'Unverified', hint: 'Entry recorded — no checks yet' },
  { level: 1, label: 'Registered', hint: 'Details captured in the directory' },
  { level: 2, label: 'Identity', hint: 'A document was reviewed on file' },
  { level: 3, label: 'Business', hint: 'References checked by phone' },
  { level: 4, label: 'Location', hint: 'A registry lookup was recorded' },
  { level: 5, label: 'Transaction', hint: 'Platform transaction history' },
  { level: 6, label: 'Trusted', hint: 'Long-run platform record' },
]

/**
 * Highest level a recorded credential check can advance an entry to.
 * Level 6 (Trusted) is a long-run platform distinction that recorded checks
 * alone never grant — it moves only by a deliberate professional.update.
 */
export const MAX_CHECK_LEVEL = 5

export function ladderLabel(state: number): string {
  return ladderRung(state).label
}

function ladderRung(state: number): LadderRung {
  const clamped = Math.min(6, Math.max(0, Math.round(state)))
  return VERIFICATION_LADDER[clamped]
}

/** "3 checks recorded" phrasing for the card footer. */
export function checksRecordedLabel(n: number): string {
  return `${n} check${n === 1 ? '' : 's'} recorded`
}

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
