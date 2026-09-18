/**
 * BOQ lifecycle + supplier shortlist (issue #195 / audit TEST-5 residual) —
 * src/backend/modules/inventory/{repository,service}.ts: loadBoqSlice,
 * createBoq, upsertBoqLine, deleteBoqLine, approveBoq, boqToRequest,
 * saveSupplier, unsaveSupplier.
 *
 * The BOQ surface drives the procurement chain head (BOQ → material
 * request) and carries its own invariants:
 *
 *  · loadBoqSlice — versioned newest-first ordering, per-line totals via
 *    the integer-cents helpers, cents→KSh line fields, project scoping;
 *  · createBoq — version increments PER PROJECT (count + 1), generated
 *    `BOQ v<n>` name, lines created from the payload;
 *  · upsertBoqLine — create-with-defaults vs update-by-id, BOQ looked up
 *    in the caller's project;
 *  · deleteBoqLine — line resolved through the BOQ's project (scoping);
 *  · approveBoq — approve-once refusal (`BOQ already approved`);
 *  · boqToRequest — full-vs-selected lineIds, `MR-<1000 + count + 1>` code
 *    sequence per project, draft status, notes-only lineage
 *    (`From BOQ "<name>" v<version>`), and request lines carrying ONLY
 *    material/unit/qty (no price, category or note crosses over);
 *  · saveSupplier / unsaveSupplier — shortlist upsert/remove round-trip.
 *
 * Mirrors tests/unit/inventory-atomicity.test.ts (issue's own idiom):
 * @/backend/lib/db swapped for an in-memory stub over boq / boqLine /
 * materialRequest(+lines) / supplier / savedSupplier maps.
 *
 * KNOWN UNIT DRIFT (#285 — the BoqLine twin of #282, pinned as-is, fails
 * on purpose when normalized): boq-card.tsx sends estUnitPrice as a KSh
 * number and createBoq/upsertBoqLine store it raw into the BigInt column
 * whose comment says cents, so loadBoqSlice's centsToKes divides by 100
 * again. The total/estUnitPrice assertions pin the CURRENT arithmetic.
 *
 * KNOWN SCOPING GAP (#286 — pinned as-is, fails on purpose when fixed):
 * upsertBoqLine's update path resolves the LINE by bare id, so a foreign
 * project's line id rewrites that project's line. Pinned below with the
 * issue reference; the fix flips that pin to a scoped refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// In-memory Prisma stub: boq / boqLine / materialRequest / supplier /
// savedSupplier — just enough for the BOQ surface. __state exposes the
// tables for assertions.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    boqs: new Map<string, Record<string, unknown>>(),
    boqLines: new Map<string, Record<string, unknown>>(),
    requests: new Map<string, Record<string, unknown>>(),
    requestLines: new Map<string, Record<string, unknown>>(),
    suppliers: new Map<string, Record<string, unknown>>(),
    saved: new Map<string, Record<string, unknown>>(),
    reset() {
      state.boqs.clear()
      state.boqLines.clear()
      state.requests.clear()
      state.requestLines.clear()
      state.suppliers.clear()
      state.saved.clear()
      state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const linesFor = (boqId: string) =>
    [...state.boqLines.values()].filter((l) => l.boqId === boqId)
  const requestLinesFor = (requestId: string) =>
    [...state.requestLines.values()].filter((l) => l.requestId === requestId)

  const boq = {
    async count({ where }: { where: { projectId: string } }) {
      return [...state.boqs.values()].filter((b) => b.projectId === where.projectId).length
    },
    async create({ data }: { data: Record<string, unknown> }) {
      // Prisma fidelity: Boq.status defaults to 'draft' when absent.
      const b: Record<string, unknown> = { id: nid('boq'), createdAt: new Date(), status: 'draft', ...data }
      state.boqs.set(b.id as string, b)
      return { ...b }
    },
    async findFirst({ where }: { where: { id: string; projectId: string } }) {
      const b = state.boqs.get(where.id)
      return b && b.projectId === where.projectId
        ? { ...b, lines: linesFor(b.id as string).map((l) => ({ ...l })) }
        : null
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const b = state.boqs.get(where.id)!
      const updated = { ...b, ...data }
      state.boqs.set(updated.id as string, updated)
      return { ...updated }
    },
    // loadBoqSlice's read: where.projectId + include lines, NEWEST first.
    async findMany({ where }: { where: { projectId: string } }) {
      return [...state.boqs.values()]
        .filter((b) => b.projectId === where.projectId)
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .map((b) => ({ ...b, lines: linesFor(b.id as string).map((l) => ({ ...l })) }))
    },
  }
  const boqLine = {
    async create({ data }: { data: Record<string, unknown> }) {
      // Prisma fidelity: the estUnitPrice column is BigInt — the engine
      // coerces the service's plain Number back to BigInt on write.
      const l: Record<string, unknown> = { id: nid('bl'), ...data, estUnitPrice: BigInt(data.estUnitPrice ?? 0) }
      state.boqLines.set(l.id as string, l)
      return { ...l }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const l = state.boqLines.get(where.id)!
      const patch = { ...data }
      if (patch.estUnitPrice !== undefined) patch.estUnitPrice = BigInt(patch.estUnitPrice)
      const updated = { ...l, ...patch }
      state.boqLines.set(updated.id as string, updated)
      return { ...updated }
    },
    async findFirst({ where }: { where: { id: string; boq: { projectId: string } } }) {
      const l = state.boqLines.get(where.id)
      if (!l) return null
      const b = state.boqs.get(l.boqId as string)
      return b && b.projectId === where.boq.projectId ? { ...l } : null
    },
    async delete({ where }: { where: { id: string } }) {
      const gone = state.boqLines.get(where.id)
      state.boqLines.delete(where.id)
      return gone ? { ...gone } : null
    },
  }
  const materialRequest = {
    async count({ where }: { where: { projectId: string } }) {
      return [...state.requests.values()].filter((r) => r.projectId === where.projectId).length
    },
    async create({ data }: { data: Record<string, unknown> & { lines?: { create: Record<string, unknown>[] } } }) {
      const { lines, ...rest } = data
      const r: Record<string, unknown> = { id: nid('mr'), createdAt: new Date(), ...rest }
      state.requests.set(r.id as string, r)
      for (const l of lines?.create ?? []) {
        const row: Record<string, unknown> = { id: nid('mrl'), requestId: r.id, ...l }
        state.requestLines.set(row.id as string, row)
      }
      return { ...r, lines: requestLinesFor(r.id as string).map((l) => ({ ...l })) }
    },
  }
  const supplier = {
    async findUnique({ where }: { where: { id: string } }) {
      const s = state.suppliers.get(where.id)
      return s ? { ...s } : null
    },
  }
  const savedSupplier = {
    async upsert({ where, update, create }: { where: { projectId_supplierId: { projectId: string; supplierId: string } }; update: Record<string, unknown>; create: Record<string, unknown> }) {
      const key = where.projectId_supplierId
      const existing = [...state.saved.values()].find(
        (s) => s.projectId === key.projectId && s.supplierId === key.supplierId,
      )
      if (existing) {
        // Prisma semantics: undefined in `update` means "leave unchanged".
        const patch = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined))
        const updated = { ...existing, ...patch }
        state.saved.set(updated.id as string, updated)
        return { ...updated }
      }
      const s: Record<string, unknown> = { id: nid('ss'), createdAt: new Date(), ...create }
      state.saved.set(s.id as string, s)
      return { ...s }
    },
    async findFirst({ where }: { where: { projectId: string; supplierId: string } }) {
      const s = [...state.saved.values()].find(
        (row) => row.projectId === where.projectId && row.supplierId === where.supplierId,
      )
      return s ? { ...s } : null
    },
    async delete({ where }: { where: { id: string } }) {
      const gone = state.saved.get(where.id)
      state.saved.delete(where.id)
      return gone ? { ...gone } : null
    },
  }
  const db = { boq, boqLine, materialRequest, supplier, savedSupplier, __state: state }
  return { db }
})

import { db } from '@/backend/lib/db'
import { loadBoqSlice } from '@/backend/modules/inventory/repository'
import {
  approveBoq,
  boqToRequest,
  createBoq,
  deleteBoqLine,
  saveSupplier,
  unsaveSupplier,
  upsertBoqLine,
} from '@/backend/modules/inventory/service'
import { INVENTORY_ACTIONS, applyInventoryAction } from '@/backend/actions/inventory'

type StubState = {
  boqs: Map<string, Record<string, unknown>>
  boqLines: Map<string, Record<string, unknown>>
  requests: Map<string, Record<string, unknown>>
  requestLines: Map<string, Record<string, unknown>>
  suppliers: Map<string, Record<string, unknown>>
  saved: Map<string, Record<string, unknown>>
  reset: () => void
}
const state = (db as unknown as { __state: StubState }).__state

const P = 'proj-1'
const OTHER = 'proj-2'

const T = (h: number) => new Date(`2026-09-01T${String(8 + h).padStart(2, '0')}:00:00.000Z`)

interface SeedLine {
  materialName: string
  unit?: string
  qty?: number
  estUnitPrice?: bigint
  category?: string | null
  note?: string | null
}

/** Seed a BOQ with its lines directly (createdAt controlled for ordering). */
function seedBoq(
  projectId: string,
  spec: { name: string; version: number; status?: string; createdAt: Date },
  lines: SeedLine[] = [],
): string {
  const id = `boq_${++state.seq}`
  state.boqs.set(id, {
    id,
    projectId,
    name: spec.name,
    version: spec.version,
    status: spec.status ?? 'draft',
    createdAt: spec.createdAt,
    updatedAt: spec.createdAt,
  })
  lines.forEach((l) => {
    const lid = `bl_${++state.seq}`
    state.boqLines.set(lid, {
      id: lid,
      boqId: id,
      materialName: l.materialName,
      unit: l.unit ?? 'unit',
      qty: l.qty ?? 1,
      estUnitPrice: l.estUnitPrice ?? 0n,
      category: l.category ?? null,
      note: l.note ?? null,
    })
  })
  return id
}

function seedSupplierRow(id: string): string {
  state.suppliers.set(id, { id, businessName: `Supplier ${id}`, county: 'Nairobi' })
  return id
}

beforeEach(() => {
  state.reset()
})

// ------------------------------------------------------------- loadBoqSlice

describe('loadBoqSlice — versioned ordering + totals (stubbed tables)', () => {
  it('serves BOQs newest-first with per-line totals and cents→KSh line fields', async () => {
    const v1 = seedBoq(P, { name: 'Original plan', version: 1, createdAt: T(1) }, [
      { materialName: 'Cement', unit: 'bag', qty: 100, estUnitPrice: 700n },
    ])
    const v2 = seedBoq(P, { name: 'Revised plan', version: 2, createdAt: T(2) }, [
      { materialName: 'Cement', unit: 'bag', qty: 120, estUnitPrice: 650n, category: 'structural', note: 'OPC 42.5' },
      { materialName: 'Ballast', unit: 'tonne', qty: 10.5, estUnitPrice: 1800n },
      { materialName: 'Nails', qty: 2, estUnitPrice: 0n },
    ])
    seedBoq(OTHER, { name: 'Their BOQ', version: 1, createdAt: T(3) }, [
      { materialName: 'Cement', qty: 5, estUnitPrice: 999n },
    ])
    void v1

    const slice = await loadBoqSlice(P)
    // Newest-first, and the other project's BOQ never leaks.
    expect(slice.boqs.map((b) => b.name)).toEqual(['Revised plan', 'Original plan'])

    const revised = slice.boqs[0]
    expect(revised.id).toBe(v2)
    expect(revised.version).toBe(2)
    expect(revised.status).toBe('draft')
    expect(revised.createdAt).toBe(T(2).toISOString())

    // Line fields: materialName/unit/qty pass through, category/note serve,
    // estUnitPrice converts cents→KSh.
    const cement = revised.lines.find((l) => l.materialName === 'Cement')!
    expect(cement.unit).toBe('bag')
    expect(cement.qty).toBe(120)
    expect(cement.category).toBe('structural')
    expect(cement.note).toBe('OPC 42.5')
    // #285 drift (twin of #282), pinned as-is — fails on purpose when fixed:
    // writers store the KSh number raw into the cents column, so 650 shows
    // as 6.5. The arithmetic being pinned is centsToKes over the column.
    expect(cement.estUnitPrice).toBe(6.5)
    expect(revised.lines.find((l) => l.materialName === 'Nails')!.estUnitPrice).toBe(0)

    // The total: Σ qty × estUnitPrice, cents → KSh (same #285 arithmetic):
    // 120×650 + 10.5×1800 + 2×0 = 78,000 + 18,900 + 0 cents → 969.
    expect(revised.total).toBe(969)
  })

  it('an empty project yields { boqs: [] }', async () => {
    expect(await loadBoqSlice('proj-empty')).toEqual({ boqs: [] })
  })
})

// ---------------------------------------------------------------- createBoq

describe('createBoq — version increments per project', () => {
  it('mints v1 with the generated name and creates every payload line', async () => {
    const r = await createBoq(P, {
      lines: [
        { materialName: 'Cement', unit: 'bag', qty: 120, estUnitPrice: 650, category: 'structural' },
        { materialName: 'Ballast', unit: 'tonne', qty: 10 },
      ],
    })
    expect(r.version).toBe(1)
    expect(r.name).toBe('BOQ v1') // generated when no name is given
    expect(r.lines).toBe(2)
    expect(r.id).toBeTruthy()

    const boq = state.boqs.get(r.id)!
    expect(boq.projectId).toBe(P)
    expect(boq.status).toBe('draft')
    expect([...state.boqLines.values()].filter((l) => l.boqId === r.id)).toHaveLength(2)
    const cement = [...state.boqLines.values()].find((l) => l.boqId === r.id && l.materialName === 'Cement')!
    expect(cement.unit).toBe('bag')
    expect(cement.qty).toBe(120)
    expect(cement.estUnitPrice).toBe(650n) // stored raw (#285) — Number(650)
  })

  it('the next BOQ in the SAME project is v2; an explicit name is honored', async () => {
    await createBoq(P, { name: 'Original plan', lines: [] })
    const second = await createBoq(P, { name: 'Revised plan' })
    expect(second.version).toBe(2)
    expect(second.name).toBe('Revised plan')
    expect(second.lines).toBe(0) // no lines key → zero rows, zero carried
    expect([...state.boqLines.values()]).toHaveLength(0)
  })

  it('versioning is PER PROJECT — a second project starts at v1', async () => {
    await createBoq(P, { lines: [] })
    await createBoq(P, { lines: [] })
    const theirs = await createBoq(OTHER, { lines: [] })
    expect(theirs.version).toBe(1)
    expect(theirs.name).toBe('BOQ v1')
  })
})

// -------------------------------------------------------------- upsertBoqLine

describe('upsertBoqLine — create vs update, scoped to the caller’s BOQ', () => {
  it('creates a line with the documented defaults when no id is given', async () => {
    const boqId = seedBoq(P, { name: 'BOQ v1', version: 1, createdAt: T(1) })
    const r = await upsertBoqLine(P, { boqId, materialName: 'Timber' })
    expect(r.id).toBeTruthy()
    const line = state.boqLines.get(r.id)!
    expect(line.boqId).toBe(boqId)
    expect(line.materialName).toBe('Timber')
    expect(line.unit).toBe('unit') // default
    expect(line.qty).toBe(1) // default
    expect(line.estUnitPrice).toBe(0n) // default
    expect(line.category).toBeNull()
    expect(line.note).toBeNull()
  })

  it('updates the existing line in place when an id is given', async () => {
    const boqId = seedBoq(P, { name: 'BOQ v1', version: 1, createdAt: T(1) }, [
      { materialName: 'Cement', unit: 'bag', qty: 100, estUnitPrice: 700n },
    ])
    const lineId = [...state.boqLines.values()].find((l) => l.boqId === boqId)!.id as string
    const r = await upsertBoqLine(P, {
      boqId, id: lineId, materialName: 'Cement', unit: 'bag', qty: 120, estUnitPrice: 650, note: 'price update',
    })
    expect(r.id).toBe(lineId) // same row, not a new one
    expect([...state.boqLines.values()].filter((l) => l.boqId === boqId)).toHaveLength(1)
    const line = state.boqLines.get(lineId)!
    expect(line.qty).toBe(120)
    expect(line.note).toBe('price update')
  })

  it('refuses an unknown or foreign-project boqId', async () => {
    const foreign = seedBoq(OTHER, { name: 'Their BOQ', version: 1, createdAt: T(1) })
    await expect(upsertBoqLine(P, { boqId: 'nope', materialName: 'Cement' })).rejects.toThrow('BOQ not found')
    await expect(upsertBoqLine(P, { boqId: foreign, materialName: 'Cement' })).rejects.toThrow('BOQ not found')
  })

  it('KNOWN GAP #286 (fails on purpose when fixed): a foreign-project LINE id escapes the project scope', async () => {
    const mine = seedBoq(P, { name: 'My BOQ', version: 1, createdAt: T(1) }, [
      { materialName: 'Cement', qty: 100 },
    ])
    const foreignLine = [...state.boqLines.values()].find(
      (l) => (state.boqs.get(l.boqId as string) as { projectId: string }).projectId === OTHER,
    )
    expect(foreignLine).toBeUndefined() // fixture sanity: OTHER has no lines yet

    const theirBoq = seedBoq(OTHER, { name: 'Their BOQ', version: 1, createdAt: T(1) }, [
      { materialName: 'Ballast', qty: 5, unit: 'tonne' },
    ])
    const theirLineId = [...state.boqLines.values()].find((l) => l.boqId === theirBoq)!.id as string

    // The BOQ lookup is scoped (mine), but the line update resolves by bare
    // id — the foreign project's line gets rewritten. Filed as #286; when
    // the fix lands, this pin flips to a scoped refusal.
    await upsertBoqLine(P, {
      boqId: mine, id: theirLineId, materialName: 'Hacked', qty: 999,
    })
    const theirLine = state.boqLines.get(theirLineId)!
    expect(theirLine.materialName).toBe('Hacked')
    expect(theirLine.qty).toBe(999)
    void foreignLine
  })
})

// -------------------------------------------------------------- deleteBoqLine

describe('deleteBoqLine — removal through the BOQ’s project scope', () => {
  it('removes the line', async () => {
    const boqId = seedBoq(P, { name: 'BOQ v1', version: 1, createdAt: T(1) }, [
      { materialName: 'Cement' },
      { materialName: 'Ballast' },
    ])
    const cementId = [...state.boqLines.values()].find((l) => l.boqId === boqId && l.materialName === 'Cement')!.id as string
    const r = await deleteBoqLine(P, { id: cementId })
    expect(r.id).toBe(cementId)
    expect(state.boqLines.has(cementId)).toBe(false)
    expect([...state.boqLines.values()].filter((l) => l.boqId === boqId)).toHaveLength(1)
  })

  it('refuses a line that belongs to another project’s BOQ', async () => {
    const theirBoq = seedBoq(OTHER, { name: 'Their BOQ', version: 1, createdAt: T(1) }, [
      { materialName: 'Ballast' },
    ])
    const theirLineId = [...state.boqLines.values()].find((l) => l.boqId === theirBoq)!.id as string
    await expect(deleteBoqLine(P, { id: theirLineId })).rejects.toThrow('BOQ line not found')
    expect(state.boqLines.has(theirLineId)).toBe(true) // untouched
    await expect(deleteBoqLine(P, { id: 'nope' })).rejects.toThrow('BOQ line not found')
  })
})

// ---------------------------------------------------------------- approveBoq

describe('approveBoq — approve once, refuse forever after', () => {
  it('flips draft → approved and returns the updated row', async () => {
    const boqId = seedBoq(P, { name: 'BOQ v1', version: 1, createdAt: T(1) })
    const r = await approveBoq(P, { id: boqId })
    expect(r.status).toBe('approved')
    expect(state.boqs.get(boqId)!.status).toBe('approved')
  })

  it('refuses a second approval (BOQ already approved)', async () => {
    const boqId = seedBoq(P, { name: 'BOQ v1', version: 1, createdAt: T(1) })
    await approveBoq(P, { id: boqId })
    await expect(approveBoq(P, { id: boqId })).rejects.toThrow('BOQ already approved')
    expect(state.boqs.get(boqId)!.status).toBe('approved') // unchanged by the refusal
  })

  it('refuses an unknown or foreign-project id', async () => {
    const foreign = seedBoq(OTHER, { name: 'Their BOQ', version: 1, createdAt: T(1) })
    await expect(approveBoq(P, { id: 'nope' })).rejects.toThrow('BOQ not found')
    await expect(approveBoq(P, { id: foreign })).rejects.toThrow('BOQ not found')
    expect(state.boqs.get(foreign)!.status).toBe('draft') // untouched
  })
})

// --------------------------------------------------------------- boqToRequest

describe('boqToRequest — line selection, MR- sequence, notes-only lineage', () => {
  function seedTwoLineBoq(): string {
    return seedBoq(P, { name: 'Revised plan', version: 2, createdAt: T(1) }, [
      { materialName: 'Cement', unit: 'bag', qty: 120, estUnitPrice: 650n, category: 'structural', note: 'OPC 42.5' },
      { materialName: 'Ballast', unit: 'tonne', qty: 10 },
    ])
  }

  it('full conversion: every line, draft status, MR-1001 first, lineage note, default requester', async () => {
    const boqId = seedTwoLineBoq()
    const r = await boqToRequest(P, { id: boqId })
    expect(r.requestCode).toBe('MR-1001') // 1000 + count(0) + 1
    expect(r.lines).toBe(2)
    expect(r.id).toBeTruthy()

    const request = state.requests.get(r.id)!
    expect(request.projectId).toBe(P)
    expect(request.status).toBe('draft')
    expect(request.requestedByRole).toBe('contractor') // default
    expect(request.requestedByName).toBe('Site Manager') // default
    // Notes-only lineage: the request's notes name the source BOQ + version.
    expect(request.notes).toBe('From BOQ "Revised plan" v2')

    // Request lines carry ONLY materialName/unit/qty — no price, category or
    // note crosses over (MaterialRequestLine has no such columns).
    const lines = [...state.requestLines.values()].filter((l) => l.requestId === r.id)
    expect(lines).toHaveLength(2)
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(['id', 'materialName', 'qty', 'requestId', 'unit'])
    }
    expect(lines.find((l) => l.materialName === 'Cement')!.qty).toBe(120)
  })

  it('an explicit requester is honored; the MR- code advances with THIS project’s count only', async () => {
    const boqId = seedTwoLineBoq()
    const first = await boqToRequest(P, { id: boqId, requestedByRole: 'supervisor', requestedByName: 'Akinyi' })
    expect(state.requests.get(first.id)!.requestedByRole).toBe('supervisor')
    expect(state.requests.get(first.id)!.requestedByName).toBe('Akinyi')

    // Another project's requests do not advance P's sequence…
    const theirBoq = seedBoq(OTHER, { name: 'Their BOQ', version: 1, createdAt: T(1) }, [{ materialName: 'Sand' }])
    const theirs = await boqToRequest(OTHER, { id: theirBoq })
    expect(theirs.requestCode).toBe('MR-1001')

    // …but P's own second request does.
    const second = await boqToRequest(P, { id: boqId })
    expect(second.requestCode).toBe('MR-1002')
  })

  it('selected lineIds carry only the chosen lines', async () => {
    const boqId = seedTwoLineBoq()
    const cementId = [...state.boqLines.values()].find((l) => l.boqId === boqId && l.materialName === 'Cement')!.id as string
    const r = await boqToRequest(P, { id: boqId, lineIds: [cementId] })
    expect(r.lines).toBe(1)
    const lines = [...state.requestLines.values()].filter((l) => l.requestId === r.id)
    expect(lines).toHaveLength(1)
    expect(lines[0].materialName).toBe('Cement')
  })

  it('an EMPTY lineIds array means ALL lines (current semantics); unknown ids narrow to nothing → refusal', async () => {
    const boqId = seedTwoLineBoq()
    const all = await boqToRequest(P, { id: boqId, lineIds: [] })
    expect(all.lines).toBe(2)
    // lineIds that match none of the BOQ's own lines: the filter empties →
    // honest refusal (a foreign line id cannot be smuggled in).
    await expect(boqToRequest(P, { id: boqId, lineIds: ['foreign-line'] })).rejects.toThrow('BOQ has no lines')
  })

  it('refuses a BOQ with no lines at all', async () => {
    const empty = seedBoq(P, { name: 'Empty BOQ', version: 1, createdAt: T(1) })
    await expect(boqToRequest(P, { id: empty })).rejects.toThrow('BOQ has no lines')
    expect(state.requests.size).toBe(0) // nothing persisted by the refusal
    await expect(boqToRequest(P, { id: 'nope' })).rejects.toThrow('BOQ not found')
  })
})

// --------------------------------------------------- saveSupplier/unsaveSupplier

describe('saveSupplier / unsaveSupplier — the shortlist round-trip', () => {
  it('saveSupplier refuses an unknown supplier', async () => {
    await expect(saveSupplier(P, { supplierId: 'ghost' })).rejects.toThrow('Supplier not found')
    expect(state.saved.size).toBe(0)
  })

  it('creates the shortlist row, then UPDATES the note on re-save (no duplicate rows)', async () => {
    const sid = seedSupplierRow('sup-1')
    const first = await saveSupplier(P, { supplierId: sid, savedBy: 'Akinyi', note: 'best prices' })
    const row = state.saved.get(first.id)!
    expect(row.projectId).toBe(P)
    expect(row.supplierId).toBe(sid)
    expect(row.savedBy).toBe('Akinyi')
    expect(row.note).toBe('best prices')

    const second = await saveSupplier(P, { supplierId: sid, note: 'negotiated better' })
    expect(second.id).toBe(first.id) // upsert: the same row…
    expect(state.saved.size).toBe(1) // …not a duplicate
    expect(state.saved.get(first.id)!.note).toBe('negotiated better')

    // A second save with NO note leaves the stored note alone (undefined =
    // leave-unchanged semantics).
    await saveSupplier(P, { supplierId: sid })
    expect(state.saved.get(first.id)!.note).toBe('negotiated better')
  })

  it('the shortlist is PER PROJECT; unsaveSupplier removes and is a no-op when nothing was saved', async () => {
    const sid = seedSupplierRow('sup-2')
    await saveSupplier(P, { supplierId: sid })
    await saveSupplier(OTHER, { supplierId: sid })
    expect(state.saved.size).toBe(2) // one row per project

    const r1 = await unsaveSupplier(P, { supplierId: sid })
    expect(r1.removed).toBe(true)
    expect([...state.saved.values()].filter((s) => s.projectId === P)).toHaveLength(0)
    expect([...state.saved.values()].filter((s) => s.projectId === OTHER)).toHaveLength(1) // OTHER keeps its row

    // Un-saving again (or something never saved) still reports removed —
    // the UI treats it as an idempotent toggle.
    const r2 = await unsaveSupplier(P, { supplierId: sid })
    expect(r2.removed).toBe(true)
    const r3 = await unsaveSupplier(P, { supplierId: 'never-saved' })
    expect(r3.removed).toBe(true)
  })
})

// ------------------------------------------- dispatcher + payload wiring pins

describe('actions surface — the BOQ + supplier actions are ordinary inventory actions', () => {
  it('INVENTORY_ACTIONS declares every BOQ and supplier shortlist action', () => {
    for (const a of ['boq.create', 'boq.line.upsert', 'boq.line.delete', 'boq.approve', 'boq.to_request', 'supplier.save', 'supplier.unsave']) {
      expect(INVENTORY_ACTIONS).toContain(a)
    }
  })

  it('applyInventoryAction routes them to the service (offline replay path)', async () => {
    const created = await applyInventoryAction('boq.create', { name: 'Dispatch BOQ', lines: [{ materialName: 'Cement', qty: 2 }] }, P)
    expect(created.version).toBe(1)
    const line = await applyInventoryAction('boq.line.upsert', { boqId: created.id, materialName: 'Ballast' }, P)
    await applyInventoryAction('boq.approve', { id: created.id }, P)
    const req = await applyInventoryAction('boq.to_request', { id: created.id }, P)
    expect(req.requestCode).toBe('MR-1001')

    const sid = seedSupplierRow('sup-dispatch')
    const saved = await applyInventoryAction('supplier.save', { supplierId: sid }, P)
    expect(saved.id).toBeTruthy()
    const removed = await applyInventoryAction('supplier.unsave', { supplierId: sid }, P)
    expect(removed.removed).toBe(true)

    // The line added through the dispatcher is removable through it too.
    const gone = await applyInventoryAction('boq.line.delete', { id: line.id }, P)
    expect(gone.id).toBe(line.id)
  })
})

describe('source pins — payload + UI wiring (house style)', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

  it('the project payload serves BOTH slices (mjengo.ts wiring)', () => {
    const src = read('src/backend/lib/mjengo.ts')
    expect(src).toContain('loadInventorySlice(project.id)')
    expect(src).toContain('loadBoqSlice(project.id)')
  })

  it('boq-card dispatches create/approve/to_request/line.upsert through the shared dispatch (outbox queueing)', () => {
    const src = read('src/frontend/mjengo/finder/sections/dashboard/boq-card.tsx')
    expect(src).toContain("dispatch('boq.create'")
    expect(src).toContain("dispatch('boq.line.upsert'")
    expect(src).toContain("dispatch('boq.approve'")
    expect(src).toContain("dispatch('boq.to_request'")
    // The generated-request toast finds the draft MR by its lineage note —
    // the notes-only lineage contract, consumed client-side.
    expect(src).toContain('From BOQ "${boq.name}"')
  })

  it('supplier-directory toggles the shortlist through supplier.save / supplier.unsave', () => {
    const src = read('src/frontend/mjengo/finder/sections/search/supplier-directory.tsx')
    expect(src).toContain("'supplier.unsave' : 'supplier.save'")
  })
})
