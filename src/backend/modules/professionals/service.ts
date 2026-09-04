// Professionals directory module — service layer.
//
// Called from src/backend/actions/professionals.ts (never directly from a route):
//   - upsert directory entries (name, category, licence body/number, county…)
//   - record credential checks (who checked, method, honest finding — e.g.
//     "licence expired — renewal pending")
//   - advance the honest verification ladder 0-6 from recorded checks +
//     platform history (never claim government certification)
//   - assign professionals to project parcels (surveyor/advocate/engineer/QS)
//     and update/remove assignments
//
// Every mutation returns a plain object; lib/mjengo.ts applyAction() writes the
// AuditEvent automatically — never log manually here.
//
// ENUM NORMALIZATION: action payloads may use the UPPER_SNAKE spec form
// (SURVEYOR, QTY_SURVEYOR, DOCUMENT_REVIEW, INVITED, DONE…) or the stored
// lower_snake form the F-1 seeds use. Everything is canonicalized to the
// stored form here so both dispatch styles hit the same rows.

import { db } from '@/backend/lib/db'
import {
  PROFESSIONAL_CATEGORIES,
  CHECK_METHODS,
  ASSIGNMENT_ROLES,
  MAX_CHECK_LEVEL,
  ladderLabel,
  type ProfessionalCategory,
  type LicenceBody,
  type CheckMethod,
  type AssignmentRole,
  type AssignmentStatus,
} from './types'

// ---------------- input helpers ----------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** lower_snake("QTY_SURVEYOR" | "Qty Surveyor" | "qty_surveyor") → "qty_surveyor". */
function lowerSnake(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  return s.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function clampInt(v: unknown, min: number, max: number): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeCategory(v: unknown): ProfessionalCategory {
  const c = lowerSnake(v)
  if (!c || !(PROFESSIONAL_CATEGORIES as readonly string[]).includes(c)) {
    throw new Error(`category must be one of: ${PROFESSIONAL_CATEGORIES.join(', ')} (SURVEYOR/ADVOCATE/ENGINEER/QTY_SURVEYOR/ARCHITECT/CONTRACTOR also accepted)`)
  }
  return c as ProfessionalCategory
}

/** The real Kenyan bodies stay uppercase as seeded; anything else → 'other'. */
function normalizeLicenceBody(v: unknown): LicenceBody | null {
  const s = str(v)
  if (!s) return null
  const upper = s.toUpperCase().replace(/[\s-]+/g, '_')
  if (upper === 'LSK' || upper === 'EBK' || upper === 'BORAQS') return upper
  return 'other' // OTHER / other / anything unrecognised
}

function normalizeMethod(v: unknown): CheckMethod {
  const m = lowerSnake(v)
  if (!m || !(CHECK_METHODS as readonly string[]).includes(m)) {
    throw new Error(`method must be one of: ${CHECK_METHODS.join(', ')} (DOCUMENT_REVIEW/REFERENCE_CALL/REGISTRY_LOOKUP also accepted)`)
  }
  return m as CheckMethod
}

function normalizeAssignmentRole(v: unknown): AssignmentRole {
  const r = lowerSnake(v)
  if (!r || !(ASSIGNMENT_ROLES as readonly string[]).includes(r)) {
    throw new Error(`role must be one of: ${ASSIGNMENT_ROLES.join(', ')} (SURVEYOR/ADVOCATE/ENGINEER/QTY_SURVEYOR also accepted)`)
  }
  return r as AssignmentRole
}

/** INVITED/ACTIVE/DONE (+ legacy seeded COMPLETED/WITHDRAWN) → stored form. */
function normalizeAssignmentStatus(v: unknown): AssignmentStatus {
  const s = lowerSnake(v)
  switch (s) {
    case 'invited':
    case 'active':
    case 'withdrawn':
      return s
    case 'done':
    case 'completed': // legacy seeded value — same meaning as done
      return 'done'
    default:
      throw new Error("status must be INVITED, ACTIVE or DONE (legacy COMPLETED/WITHDRAWN also accepted)")
  }
}

/** The directory is GLOBAL — professionals are not project-scoped. */
async function getProfessional(id: string) {
  const pro = await db.professional.findUnique({
    where: { id },
    include: { credentialChecks: { orderBy: { recordedAt: 'desc' } } },
  })
  if (!pro) throw new Error('Professional not found in the directory')
  return pro
}

/** Assignments are scoped to THIS project's parcels — never cross-project. */
async function getScopedAssignment(projectId: string, id: string) {
  const assignment = await db.parcelAssignment.findUnique({
    where: { id },
    include: { parcel: true, professional: true },
  })
  if (!assignment || assignment.parcel.projectId !== projectId) {
    throw new Error('Assignment not found in this project')
  }
  return assignment
}

/** Notification to the client surface on directory events that need their eyes. */
async function notifyClient(projectId: string, title: string, body: string) {
  const project = await db.project.findUnique({ where: { id: projectId } })
  await db.notification.create({
    data: {
      projectId,
      kind: 'land',
      title,
      body,
      recipient: project?.client ?? null,
      audienceRole: 'client',
    },
  })
}

// ---------------- directory entries ----------------

/**
 * Upsert a directory entry.
 *   · no id → CREATE: the entry starts at verificationState 0 (UNVERIFIED) —
 *     being in the directory claims nothing.
 *   · id    → EDIT identity fields only (the ladder is never moved here).
 */
export async function upsertProfessional(_projectId: string, payload: Record<string, unknown>) {
  const name = str(payload.name)
  if (!name) throw new Error('Name required')
  const category = normalizeCategory(payload.category)

  const data = {
    name,
    category,
    organisation: str(payload.organisation),
    phone: str(payload.phone),
    email: str(payload.email),
    county: str(payload.county),
    licenceNumber: str(payload.licenceNumber),
    licenceBody: normalizeLicenceBody(payload.licenceBody),
    notes: str(payload.notes),
  }

  const id = str(payload.id)
  if (id) {
    await getProfessional(id) // scope check: must exist
    const updated = await db.professional.update({ where: { id }, data })
    return { id: updated.id, name: updated.name, created: false }
  }

  // Duplicate guard — the directory is shared; edit the existing entry instead.
  // (Case-insensitive comparison in JS: SQLite Prisma has no insensitive mode.)
  const sameCategory = await db.professional.findMany({ where: { category }, select: { name: true } })
  if (sameCategory.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`${name} (${category}) is already in the directory — edit that entry instead of adding a duplicate`)
  }

  const created = await db.professional.create({
    data: { ...data, verificationState: 0 }, // new entries start UNVERIFIED
  })
  return { id: created.id, name: created.name, created: true, verificationState: 0 }
}

/**
 * Update a directory entry. Identity fields are optional; verificationState
 * and reliabilityScore moves are DELIBERATE (explicit field required) — the
 * ladder otherwise only advances from recorded credential checks.
 */
export async function updateProfessional(_projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  if (!id) throw new Error('Professional id required')
  await getProfessional(id)

  const data: {
    name?: string
    category?: ProfessionalCategory
    organisation?: string | null
    phone?: string | null
    email?: string | null
    county?: string | null
    licenceNumber?: string | null
    licenceBody?: string | null
    notes?: string | null
    verificationState?: number
    reliabilityScore?: number
  } = {}

  const name = str(payload.name)
  if (name) data.name = name
  if ('category' in payload && payload.category !== undefined) data.category = normalizeCategory(payload.category)
  if ('organisation' in payload) data.organisation = str(payload.organisation)
  if ('phone' in payload) data.phone = str(payload.phone)
  if ('email' in payload) data.email = str(payload.email)
  if ('county' in payload) data.county = str(payload.county)
  if ('licenceNumber' in payload) data.licenceNumber = str(payload.licenceNumber)
  if ('licenceBody' in payload && payload.licenceBody !== undefined) data.licenceBody = normalizeLicenceBody(payload.licenceBody)
  if ('notes' in payload) data.notes = str(payload.notes)

  // Deliberate ladder moves — clamped to the honest 0-6 range.
  const verificationState = clampInt(payload.verificationState, 0, 6)
  if (verificationState !== null) data.verificationState = verificationState
  const reliabilityScore = clampInt(payload.reliabilityScore, 0, 100)
  if (reliabilityScore !== null) data.reliabilityScore = reliabilityScore

  if (!Object.keys(data).length) throw new Error('Nothing to update — no recognized fields supplied')
  const updated = await db.professional.update({ where: { id }, data })
  return {
    id: updated.id,
    name: updated.name,
    verificationState: updated.verificationState,
    reliabilityScore: updated.reliabilityScore,
  }
}

// ---------------- credential checks (the honest heart of the module) ----------------
//
// LADDER RULE, DOCUMENTED: every recorded check advances the entry ONE level,
// up to a ceiling of 5 (Transaction). We keep it this simple deliberately —
//   · a DOCUMENT_REVIEW finding ("licence copy sighted") moves 0→1→2… step by
//     step as checks accumulate, because each rung means "one more recorded
//     piece of evidence exists on the platform";
//   · level 6 (Trusted) is a long-run platform distinction that recorded
//     checks alone NEVER grant — it moves only through an explicit
//     professional.update, so nobody can check their way to "Trusted".
// A check recorded on an entry already at 5/6 is still fully recorded (the
// finding + who checked + when are the point) — the state simply stays.
export async function recordCredentialCheck(_projectId: string, payload: Record<string, unknown>) {
  const professionalId = str(payload.professionalId)
  if (!professionalId) throw new Error('professionalId required')
  const pro = await getProfessional(professionalId)

  const method = normalizeMethod(payload.method)
  const finding = str(payload.finding)
  if (!finding) throw new Error('finding required — record what was actually observed, exactly as found')

  // checkedBy comes from the actor: the client passes the signed-in name; the
  // server default matches the central audit stamp ('Site Manager').
  const checkedBy = str(payload.checkedBy) ?? 'Site Manager'

  const check = await db.credentialCheck.create({
    data: { professionalId, checkedBy, method, finding },
  })

  const previousState = pro.verificationState
  const newState = Math.min(previousState + 1, MAX_CHECK_LEVEL)
  const advanced = newState > previousState
  if (advanced) {
    await db.professional.update({
      where: { id: professionalId },
      data: { verificationState: newState },
    })
  }

  return {
    id: check.id,
    professionalId,
    checkedBy,
    method,
    previousState,
    newState: advanced ? newState : previousState,
    advanced,
    levelLabel: ladderLabel(advanced ? newState : previousState),
    // Honest framing for every caller: platform record ≠ registry confirmation.
    note: `Check recorded by ${checkedBy} — this is a platform record, not a registry confirmation`,
  }
}

// ---------------- parcel assignments ----------------

/** Invite a professional onto a project parcel — starts at INVITED. */
export async function createAssignment(projectId: string, payload: Record<string, unknown>) {
  const parcelId = str(payload.parcelId)
  if (!parcelId) throw new Error('parcelId required')
  const parcel = await db.landParcel.findFirst({ where: { id: parcelId, projectId } })
  if (!parcel) throw new Error('Parcel not found in this project')

  const professionalId = str(payload.professionalId)
  if (!professionalId) throw new Error('professionalId required')
  const pro = await getProfessional(professionalId)

  const role = normalizeAssignmentRole(payload.role)
  const note = str(payload.note)

  // One open engagement per professional per parcel (INVITED or ACTIVE).
  const open = await db.parcelAssignment.findFirst({
    where: { parcelId, professionalId, status: { in: ['invited', 'active'] } },
  })
  if (open) {
    throw new Error(`${pro.name} already has an open ${open.status} assignment on ${parcel.plotNumber}`)
  }

  const assignment = await db.parcelAssignment.create({
    data: { parcelId, professionalId, role, status: 'invited', note },
  })

  await notifyClient(
    projectId,
    `Professional invited: ${pro.name} on ${parcel.plotNumber}`,
    `${pro.name} recorded as ${role} on the parcel record — invitation logged inside MjengoOS. This is a platform record, not a registry or licence confirmation.`,
  )

  return { id: assignment.id, parcelId, professionalId, role, status: assignment.status }
}

/** Update an assignment status (INVITED → ACTIVE → DONE; statuses are honest record states). */
export async function updateAssignment(projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  if (!id) throw new Error('Assignment id required')
  const assignment = await getScopedAssignment(projectId, id)

  if ('note' in payload && payload.note !== undefined) {
    const note = str(payload.note)
    await db.parcelAssignment.update({ where: { id }, data: { note } })
  }

  if (payload.status === undefined || payload.status === null || payload.status === '') {
    return { id, status: assignment.status }
  }

  const status = normalizeAssignmentStatus(payload.status)
  const updated = await db.parcelAssignment.update({ where: { id }, data: { status } })
  return { id: updated.id, status: updated.status, parcelId: assignment.parcelId }
}

/** Remove an assignment — the Bias-Free Ledger keeps the audited history. */
export async function removeAssignment(projectId: string, payload: Record<string, unknown>) {
  const id = str(payload.id)
  if (!id) throw new Error('Assignment id required')
  const assignment = await getScopedAssignment(projectId, id)

  await db.parcelAssignment.delete({ where: { id } })

  await notifyClient(
    projectId,
    `Assignment removed: ${assignment.professional.name} off ${assignment.parcel.plotNumber}`,
    `The ${assignment.role} assignment was removed by the site team — the audit ledger keeps the recorded history.`,
  )

  return { id, parcelId: assignment.parcelId, professionalId: assignment.professionalId }
}
