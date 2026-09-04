/**
 * Land & Property module invariants (issue #44 core-module test gap) —
 * src/backend/modules/land/{service,repository,policy}.ts.
 *
 * Land is the parcel + title-search EVIDENCE ladder. Pinned here:
 *   · TRANSCRIPTION-VS-REGISTRY CHECK (computeTranscriptionMatch) — the
 *     deterministic rules: empty deed → pending; the plot-number core
 *     ("LR No. 2090/1234" → "2090/1234", spaces stripped) missing from the
 *     registry result → mismatch (the loudest anomaly); proprietor tokens
 *     (≥3 letters, initials ignored) or an explicit registry assertion
 *     ("proprietor matches" / "matches the deed") settle the name check;
 *     nothing comparable extracted → honest pending, never a fake
 *     "consistent".
 *   · PARCEL LIFECYCLE — create starts SEARCHING (an honest record state),
 *     validation fail-closed (plot/county required, lat ±90 / lng ±180, one
 *     plot number per project), identity-only updates (status has its own
 *     action — parcel.update refuses it), setStatus limited to the three
 *     documented statuses with client notifications carrying the
 *     "record state, not a government certification" wording.
 *   · TITLE-SEARCH LADDER — request (one REQUESTED search per parcel),
 *     receive (once — status guard; verdict recorded; mismatch notifies
 *     "anomaly flag for human review, not an accusation"), review (accept
 *     promotes to VERIFIED only when CONSISTENT + ≥1 document on file;
 *     flag marks the parcel FLAGGED; every other accept stays SEARCHING).
 *   · DOCUMENTS — metadata + transcription only; the storageKey is the
 *     deterministic sanitized path (no binary upload in v1).
 *   · ROLE MATRIX (landCan) — the module's deny-by-default permission
 *     boundary (the LAND_ACTIONS FLAG gate itself is pinned in
 *     flags-gating.test.ts — here we pin the matrix the guards consult).
 *   · REPOSITORY — loadLandSlice scopes to the project, orders parcels asc
 *     / documents & searches desc, and flattens assignment professionals.
 *
 * @/backend/lib/db is swapped for an in-memory stub (the delivery-photos
 * pattern); computeTranscriptionMatch is pure and runs directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    parcels: new Map<string, Row>(), // LandParcel
    documents: new Map<string, Row>(), // ParcelDocument
    searches: new Map<string, Row>(), // TitleSearch
    assignments: new Map<string, Row>(), // ParcelAssignment
    professionals: new Map<string, Row>(), // Professional
    notifications: [] as Row[],
    writes: { parcelUpdate: 0, searchUpdate: 0 },
    reset() {
      state.seq = 0
      for (const m of [state.projects, state.parcels, state.documents, state.searches, state.assignments, state.professionals]) m.clear()
      state.notifications = []
      state.writes = { parcelUpdate: 0, searchUpdate: 0 }
    },
  }

  const id = (prefix: string) => `${prefix}_${++state.seq}`

  /** Just enough of Prisma's where: equality, { in: [...] }, { not: null|v }, NOT: { id }. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'parcel') {
        const parcel = state.parcels.get(row.parcelId as string)
        if (!parcel || !matches(parcel, cond as Row)) return false
        continue
      }
      if (key === 'NOT') {
        if (matches(row, cond as Row)) return false // row matches the negated filter → excluded
        continue
      }
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
        if ('not' in c) {
          if (row[key] === (c.not as unknown)) return false // { not: null } → must not be null
          continue
        }
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  /** Relation include assembly the way the land reads ask for it. */
  function parcelWithRelations(parcel: Row) {
    return {
      ...parcel,
      documents: [...state.documents.values()]
        .filter((d) => d.parcelId === parcel.id)
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .map((d) => ({ ...d })),
      searches: [...state.searches.values()]
        .filter((s) => s.parcelId === parcel.id)
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .map((s) => ({ ...s })),
      assignments: [...state.assignments.values()]
        .filter((a) => a.parcelId === parcel.id)
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .map((a) => ({ ...a, professional: { ...(state.professionals.get(a.professionalId as string) as Row) } })),
    }
  }

  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: Row }) {
        const row = state.projects.get(String(where.id))
        return row ? { ...row } : null
      },
    },
    landParcel: {
      async findFirst({ where, include }: { where: Row; include?: Row }) {
        const row = [...state.parcels.values()].find((r) => matches(r, where))
        if (!row) return null
        if (!include) return { ...row }
        return parcelWithRelations(row)
      },
      async findMany({ where, orderBy, include }: { where: Row; orderBy?: Row; include?: Row }) {
        let rows = [...state.parcels.values()].filter((r) => matches(r, where))
        if (orderBy?.createdAt === 'asc') {
          rows = [...rows].sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
        }
        return rows.map((r) => (include ? parcelWithRelations(r) : { ...r }))
      },
      async create({ data }: { data: Row }) {
        const row = {
          id: id('parcel'), status: 'searching',
          createdAt: new Date('2026-03-01T08:00:00Z'), updatedAt: new Date('2026-03-01T08:00:00Z'),
          ...data,
        }
        state.parcels.set(row.id, row)
        return { ...row }
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.parcels.get(where.id)
        if (!row) throw new Error(`stub: landParcel ${where.id} not found`)
        Object.assign(row, data, { updatedAt: new Date() })
        state.writes.parcelUpdate++
        return { ...row }
      },
    },
    parcelDocument: {
      async create({ data }: { data: Row }) {
        const row = { id: id('doc'), createdAt: new Date(), ...data }
        state.documents.set(row.id, row)
        return { ...row }
      },
      async findFirst({ where, orderBy }: { where: Row; orderBy?: Row }) {
        let rows = [...state.documents.values()].filter((r) => matches(r, where))
        if (orderBy?.createdAt === 'desc') {
          rows = [...rows].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        }
        return rows[0] ? { ...rows[0] } : null
      },
    },
    titleSearch: {
      async create({ data }: { data: Row }) {
        const row = {
          id: id('search'), status: 'requested', resultSummary: null,
          requestedAt: new Date(), receivedAt: null, reviewedAt: null,
          createdAt: new Date(), ...data,
        }
        state.searches.set(row.id, row)
        return { ...row }
      },
      async findUnique({ where, include }: { where: { id: string }; include?: Row }) {
        const row = state.searches.get(where.id)
        if (!row) return null
        if (!include) return { ...row }
        return { ...row, parcel: { ...(state.parcels.get(row.parcelId as string) as Row) } }
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.searches.get(where.id)
        if (!row) throw new Error(`stub: titleSearch ${where.id} not found`)
        Object.assign(row, data)
        state.writes.searchUpdate++
        return { ...row }
      },
    },
    notification: {
      async create({ data }: { data: Row }) {
        const row = { id: id('notif'), ...data }
        state.notifications.push(row)
        return { ...row }
      },
    },
    parcelAssignment: {
      async findUnique({ where, include }: { where: { id: string }; include?: Row }) {
        const row = state.assignments.get(where.id)
        if (!row) return null
        if (!include) return { ...row }
        return {
          ...row,
          parcel: { ...(state.parcels.get(row.parcelId as string) as Row) },
          professional: { ...(state.professionals.get(row.professionalId as string) as Row) },
        }
      },
      async findMany({ where, orderBy }: { where: Row; orderBy?: Row }) {
        let rows = [...state.assignments.values()].filter((r) => matches(r, where))
        if (orderBy?.createdAt === 'desc') {
          rows = [...rows].sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        }
        return rows.map((r) => ({
          ...r,
          parcel: { ...(state.parcels.get(r.parcelId as string) as Row) },
          professional: { ...(state.professionals.get(r.professionalId as string) as Row) },
        }))
      },
    },
    professional: {
      async findUnique({ where }: { where: { id: string } }) {
        const row = state.professionals.get(where.id)
        return row ? { ...row } : null
      },
      async findMany() { return [...state.professionals.values()].map((p) => ({ ...p })) },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import {
  attachParcelDocument,
  computeTranscriptionMatch,
  createParcel,
  receiveTitleSearch,
  requestTitleSearch,
  reviewTitleSearch,
  setParcelStatus,
  updateParcel,
} from '@/backend/modules/land/service'
import { landCan, type LandAction, type LandRole } from '@/backend/modules/land/policy'
import { loadLandSlice } from '@/backend/modules/land/repository'

const state = (db as unknown as { __state: {
  projects: Map<string, Record<string, unknown>>
  parcels: Map<string, Record<string, unknown>>
  documents: Map<string, Record<string, unknown>>
  searches: Map<string, Record<string, unknown>>
  assignments: Map<string, Record<string, unknown>>
  professionals: Map<string, Record<string, unknown>>
  notifications: Array<Record<string, unknown>>
  writes: { parcelUpdate: number; searchUpdate: number }
  reset: () => void
} }).__state

const P1 = 'proj-1'
const P2 = 'proj-2'

const DEED = 'Registered proprietor: J. K. Mwangi (transcribed)'
const REGISTRY_OK = 'Official search: LR No. 2090/1234, proprietor matches the deed'

function seedProjects() {
  state.projects.set(P1, { id: P1, name: 'Riverside Villas', client: 'Mama Njeri', location: 'Karen', status: 'active' })
  state.projects.set(P2, { id: P2, name: 'Kisumu Duplex', client: 'Baba Otieno', location: 'Kisumu', status: 'active' })
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

function seedDeed(parcelId: string, extractedText: string | null = DEED, createdAt = new Date('2026-03-02T09:00:00Z')) {
  const row = {
    id: `doc_${++state.seq}`, parcelId, kind: 'title_deed', fileName: 'deed.pdf',
    storageKey: `/documents/${P1}/deed.pdf`, extractedText, issuedOn: null, createdAt,
  }
  state.documents.set(row.id, row)
  return row
}

function seedSearch(parcelId: string, over: Record<string, unknown> = {}) {
  const row = {
    id: `search_${++state.seq}`, parcelId, searchRef: 'CS/2026/123456', resultSummary: null,
    transcriptionMatch: 'pending', status: 'requested',
    requestedAt: new Date('2026-03-03T09:00:00Z'), receivedAt: null, reviewedAt: null,
    createdAt: new Date('2026-03-03T09:00:00Z'), ...over,
  }
  state.searches.set(row.id, row)
  return row
}

const notif = (i: number) => state.notifications[i] as { projectId: string; kind: string; title: string; body: string; recipient: string | null; audienceRole: string }

beforeEach(() => {
  state.reset()
  seedProjects()
})

// ---------------- transcription-vs-registry consistency check ----------------

describe('computeTranscriptionMatch — deterministic, no AI', () => {
  it('no transcription on file → pending with the honest reason', () => {
    for (const empty of [null, '', '   ']) {
      expect(computeTranscriptionMatch(empty, REGISTRY_OK, 'LR No. 2090/1234')).toEqual({
        verdict: 'pending',
        reason: 'No title-deed transcription on file — nothing to compare against yet',
      })
    }
  })

  it('plot number found + proprietor name found → consistent, both checks named', () => {
    const out = computeTranscriptionMatch(DEED, 'official search lr no. 2090/1234 — j. k. mwangi of nairobi', 'LR No. 2090/1234')
    expect(out.verdict).toBe('consistent')
    expect(out.reason).toBe('plot number 2090/1234 found; proprietor name matches')
  })

  it('the plot core tolerates spaces in the deed plot number; registry text is normalized', () => {
    const out = computeTranscriptionMatch(DEED, 'SEARCH: LR 2090 / 1234 (NOTE FORMAT) proprietor MWANGI', 'LR No. 2090 / 1234')
    // registry keeps its own "2090 / 1234" spacing → the plot check fails honestly
    expect(out.verdict).toBe('mismatch')
    expect(out.reason).toBe('Plot number 2090/1234 is not found in the registry result')
  })

  it('plot missing from the registry result → mismatch (the loudest anomaly), even with a matching proprietor', () => {
    const out = computeTranscriptionMatch(DEED, 'official search: plot LR No. 1234/5678, proprietor Mwangi', 'LR No. 2090/1234')
    expect(out.verdict).toBe('mismatch')
    expect(out.reason).toBe('Plot number 2090/1234 is not found in the registry result')
  })

  it('proprietor differs → mismatch naming the deed tokens; initials are ignored (not distinctive)', () => {
    const out = computeTranscriptionMatch(DEED, 'official search: LR No. 2090/1234, proprietor J. K. Otieno', 'LR No. 2090/1234')
    expect(out.verdict).toBe('mismatch')
    expect(out.reason).toBe('Registry proprietor differs from the deed transcription (mwangi)')
  })

  it('the registry asserting agreement ("proprietor matches the deed") passes the name check', () => {
    const out = computeTranscriptionMatch(DEED, 'Official search: LR No. 2090/1234 — proprietor matches the deed', 'LR No. 2090/1234')
    expect(out.verdict).toBe('consistent')
    expect(out.reason).toBe('plot number 2090/1234 found; registry asserts the proprietor matches')
  })

  it('a plot-only deed (no proprietor phrase) can still be consistent on the plot check', () => {
    const out = computeTranscriptionMatch('Certificate of title, plot LR No. 2090/1234, Nairobi.', 'registry: lr no. 2090/1234 all entries in order', 'LR No. 2090/1234')
    expect(out.verdict).toBe('consistent')
    expect(out.reason).toBe('plot number 2090/1234 found')
  })

  it('nothing comparable (no plot core, no proprietor tokens) → pending, never a fake "consistent"', () => {
    const out = computeTranscriptionMatch('Certificate of title, plot 123, Nairobi.', 'registry: some text', 'Plot 123')
    expect(out.verdict).toBe('pending')
    expect(out.reason).toBe('No plot number or proprietor could be extracted from the deed transcription — nothing comparable')
  })
})

// ---------------- parcel lifecycle ----------------

describe('createParcel — the honest SEARCHING start', () => {
  it('records a parcel in the searching state with trimmed particulars', async () => {
    const out = await createParcel(P1, {
      plotNumber: '  LR No. 2090/1234 ', county: ' Nairobi ', town: ' Karen ',
      latitude: '-1.29', longitude: '36.82', approxArea: '0.25 ha', tenureType: 'freehold',
    })
    expect(out.status).toBe('searching')
    const row = state.parcels.get(out.id) as Record<string, unknown>
    expect(row.plotNumber).toBe('LR No. 2090/1234')
    expect(row.county).toBe('Nairobi')
    expect(row.town).toBe('Karen')
    expect(row.lat).toBe(-1.29) // numeric coercion
    expect(row.lng).toBe(36.82)
    expect(row.tenureType).toBe('freehold')
  })

  it.each([
    ['plot number missing', { county: 'Nairobi' }, /Plot number required/],
    ['plot number blank', { plotNumber: '   ', county: 'Nairobi' }, /Plot number required/],
    ['county missing', { plotNumber: 'LR No. 2090/1234' }, /County required/],
    ['latitude out of range', { plotNumber: 'LR No. 2090/1234', county: 'Nairobi', latitude: 90.5 }, /Latitude must be between -90 and 90/],
    ['longitude out of range', { plotNumber: 'LR No. 2090/1234', county: 'Nairobi', longitude: -180.5 }, /Longitude must be between -180 and 180/],
  ])('validation fail-closed: %s', async (_label, payload, pattern) => {
    await expect(createParcel(P1, payload)).rejects.toThrow(pattern as RegExp)
    expect(state.parcels.size).toBe(0) // nothing recorded on a bad payload
  })

  it('one plot number per project — duplicates refused, other projects unaffected', async () => {
    seedParcel(P1, { plotNumber: 'LR No. 2090/1234' })
    await expect(createParcel(P1, { plotNumber: 'LR No. 2090/1234', county: 'Nairobi' }))
      .rejects.toThrow('A parcel with this plot number is already recorded on the project')
    // the same plot on ANOTHER project is a different record
    const other = await createParcel(P2, { plotNumber: 'LR No. 2090/1234', county: 'Kiambu' })
    expect(other.status).toBe('searching')
  })
})

describe('updateParcel — identity fields only', () => {
  it('updates recognized identity fields and clears empties to null', async () => {
    const parcel = seedParcel()
    const out = await updateParcel(P1, { id: parcel.id, town: '', tenureType: 'leasehold', latitude: -1.1 })
    expect(out).toEqual({ id: parcel.id, plotNumber: 'LR No. 2090/1234' })
    const row = state.parcels.get(parcel.id) as Record<string, unknown>
    expect(row.town).toBeNull()
    expect(row.tenureType).toBe('leasehold')
    expect(row.lat).toBe(-1.1)
  })

  it('status is NOT an identity field — parcel.update refuses to move it', async () => {
    const parcel = seedParcel()
    await expect(updateParcel(P1, { id: parcel.id, status: 'verified' }))
      .rejects.toThrow('Nothing to update — no recognized fields supplied')
    await updateParcel(P1, { id: parcel.id, town: 'Naivasha', status: 'verified' }) // legal field wins
    expect((state.parcels.get(parcel.id) as Record<string, unknown>).status).toBe('searching')
  })

  it('a cross-project or unknown parcel id is not found in THIS project', async () => {
    const foreign = seedParcel(P2)
    await expect(updateParcel(P1, { id: foreign.id, town: 'Naivasha' })).rejects.toThrow('Parcel not found in this project')
    await expect(updateParcel(P1, { id: 'parcel_missing', town: 'Naivasha' })).rejects.toThrow('Parcel not found in this project')
  })

  it('plot-number change is checked against OTHER parcels only (self-identity is not a duplicate)', async () => {
    const parcel = seedParcel(P1, { plotNumber: 'LR No. 2090/1234' })
    seedParcel(P1, { id: 'parcel_b', plotNumber: 'LR No. 2090/9999' })
    await expect(updateParcel(P1, { id: 'parcel_b', plotNumber: 'LR No. 2090/1234' }))
      .rejects.toThrow('Another parcel with this plot number is already recorded on the project')
    await updateParcel(P1, { id: parcel.id, plotNumber: 'LR No. 2090/1234' }) // same value, same row → fine
    expect((state.parcels.get(parcel.id) as Record<string, unknown>).plotNumber).toBe('LR No. 2090/1234')
  })
})

describe('setParcelStatus — the three honest record states', () => {
  it('rejects unknown statuses, listing the three documented states', async () => {
    const parcel = seedParcel()
    await expect(setParcelStatus(P1, { id: parcel.id, status: 'government-verified' }))
      .rejects.toThrow('status must be one of: searching, verified, flagged')
    expect((state.parcels.get(parcel.id) as Record<string, unknown>).status).toBe('searching')
  })

  it('a note rides the client notification with the record-state wording', async () => {
    const parcel = seedParcel()
    const out = await setParcelStatus(P1, { id: parcel.id, status: 'flagged', note: 'Search result mismatch' })
    expect(out).toEqual({ id: parcel.id, status: 'flagged' })
    expect((state.parcels.get(parcel.id) as Record<string, unknown>).status).toBe('flagged')
    expect(state.notifications).toHaveLength(1)
    expect(notif(0)).toMatchObject({
      projectId: P1, kind: 'land', recipient: 'Mama Njeri', audienceRole: 'client',
      title: 'Land record: LR No. 2090/1234 marked flagged',
      body: 'Search result mismatch — record state, not a government certification.',
    })
  })

  it('flagged without a note still notifies (a flag needs its trail); quiet statuses do not', async () => {
    const parcel = seedParcel()
    await setParcelStatus(P1, { id: parcel.id, status: 'flagged' })
    expect(state.notifications).toHaveLength(1)
    expect(notif(0).body).toContain('Status set without a note')

    const parcel2 = seedParcel(P1, { id: 'parcel_q', plotNumber: 'LR No. 2090/7777' })
    await setParcelStatus(P1, { id: parcel2.id, status: 'searching' })
    expect(state.notifications).toHaveLength(1) // no note + not flagged → silent
  })
})

// ---------------- documents ----------------

describe('attachParcelDocument — v1 metadata + transcription, deterministic path', () => {
  it('records the document with a sanitized deterministic storageKey', async () => {
    const parcel = seedParcel()
    const out = await attachParcelDocument(P1, {
      parcelId: parcel.id, kind: 'title_deed', fileName: 'Deed Copy #2 (final).pdf',
      extractedText: DEED, issuedOn: '2025-11-14',
    })
    expect(out).toEqual({
      id: out.id, parcelId: parcel.id, kind: 'title_deed',
      storageKey: `/documents/${P1}/Deed_Copy_2_final_.pdf`,
    })
    const row = state.documents.get(out.id) as Record<string, unknown>
    expect(row.extractedText).toBe(DEED)
    expect(row.issuedOn).toEqual(new Date('2025-11-14'))
  })

  it('validation fail-closed: unknown kind, missing filename, unknown parcel', async () => {
    const parcel = seedParcel()
    await expect(attachParcelDocument(P1, { parcelId: parcel.id, kind: 'covenant', fileName: 'x.pdf' }))
      .rejects.toThrow('kind must be one of: title_deed, search_cert, survey_map, other')
    await expect(attachParcelDocument(P1, { parcelId: parcel.id, kind: 'search_cert' }))
      .rejects.toThrow('File name required')
    await expect(attachParcelDocument(P1, { parcelId: 'parcel_missing', kind: 'search_cert', fileName: 'x.pdf' }))
      .rejects.toThrow('Parcel not found in this project')
    expect(state.documents.size).toBe(0)
  })
})

// ---------------- registry title-search ladder ----------------

describe('requestTitleSearch — requested, never confirmed', () => {
  it('records a REQUESTED search with a generated CS reference and pending match', async () => {
    const parcel = seedParcel()
    const out = await requestTitleSearch(P1, { parcelId: parcel.id })
    expect(out).toMatchObject({ parcelId: parcel.id })
    expect(out.searchRef).toMatch(/^CS\/\d{4}\/\d{6}$/)
    const row = state.searches.get(out.id) as Record<string, unknown>
    expect(row.status).toBe('requested')
    expect(row.transcriptionMatch).toBe('pending')
    expect(row.resultSummary).toBeNull()
  })

  it('a caller-supplied searchRef is used verbatim', async () => {
    const parcel = seedParcel()
    const out = await requestTitleSearch(P1, { parcelId: parcel.id, searchRef: 'CS/2026/000077' })
    expect(out.searchRef).toBe('CS/2026/000077')
  })

  it('one REQUESTED search per parcel — receive the result before requesting again', async () => {
    const parcel = seedParcel()
    await requestTitleSearch(P1, { parcelId: parcel.id })
    await expect(requestTitleSearch(P1, { parcelId: parcel.id }))
      .rejects.toThrow('A registry search is already requested for this parcel — receive its result first')
    // once the result is received the parcel may request a fresh search
    const open = [...state.searches.values()].find((s) => s.parcelId === parcel.id) as Record<string, unknown>
    open.status = 'received'
    const again = await requestTitleSearch(P1, { parcelId: parcel.id })
    expect(again.id).not.toBe(open.id)
  })

  it('a foreign-project parcel is not found in THIS project', async () => {
    const foreign = seedParcel(P2)
    await expect(requestTitleSearch(P1, { parcelId: foreign.id })).rejects.toThrow('Parcel not found in this project')
  })
})

describe('receiveTitleSearch — the result is recorded, not confirmed', () => {
  it('runs the consistency check against the latest title-deed transcription and records the verdict', async () => {
    const parcel = seedParcel()
    seedDeed(parcel.id, DEED, new Date('2026-03-02T09:00:00Z'))
    // an OLDER deed whose proprietor would MISMATCH if wrongly picked
    seedDeed(parcel.id, 'Registered proprietor: J. K. Otieno', new Date('2026-03-01T09:00:00Z'))
    const search = seedSearch(parcel.id)
    const out = await receiveTitleSearch(P1, { id: search.id, resultSummary: REGISTRY_OK })
    expect(out.transcriptionMatch).toBe('consistent')
    // the registry asserts agreement rather than naming the proprietor → the assertion branch
    expect(out.reason).toBe('plot number 2090/1234 found; registry asserts the proprietor matches')
    const row = state.searches.get(search.id) as Record<string, unknown>
    expect(row.status).toBe('received')
    expect(row.resultSummary).toBe(REGISTRY_OK)
    expect(row.receivedAt).toBeInstanceOf(Date)
    expect(state.notifications).toHaveLength(0) // consistent → no client alarm
  })

  it('a mismatch notifies the client as an anomaly flag for human review, never an accusation', async () => {
    const parcel = seedParcel()
    seedDeed(parcel.id, DEED)
    const search = seedSearch(parcel.id)
    const out = await receiveTitleSearch(P1, { id: search.id, resultSummary: 'official search: plot LR No. 1234/5678, proprietor Otieno' })
    expect(out.transcriptionMatch).toBe('mismatch')
    expect(state.notifications).toHaveLength(1)
    expect(notif(0)).toMatchObject({
      projectId: P1, kind: 'land', recipient: 'Mama Njeri', audienceRole: 'client',
      title: 'Land record: review required — LR No. 2090/1234',
    })
    expect(notif(0).body).toContain('anomaly flag for human review, not an accusation')
  })

  it('validation + honest error paths: summary required, foreign search, double receive', async () => {
    const parcel = seedParcel()
    const search = seedSearch(parcel.id)
    await expect(receiveTitleSearch(P1, { id: search.id })).rejects.toThrow('resultSummary required — paste what the registry returned')

    const foreignParcel = seedParcel(P2)
    const foreignSearch = seedSearch(foreignParcel.id)
    await expect(receiveTitleSearch(P1, { id: foreignSearch.id, resultSummary: REGISTRY_OK }))
      .rejects.toThrow('Search not found in this project')

    await receiveTitleSearch(P1, { id: search.id, resultSummary: REGISTRY_OK })
    await expect(receiveTitleSearch(P1, { id: search.id, resultSummary: REGISTRY_OK }))
      .rejects.toThrow('This search already has a received result')
  })

  it('no deed transcription on file → the honest pending verdict, still received', async () => {
    const parcel = seedParcel()
    const search = seedSearch(parcel.id)
    const out = await receiveTitleSearch(P1, { id: search.id, resultSummary: 'registry result without a deed to compare' })
    expect(out.transcriptionMatch).toBe('pending')
    expect(out.reason).toBe('No title-deed transcription on file — nothing to compare against yet')
    expect((state.searches.get(search.id) as Record<string, unknown>).status).toBe('received')
  })
})

describe('reviewTitleSearch — the human decision ladder', () => {
  function receivedSearch(options: { docs?: number; match?: 'pending' | 'consistent' | 'mismatch' } = {}) {
    const parcel = seedParcel()
    for (let i = 0; i < (options.docs ?? 1); i++) seedDeed(parcel.id)
    const search = seedSearch(parcel.id, {
      status: 'received', transcriptionMatch: options.match ?? 'consistent',
      resultSummary: REGISTRY_OK, receivedAt: new Date('2026-03-04T09:00:00Z'),
    })
    return { parcel, search }
  }

  it('accept of a CONSISTENT search with ≥1 document promotes the parcel to verified (record state)', async () => {
    const { parcel, search } = receivedSearch({ match: 'consistent', docs: 1 })
    const out = await reviewTitleSearch(P1, { id: search.id, decision: 'accept' })
    expect(out).toEqual({ id: search.id, decision: 'accept', parcelId: parcel.id, parcelStatus: 'verified' })
    expect((state.parcels.get(parcel.id) as Record<string, unknown>).status).toBe('verified')
    expect((state.searches.get(search.id) as Record<string, unknown>).status).toBe('reviewed')
    expect(state.notifications.at(-1)!.body).toContain('MjengoOS record state, not a government certification')
  })

  it('accept without a document on file keeps the parcel SEARCHING (documents + agreement, both required)', async () => {
    const { parcel, search } = receivedSearch({ match: 'consistent', docs: 0 })
    const out = await reviewTitleSearch(P1, { id: search.id, decision: 'accept' })
    expect(out.parcelStatus).toBe('searching')
    expect((state.parcels.get(parcel.id) as Record<string, unknown>).status).toBe('searching')
    expect(state.notifications.at(-1)!.body).toContain('stays SEARCHING until a consistent search and at least one document are on file')
  })

  it('accept of a MISMATCH (or pending) search never verifies the parcel', async () => {
    const { parcel, search } = receivedSearch({ match: 'mismatch', docs: 2 })
    const out = await reviewTitleSearch(P1, { id: search.id, decision: 'accept' })
    expect(out.parcelStatus).toBe('searching')
    expect((state.parcels.get(parcel.id) as Record<string, unknown>).status).toBe('searching')
  })

  it('flag marks the parcel FLAGGED for professional follow-up', async () => {
    const { parcel, search } = receivedSearch({ match: 'mismatch' })
    const out = await reviewTitleSearch(P1, { id: search.id, decision: 'flag', note: 'Proprietor mismatch needs an advocate' })
    expect(out.parcelStatus).toBe('flagged')
    expect((state.parcels.get(parcel.id) as Record<string, unknown>).status).toBe('flagged')
    expect(state.notifications.at(-1)!.body).toContain('Proprietor mismatch needs an advocate — flagged for professional follow-up')
  })

  it('only a RECEIVED search can be reviewed; decision must be accept or flag', async () => {
    const { search } = receivedSearch()
    await expect(reviewTitleSearch(P1, { id: search.id, decision: 'maybe' })).rejects.toThrow("decision must be 'accept' or 'flag'")
    await reviewTitleSearch(P1, { id: search.id, decision: 'accept' })
    await expect(reviewTitleSearch(P1, { id: search.id, decision: 'accept' }))
      .rejects.toThrow('Only a RECEIVED search can be marked reviewed')

    const fresh = seedSearch(seedParcel().id) // status 'requested'
    await expect(reviewTitleSearch(P1, { id: fresh.id, decision: 'accept' }))
      .rejects.toThrow('Only a RECEIVED search can be marked reviewed')
  })
})

// ---------------- role matrix + repository ----------------

describe('landCan — the deny-by-default role matrix', () => {
  const roles = ['contractor', 'supervisor', 'client', 'finance', 'admin', 'share_client'] as const
  const actions = ['parcel.view', 'parcel.create', 'parcel.update', 'parcelDoc.attach', 'search.request', 'search.receive', 'search.review'] as const

  it('every role may VIEW; only the site team mutates', () => {
    for (const role of roles) expect(landCan(role, 'parcel.view')).toBe(true)
    const expected: Record<LandRole, string[]> = {
      contractor: ['parcel.view', 'parcel.create', 'parcel.update', 'parcelDoc.attach', 'search.request', 'search.receive', 'search.review'],
      admin: ['parcel.view', 'parcel.create', 'parcel.update', 'parcelDoc.attach', 'search.request', 'search.receive', 'search.review'],
      supervisor: ['parcel.view', 'parcelDoc.attach'],
      client: ['parcel.view'],
      finance: ['parcel.view'],
      share_client: ['parcel.view'],
    }
    for (const role of roles) {
      for (const action of actions) {
        expect(landCan(role, action)).toBe(expected[role].includes(action))
      }
    }
  })

  it('unknown actions and unknown roles are denied (deny-by-default)', () => {
    expect(landCan('contractor', 'parcel.delete' as LandAction)).toBe(false)
    expect(landCan('intern' as LandRole, 'parcel.create')).toBe(false)
  })
})

describe('loadLandSlice — the payload replay', () => {
  it('scopes to the project, orders parcels asc / children desc, flattens assignment professionals', async () => {
    const parcel = seedParcel(P1, { createdAt: new Date('2026-03-01T08:00:00Z') })
    seedParcel(P1, { id: 'parcel_late', plotNumber: 'LR No. 2090/5678', createdAt: new Date('2026-03-05T08:00:00Z') })
    seedParcel(P2, { id: 'parcel_other', plotNumber: 'LR No. 2090/1234' })
    seedDeed(parcel.id, DEED, new Date('2026-03-02T09:00:00Z'))
    seedDeed(parcel.id, null, new Date('2026-03-06T09:00:00Z'))
    seedSearch(parcel.id, { status: 'received' })
    state.professionals.set('pro_1', { id: 'pro_1', name: 'Grace Wanjiku', category: 'surveyor', verificationState: 3 })
    state.assignments.set('asg_1', {
      id: 'asg_1', parcelId: parcel.id, professionalId: 'pro_1', role: 'surveyor',
      status: 'active', note: null, createdAt: new Date('2026-03-04T09:00:00Z'),
    })

    const slice = await loadLandSlice(P1)
    expect(slice.parcels.map((p) => p.id)).toEqual([parcel.id, 'parcel_late']) // asc, other project excluded
    const detail = slice.parcels[0]
    expect(detail.documents.map((d) => d.createdAt.getTime())).toEqual([
      new Date('2026-03-06T09:00:00Z').getTime(), new Date('2026-03-02T09:00:00Z').getTime(),
    ]) // desc
    expect(detail.searches[0].status).toBe('received')
    expect(detail.assignments).toEqual([
      expect.objectContaining({
        id: 'asg_1', role: 'surveyor', professionalName: 'Grace Wanjiku', professionalCategory: 'surveyor',
      }),
    ])
  })

  it('an empty project yields the empty slice', async () => {
    const slice = await loadLandSlice(P2)
    expect(slice.parcels).toEqual([])
  })
})
