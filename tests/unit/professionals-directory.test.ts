/**
 * Professionals directory module invariants (issue #44 core-module test
 * gap) — src/backend/modules/professionals/{service,repository,policy}.ts.
 *
 * The module is the honest verification ladder over a GLOBAL directory of
 * built-environment professionals. Pinned here:
 *   · THE LADDER — 0-6, seven rungs; MAX_CHECK_LEVEL 5: recorded credential
 *     checks advance ONE level per check up to 5 (Transaction); level 6
 *     (Trusted) NEVER moves from checks — only a deliberate
 *     professional.update; a check on a 5/6 entry is still fully recorded;
 *     labels clamp; findings are observations, never certifications.
 *   · NORMALIZATION — UPPER_SNAKE action payloads (SURVEYOR,
 *     QTY_SURVEYOR, DOCUMENT_REVIEW, INVITED, DONE…) canonicalize to the
 *     stored lower_snake form; legacy seeded COMPLETED/WITHDRAWN map to
 *     done/withdrawn; licence bodies LSK/EBK/BORAQS stay uppercase,
 *     anything unrecognised → 'other'.
 *   · DIRECTORY ENTRY GUARANTEES — new entries start UNVERIFIED (state 0);
 *     duplicates refused case-insensitively within a category (the
 *     directory is shared); edits keep their ladder position; deliberate
 *     verificationState/reliabilityScore moves are clamped to 0-6 / 0-100.
 *   · ASSIGNMENTS — scoped to THIS project's parcels (never cross-project);
 *     one open engagement (invited|active) per professional per parcel;
 *     invites start INVITED; updates normalize status; removal keeps the
 *     audited history wording.
 *   · ROLE MATRIX (professionalsCan) — deny-by-default; supervisor records
 *     checks but never edits the directory; client/finance/share_client
 *     are read-only (the PROFESSIONALS_ACTIONS FLAG gate is pinned in
 *     flags-gating.test.ts — here we pin the matrix the guards consult).
 *   · REPOSITORY — loadProfessionalsSlice loads the GLOBAL directory
 *     (verificationState desc, name asc) with per-project assignment
 *     counts and flattened parcel/ professional details.
 *
 * @/backend/lib/db is swapped for an in-memory stub (the delivery-photos
 * pattern).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    parcels: new Map<string, Row>(), // LandParcel
    professionals: new Map<string, Row>(), // Professional
    checks: new Map<string, Row>(), // CredentialCheck
    assignments: new Map<string, Row>(), // ParcelAssignment
    notifications: [] as Row[],
    reset() {
      state.seq = 0
      for (const m of [state.projects, state.parcels, state.professionals, state.checks, state.assignments]) m.clear()
      state.notifications = []
    },
  }

  const id = (prefix: string) => `${prefix}_${++state.seq}`

  /** Just enough of Prisma's where: equality, { in: [...] }, relation parcel.projectId. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'parcel') {
        const parcel = state.parcels.get(row.parcelId as string)
        if (!parcel || !matches(parcel, cond as Row)) return false
        continue
      }
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  /** Prisma-style column defaults on create. */
  const professionalDefaults = { verificationState: 0, reliabilityScore: 50, createdAt: new Date('2026-04-01T08:00:00Z'), updatedAt: new Date('2026-04-01T08:00:00Z') }
  const assignmentDefaults = { status: 'invited', note: null, createdAt: new Date('2026-04-02T08:00:00Z') }
  const checkDefaults = { recordedAt: new Date('2026-04-03T08:00:00Z') }

  const withChecks = (row: Row) => ({
    ...row,
    credentialChecks: [...state.checks.values()]
      .filter((c) => c.professionalId === row.id)
      .sort((a, b) => (b.recordedAt as Date).getTime() - (a.recordedAt as Date).getTime())
      .map((c) => ({ ...c })),
  })

  const withRelations = (row: Row) => ({
    ...row,
    parcel: { ...(state.parcels.get(row.parcelId as string) as Row) },
    professional: { ...(state.professionals.get(row.professionalId as string) as Row) },
  })

  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: Row }) {
        const row = state.projects.get(String(where.id))
        return row ? { ...row } : null
      },
    },
    landParcel: {
      async findFirst({ where }: { where: Row }) {
        const row = [...state.parcels.values()].find((r) => matches(r, where))
        return row ? { ...row } : null
      },
    },
    professional: {
      async findUnique({ where, include }: { where: { id: string }; include?: Row }) {
        const row = state.professionals.get(where.id)
        if (!row) return null
        return include?.credentialChecks ? withChecks(row) : { ...row }
      },
      async findMany({ where, select, orderBy }: { where?: Row; select?: Row; orderBy?: Row[] }) {
        let rows = [...state.professionals.values()].filter((r) => matches(r, where ?? {}))
        if (orderBy) {
          const [first, second] = orderBy
          if (first?.verificationState === 'desc') rows.sort((a, b) => (b.verificationState as number) - (a.verificationState as number))
          if (second?.name === 'asc') {
            rows.sort((a, b) => (b.verificationState as number) - (a.verificationState as number) || String(a.name).localeCompare(String(b.name)))
          }
        }
        return rows.map((r) => {
          const full = withChecks(r)
          if (!select) return full
          const out: Row = {}
          for (const key of Object.keys(select)) out[key] = full[key]
          return out
        })
      },
      async create({ data }: { data: Row }) {
        const row = { id: id('pro'), ...professionalDefaults, ...data }
        state.professionals.set(row.id, row)
        return { ...row }
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.professionals.get(where.id)
        if (!row) throw new Error(`stub: professional ${where.id} not found`)
        Object.assign(row, data, { updatedAt: new Date() })
        return { ...row }
      },
    },
    credentialCheck: {
      async create({ data }: { data: Row }) {
        const row = { id: id('check'), ...checkDefaults, ...data }
        state.checks.set(row.id, row)
        return { ...row }
      },
    },
    parcelAssignment: {
      async findUnique({ where, include }: { where: { id: string }; include?: Row }) {
        const row = state.assignments.get(where.id)
        if (!row) return null
        return include ? withRelations(row) : { ...row }
      },
      async findFirst({ where }: { where: Row }) {
        const row = [...state.assignments.values()].find((r) => matches(r, where))
        return row ? { ...row } : null
      },
      async findMany({ where, orderBy }: { where?: Row; orderBy?: Row | Row[] }) {
        let rows = [...state.assignments.values()].filter((r) => matches(r, where ?? {}))
        const order = Array.isArray(orderBy) ? orderBy[0] : orderBy
        if (order?.createdAt === 'desc') {
          rows = [...rows].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        }
        return rows.map((r) => withRelations(r))
      },
      async create({ data }: { data: Row }) {
        const row = { id: id('asg'), ...assignmentDefaults, ...data }
        state.assignments.set(row.id, row)
        return { ...row }
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.assignments.get(where.id)
        if (!row) throw new Error(`stub: parcelAssignment ${where.id} not found`)
        Object.assign(row, data)
        return { ...row }
      },
      async delete({ where }: { where: { id: string } }) {
        const row = state.assignments.get(where.id)
        if (!row) throw new Error(`stub: parcelAssignment ${where.id} not found`)
        state.assignments.delete(where.id)
        return row
      },
    },
    notification: {
      async create({ data }: { data: Row }) {
        const row = { id: id('notif'), ...data }
        state.notifications.push(row)
        return { ...row }
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import {
  createAssignment,
  recordCredentialCheck,
  removeAssignment,
  updateAssignment,
  updateProfessional,
  upsertProfessional,
} from '@/backend/modules/professionals/service'
import {
  MAX_CHECK_LEVEL,
  VERIFICATION_LADDER,
  checksRecordedLabel,
  ladderLabel,
} from '@/backend/modules/professionals/types'
import { professionalsCan, type ProfessionalsAction, type ProfessionalsRole } from '@/backend/modules/professionals/policy'
import { loadProfessionalsSlice } from '@/backend/modules/professionals/repository'

const state = (db as unknown as { __state: {
  projects: Map<string, Record<string, unknown>>
  parcels: Map<string, Record<string, unknown>>
  professionals: Map<string, Record<string, unknown>>
  checks: Map<string, Record<string, unknown>>
  assignments: Map<string, Record<string, unknown>>
  notifications: Array<Record<string, unknown>>
  reset: () => void
} }).__state

const P1 = 'proj-1'
const P2 = 'proj-2'

function seedProject(id = P1) {
  state.projects.set(id, { id, name: 'Riverside Villas', client: 'Mama Njeri', location: 'Karen', status: 'active' })
}

function seedProfessional(over: Record<string, unknown> = {}) {
  const row = {
    id: `pro_${++state.seq}`, name: 'Grace Wanjiku', category: 'surveyor',
    organisation: 'Wanjiku Surveys', phone: '+254700000001', email: 'grace@example.com',
    county: 'Nairobi', licenceNumber: 'LSK/1234', licenceBody: 'EBK',
    verificationState: 0, reliabilityScore: 50, notes: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  }
  state.professionals.set(row.id, row)
  return row
}

function seedParcel(projectId = P1, over: Record<string, unknown> = {}) {
  const row = {
    id: `parcel_${++state.seq}`, projectId, plotNumber: 'LR No. 2090/1234', county: 'Nairobi',
    town: null, lat: null, lng: null, approxArea: null, tenureType: null, status: 'searching',
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  }
  state.parcels.set(row.id, row)
  return row
}

function seedAssignment(parcelId: string, professionalId: string, over: Record<string, unknown> = {}) {
  const row = {
    id: `asg_${++state.seq}`, parcelId, professionalId, role: 'surveyor',
    status: 'invited', note: null, createdAt: new Date(),
    ...over,
  }
  state.assignments.set(row.id, row)
  return row
}

const notif = (i: number) => state.notifications[i] as { projectId: string; kind: string; title: string; body: string; recipient: string | null; audienceRole: string }

beforeEach(() => {
  state.reset()
  seedProject(P1)
  seedProject(P2)
})

// ---------------- the honest ladder ----------------

describe('the verification ladder (0-6) — types are the contract', () => {
  it('seven rungs, level 6 reachable only by deliberate update (MAX_CHECK_LEVEL = 5)', () => {
    expect(MAX_CHECK_LEVEL).toBe(5)
    expect(VERIFICATION_LADDER.map((r) => [r.level, r.label])).toEqual([
      [0, 'Unverified'], [1, 'Registered'], [2, 'Identity'], [3, 'Business'],
      [4, 'Location'], [5, 'Transaction'], [6, 'Trusted'],
    ])
  })

  it('ladderLabel clamps out-of-range states instead of crashing', () => {
    expect(ladderLabel(-3)).toBe('Unverified')
    expect(ladderLabel(9)).toBe('Trusted')
    expect(ladderLabel(2.4)).toBe('Identity') // rounds
    expect(ladderLabel(5)).toBe('Transaction')
  })

  it('checksRecordedLabel phrasing is singular/plural-correct', () => {
    expect(checksRecordedLabel(1)).toBe('1 check recorded')
    expect(checksRecordedLabel(3)).toBe('3 checks recorded')
  })
})

// ---------------- directory entries ----------------

describe('upsertProfessional — new entries claim nothing', () => {
  it('creates at verificationState 0 with normalized category + licence body', async () => {
    const out = await upsertProfessional(P1, {
      name: ' Jane Mwangi ', category: 'QTY_SURVEYOR', licenceBody: 'boraqs',
      organisation: 'Mwangi QS', county: 'Nairobi',
    })
    expect(out).toMatchObject({ name: 'Jane Mwangi', created: true, verificationState: 0 })
    const row = state.professionals.get(out.id) as Record<string, unknown>
    expect(row.category).toBe('qty_surveyor') // UPPER_SNAKE → stored form
    expect(row.licenceBody).toBe('BORAQS') // recognized bodies stay uppercase
    expect(row.reliabilityScore).toBe(50) // schema default
  })

  it('accepts the spaced spec form too ("Qty Surveyor"), and maps unknown bodies to other', async () => {
    const out = await upsertProfessional(P1, { name: 'A. Nother', category: 'Qty Surveyor', licenceBody: 'Kenya Roads Authority' })
    const row = state.professionals.get(out.id) as Record<string, unknown>
    expect(row.category).toBe('qty_surveyor')
    expect(row.licenceBody).toBe('other')
    const second = await upsertProfessional(P1, { name: 'B. Body', category: 'advocate' })
    expect((state.professionals.get(second.id) as Record<string, unknown>).licenceBody).toBeNull() // absent → null
  })

  it('validation fail-closed: name + category required, honest error messages', async () => {
    await expect(upsertProfessional(P1, { category: 'surveyor' })).rejects.toThrow('Name required')
    await expect(upsertProfessional(P1, { name: 'X' })).rejects.toThrow(/category must be one of: surveyor, advocate, engineer, qty_surveyor, architect, contractor/)
    expect(state.professionals.size).toBe(0)
  })

  it('duplicates are refused case-insensitively WITHIN a category; other categories are fine', async () => {
    seedProfessional({ name: 'Grace Wanjiku', category: 'surveyor' })
    await expect(upsertProfessional(P1, { name: 'GRACE WANJIKU', category: 'surveyor' }))
      .rejects.toThrow('GRACE WANJIKU (surveyor) is already in the directory — edit that entry instead of adding a duplicate')
    const ok = await upsertProfessional(P1, { name: 'Grace Wanjiku', category: 'advocate' }) // same name, different category
    expect(ok.created).toBe(true)
  })

  it('edit by id replaces the identity fields and never moves the ladder', async () => {
    const pro = seedProfessional({ verificationState: 3, notes: 'original note' })
    const out = await upsertProfessional(P1, { id: pro.id, name: 'Grace W. Updated', category: 'surveyor' })
    expect(out).toMatchObject({ id: pro.id, name: 'Grace W. Updated', created: false })
    const row = state.professionals.get(pro.id) as Record<string, unknown>
    expect(row.verificationState).toBe(3) // untouched by upsert
    // full-replace semantics: fields absent from the edit payload are cleared
    expect(row.notes).toBeNull()
    expect(row.organisation).toBeNull()
  })
})

describe('updateProfessional — deliberate, clamped state moves', () => {
  it('identity-only update leaves the ladder; nothing to update is refused', async () => {
    const pro = seedProfessional({ verificationState: 2, reliabilityScore: 40 })
    const out = await updateProfessional(P1, { id: pro.id, county: 'Kiambu' })
    expect(out).toMatchObject({ id: pro.id, verificationState: 2, reliabilityScore: 40 })
    expect((state.professionals.get(pro.id) as Record<string, unknown>).county).toBe('Kiambu')

    await expect(updateProfessional(P1, { id: pro.id })).rejects.toThrow('Nothing to update — no recognized fields supplied')
  })

  it('verificationState clamps to 0-6 and reliabilityScore to 0-100 (rounded)', async () => {
    const pro = seedProfessional()
    await updateProfessional(P1, { id: pro.id, verificationState: 99 })
    expect((state.professionals.get(pro.id) as Record<string, unknown>).verificationState).toBe(6)
    await updateProfessional(P1, { id: pro.id, verificationState: -7 })
    expect((state.professionals.get(pro.id) as Record<string, unknown>).verificationState).toBe(0)
    await updateProfessional(P1, { id: pro.id, verificationState: 2.6 })
    expect((state.professionals.get(pro.id) as Record<string, unknown>).verificationState).toBe(3)
    await updateProfessional(P1, { id: pro.id, reliabilityScore: 150 })
    expect((state.professionals.get(pro.id) as Record<string, unknown>).reliabilityScore).toBe(100)
    await updateProfessional(P1, { id: pro.id, reliabilityScore: -1 })
    expect((state.professionals.get(pro.id) as Record<string, unknown>).reliabilityScore).toBe(0)
  })

  it('unknown professional and bad category are honest errors', async () => {
    await expect(updateProfessional(P1, { id: 'pro_missing', county: 'Kiambu' }))
      .rejects.toThrow('Professional not found in the directory')
    const pro = seedProfessional()
    await expect(updateProfessional(P1, { id: pro.id, category: 'magician' }))
      .rejects.toThrow(/category must be one of/)
    expect((state.professionals.get(pro.id) as Record<string, unknown>).category).toBe('surveyor')
  })
})

// ---------------- credential checks (the honest heart) ----------------

describe('recordCredentialCheck — one rung per check, up to 5', () => {
  it('records who/how/what and advances 0 → 1 → 2 with labels', async () => {
    const pro = seedProfessional({ verificationState: 0 })
    const first = await recordCredentialCheck(P1, {
      professionalId: pro.id, method: 'DOCUMENT_REVIEW', finding: 'Licence copy sighted and photographed',
      checkedBy: 'Foreman Otieno',
    })
    expect(first).toMatchObject({
      professionalId: pro.id, checkedBy: 'Foreman Otieno', method: 'document_review',
      previousState: 0, newState: 1, advanced: true, levelLabel: 'Registered',
    })
    expect(first.note).toBe('Check recorded by Foreman Otieno — this is a platform record, not a registry confirmation')

    const second = await recordCredentialCheck(P1, {
      professionalId: pro.id, method: 'REFERENCE_CALL', finding: 'Reference confirmed two completed jobs',
    })
    expect(second).toMatchObject({ previousState: 1, newState: 2, advanced: true, levelLabel: 'Identity' })
    expect(second.checkedBy).toBe('Site Manager') // default when the actor is absent
    expect(second.method).toBe('reference_call')
  })

  it('a check at level 5 is still fully recorded but the ladder stays (nobody checks their way past Transaction)', async () => {
    const pro = seedProfessional({ verificationState: 5 })
    const out = await recordCredentialCheck(P1, {
      professionalId: pro.id, method: 'registry_lookup', finding: 'Registry lookup recorded',
    })
    expect(out).toMatchObject({ previousState: 5, newState: 5, advanced: false, levelLabel: 'Transaction' })
    expect((state.professionals.get(pro.id) as Record<string, unknown>).verificationState).toBe(5)
    expect([...state.checks.values()]).toHaveLength(1) // the check row IS recorded
  })

  it('a check on a deliberately-set Trusted (6) entry reports 6/Trusted, advanced false', async () => {
    const pro = seedProfessional({ verificationState: 6 })
    const out = await recordCredentialCheck(P1, {
      professionalId: pro.id, method: 'document_review', finding: 'Annual re-check',
    })
    expect(out).toMatchObject({ previousState: 6, newState: 6, advanced: false, levelLabel: 'Trusted' })
    expect((state.professionals.get(pro.id) as Record<string, unknown>).verificationState).toBe(6)
  })

  it('validation fail-closed: professionalId + finding required, method must be one of three', async () => {
    const pro = seedProfessional()
    await expect(recordCredentialCheck(P1, { method: 'document_review', finding: 'x' }))
      .rejects.toThrow('professionalId required')
    await expect(recordCredentialCheck(P1, { professionalId: pro.id, method: 'document_review' }))
      .rejects.toThrow('finding required — record what was actually observed, exactly as found')
    await expect(recordCredentialCheck(P1, { professionalId: pro.id, method: 'gut_feeling', finding: 'x' }))
      .rejects.toThrow(/method must be one of: document_review, reference_call, registry_lookup/)
    await expect(recordCredentialCheck(P1, { professionalId: 'pro_missing', method: 'document_review', finding: 'x' }))
      .rejects.toThrow('Professional not found in the directory')
    expect(state.checks.size).toBe(0) // nothing recorded on a bad payload
  })
})

// ---------------- parcel assignments ----------------

describe('createAssignment — one open engagement per professional per parcel', () => {
  it('invites start at INVITED with the normalized role and notify the client honestly', async () => {
    const parcel = seedParcel(P1)
    const pro = seedProfessional({ name: 'Grace Wanjiku' })
    const out = await createAssignment(P1, {
      parcelId: parcel.id, professionalId: pro.id, role: 'ADVOCATE', note: 'Title search support',
    })
    expect(out).toEqual({ id: out.id, parcelId: parcel.id, professionalId: pro.id, role: 'advocate', status: 'invited' })
    expect(state.notifications).toHaveLength(1)
    expect(notif(0)).toMatchObject({
      projectId: P1, kind: 'land', recipient: 'Mama Njeri', audienceRole: 'client',
      title: 'Professional invited: Grace Wanjiku on LR No. 2090/1234',
    })
    expect(notif(0).body).toContain('platform record, not a registry or licence confirmation')
  })

  it('an invited OR active engagement blocks a re-invite; done/withdrawn do not', async () => {
    const parcel = seedParcel(P1)
    const pro = seedProfessional({ name: 'Grace Wanjiku' })
    const invited = seedAssignment(parcel.id, pro.id, { status: 'invited' })
    await expect(createAssignment(P1, { parcelId: parcel.id, professionalId: pro.id, role: 'surveyor' }))
      .rejects.toThrow('Grace Wanjiku already has an open invited assignment on LR No. 2090/1234')

    state.assignments.delete(invited.id)
    seedAssignment(parcel.id, pro.id, { status: 'active' })
    await expect(createAssignment(P1, { parcelId: parcel.id, professionalId: pro.id, role: 'surveyor' }))
      .rejects.toThrow('Grace Wanjiku already has an open active assignment on LR No. 2090/1234')

    for (const open of [...state.assignments.values()]) Object.assign(open, { status: 'done' })
    const again = await createAssignment(P1, { parcelId: parcel.id, professionalId: pro.id, role: 'surveyor' })
    expect(again.status).toBe('invited')
  })

  it('validation + scoping: parcel must belong to THIS project, professional must exist, role must be one of four', async () => {
    const foreignParcel = seedParcel(P2)
    const pro = seedProfessional()
    await expect(createAssignment(P1, { parcelId: foreignParcel.id, professionalId: pro.id, role: 'surveyor' }))
      .rejects.toThrow('Parcel not found in this project')
    await expect(createAssignment(P1, { parcelId: 'parcel_missing', professionalId: pro.id, role: 'surveyor' }))
      .rejects.toThrow('Parcel not found in this project')
    const parcel = seedParcel(P1)
    await expect(createAssignment(P1, { parcelId: parcel.id, professionalId: 'pro_missing', role: 'surveyor' }))
      .rejects.toThrow('Professional not found in the directory')
    await expect(createAssignment(P1, { parcelId: parcel.id, professionalId: pro.id, role: 'mason' }))
      .rejects.toThrow(/role must be one of: surveyor, advocate, engineer, qty_surveyor/)
    expect(state.assignments.size).toBe(0)
  })
})

describe('updateAssignment — honest status transitions', () => {
  it('normalizes UPPER_SNAKE and legacy statuses to the stored form', async () => {
    const parcel = seedParcel(P1)
    const pro = seedProfessional()
    const asg = seedAssignment(parcel.id, pro.id, { status: 'invited' })
    expect(await updateAssignment(P1, { id: asg.id, status: 'ACTIVE' })).toMatchObject({ id: asg.id, status: 'active' })
    expect(await updateAssignment(P1, { id: asg.id, status: 'DONE' })).toMatchObject({ status: 'done' })
    expect(await updateAssignment(P1, { id: asg.id, status: 'COMPLETED' })).toMatchObject({ status: 'done' }) // legacy seed value
    expect(await updateAssignment(P1, { id: asg.id, status: 'WITHDRAWN' })).toMatchObject({ status: 'withdrawn' })
    await expect(updateAssignment(P1, { id: asg.id, status: 'finished' }))
      .rejects.toThrow('status must be INVITED, ACTIVE or DONE (legacy COMPLETED/WITHDRAWN also accepted)')
  })

  it('a note-only update returns the current status; a missing status does nothing', async () => {
    const parcel = seedParcel(P1)
    const pro = seedProfessional()
    const asg = seedAssignment(parcel.id, pro.id, { status: 'active' })
    const out = await updateAssignment(P1, { id: asg.id, note: 'Site visit booked' })
    expect(out).toEqual({ id: asg.id, status: 'active' })
    expect((state.assignments.get(asg.id) as Record<string, unknown>).note).toBe('Site visit booked')
  })

  it('a cross-project assignment is not found in THIS project', async () => {
    const parcel = seedParcel(P2)
    const pro = seedProfessional()
    const foreign = seedAssignment(parcel.id, pro.id)
    await expect(updateAssignment(P1, { id: foreign.id, status: 'active' }))
      .rejects.toThrow('Assignment not found in this project')
    await expect(updateAssignment(P1, { status: 'active' })).rejects.toThrow('Assignment id required')
  })
})

describe('removeAssignment — the ledger keeps the history', () => {
  it('deletes the row, returns the ids, and notifies with the audit-ledger wording', async () => {
    const parcel = seedParcel(P1)
    const pro = seedProfessional({ name: 'Grace Wanjiku' })
    const asg = seedAssignment(parcel.id, pro.id, { role: 'advocate', status: 'active' })
    const out = await removeAssignment(P1, { id: asg.id })
    expect(out).toEqual({ id: asg.id, parcelId: parcel.id, professionalId: pro.id })
    expect(state.assignments.has(asg.id)).toBe(false)
    expect(state.notifications).toHaveLength(1)
    expect(notif(0).title).toBe('Assignment removed: Grace Wanjiku off LR No. 2090/1234')
    expect(notif(0).body).toContain('the audit ledger keeps the recorded history')
  })

  it('a cross-project assignment cannot be removed from THIS project', async () => {
    const parcel = seedParcel(P2)
    const pro = seedProfessional()
    const foreign = seedAssignment(parcel.id, pro.id)
    await expect(removeAssignment(P1, { id: foreign.id })).rejects.toThrow('Assignment not found in this project')
  })
})

// ---------------- role matrix + repository ----------------

describe('professionalsCan — deny-by-default role matrix', () => {
  const roles = ['contractor', 'supervisor', 'client', 'finance', 'admin', 'share_client'] as const
  const actions = ['directory.view', 'professional.upsert', 'credential.record', 'assignment.create', 'assignment.update', 'assignment.remove'] as const

  it('contractor/admin do everything; supervisor records checks only; viewers never mutate', () => {
    const expected: Record<ProfessionalsRole, ProfessionalsAction[]> = {
      contractor: [...actions],
      admin: [...actions],
      supervisor: ['directory.view', 'credential.record'],
      client: ['directory.view'],
      finance: ['directory.view'],
      share_client: ['directory.view'],
    }
    for (const role of roles) {
      for (const action of actions) {
        expect(professionalsCan(role, action)).toBe(expected[role].includes(action))
      }
    }
  })

  it('unknown actions and unknown roles are denied', () => {
    expect(professionalsCan('contractor', 'professional.delete' as ProfessionalsAction)).toBe(false)
    expect(professionalsCan('intern' as ProfessionalsRole, 'credential.record')).toBe(false)
  })
})

describe('loadProfessionalsSlice — the global directory + project assignments', () => {
  it('directory is GLOBAL: every entry loads regardless of project, ordered state desc then name asc', async () => {
    seedProfessional({ id: 'pro_a', name: 'Zawadi Last', category: 'advocate', verificationState: 3 })
    seedProfessional({ id: 'pro_b', name: 'Alpha First', category: 'surveyor', verificationState: 5 })
    seedProfessional({ id: 'pro_c', name: 'Beta Middle', category: 'engineer', verificationState: 5 })
    seedProfessional({ id: 'pro_d', name: 'Aaa Unverified', category: 'architect', verificationState: 0 })

    const slice = await loadProfessionalsSlice(P1)
    expect(slice.professionals.map((p) => p.id)).toEqual(['pro_b', 'pro_c', 'pro_a', 'pro_d'])
    expect(slice.assignments).toEqual([])
  })

  it('assignmentCount counts ONLY this project\u2019s engagements; details flatten parcel + professional', async () => {
    const pro = seedProfessional({ id: 'pro_1', name: 'Grace Wanjiku', category: 'surveyor', verificationState: 2 })
    const other = seedProfessional({ id: 'pro_2', name: 'Hellen Otieno', category: 'advocate', verificationState: 4 })
    const parcel = seedParcel(P1, { id: 'parcel_1', plotNumber: 'LR No. 2090/1234', county: 'Nairobi' })
    const foreignParcel = seedParcel(P2, { id: 'parcel_2', plotNumber: 'LR No. 1111/2222' })
    seedAssignment(parcel.id, pro.id, { id: 'asg_1', role: 'surveyor', status: 'active', createdAt: new Date('2026-04-05T08:00:00Z') })
    seedAssignment(parcel.id, pro.id, { id: 'asg_2', role: 'advocate', status: 'done', createdAt: new Date('2026-04-06T08:00:00Z') })
    seedAssignment(foreignParcel.id, other.id, { id: 'asg_3', role: 'advocate', status: 'active', createdAt: new Date('2026-04-07T08:00:00Z') })

    const slice = await loadProfessionalsSlice(P1)
    const byId = new Map(slice.professionals.map((p) => [p.id, p]))
    expect(byId.get('pro_1')!.assignmentCount).toBe(2) // both this-project rows
    expect(byId.get('pro_2')!.assignmentCount).toBe(0) // the other project's engagement is NOT counted
    expect(slice.professionals.every((p) => Array.isArray(p.credentialChecks))).toBe(true)

    expect(slice.assignments.map((a) => a.id)).toEqual(['asg_2', 'asg_1']) // createdAt desc, this project only
    expect(slice.assignments[1]).toMatchObject({
      id: 'asg_1', professionalName: 'Grace Wanjiku', parcelPlotNumber: 'LR No. 2090/1234', parcelCounty: 'Nairobi',
    })
  })

  it('an empty directory + project yields the empty slice', async () => {
    const slice = await loadProfessionalsSlice(P1)
    expect(slice.professionals).toEqual([])
    expect(slice.assignments).toEqual([])
  })
})
