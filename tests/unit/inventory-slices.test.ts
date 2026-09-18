/**
 * Inventory slice-loader aggregation (issue #195 / audit TEST-5 residual) —
 * src/backend/modules/inventory/repository.ts `loadInventorySlice`.
 *
 * This is where every stock number the product shows is computed: the
 * per-type sums, the transferred netting (out − in), the closing formula,
 * the last-cost stock value and the newest-first movement flattening. A
 * regression here silently corrupts every Materials tab, CSV export and
 * reconciliation view with no test failing — until now.
 *
 * Pinned here over the stubbed tables (the issue's own idiom, mirroring
 * tests/unit/inventory-atomicity.test.ts):
 *
 *  · per-type sums for ALL eight movement types on one kitchen-sink item,
 *    and the closing = Σ signed-deltas equation read off the row fields;
 *  · transferredQty is the NET out − in, pinned on BOTH sides of a transfer
 *    pair (sender positive, destination negative, round-trip mirrors);
 *  · stockValue multiplies the closing by the LATEST cost-bearing
 *    movement's unitCost (not the first, not the newest row, not 0);
 *  · stockValue is 0 when no movement ever carried a cost;
 *  · the flattened movement list is NEWEST-FIRST across all items (not
 *    grouped per item), with the item's name/unit denormalized onto every
 *    row and cents→KSh on unitCost;
 *  · project scoping: another project's items/movements never leak, and an
 *    empty project yields the empty-slice shape (counts included);
 *  · item rows do NOT double-carry the movement log (the loader strips it
 *    from the items array — movements live in the flat list only).
 *
 * Deliberately NOT duplicated here (already pinned elsewhere — see the PR
 * coverage map): the service write paths + qty validation
 * (inventory-atomicity.test.ts, #119), the same aggregation against the
 * REAL engine incl. the append-only ladder and unique keys
 * (inventory-realdb.test.ts, #184), and the counts/uncounted history half
 * of the slice (inventory-reconciliation*.test.ts, #194).
 *
 * KNOWN UNIT DRIFT (#282, pinned as-is — fails on purpose when normalized):
 * writers store unitCost as a raw KSh number into the BigInt column whose
 * comment says cents, so the loader's centsToKes divides by 100 again. The
 * stockValue assertions below pin the CURRENT (drifted) arithmetic so a
 * units fix flips them loudly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: just enough of inventoryItem.findMany (with the
// movements include + orderBy createdAt desc the loader relies on for the
// "latest cost" rule) and stockCount.findMany for loadInventorySlice.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    items: new Map<string, Record<string, unknown>>(),
    movements: new Map<string, Record<string, unknown>>(),
    counts: new Map<string, Record<string, unknown>>(),
    countItems: new Map<string, Record<string, unknown>>(),
    reset() {
      state.items.clear()
      state.movements.clear()
      state.counts.clear()
      state.countItems.clear()
      state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const movementsFor = (itemId: string) =>
    [...state.movements.values()].filter((m) => m.inventoryItemId === itemId)

  const inventoryItem = {
    // The shape loadInventorySlice calls: where.projectId + include
    // movements ordered newest-first (the loader's lastCost rule DEPENDS on
    // this ordering — the stub must reproduce it, not just return rows).
    async findMany({ where }: { where: { projectId: string } }) {
      return [...state.items.values()]
        .filter((i) => i.projectId === where.projectId)
        .map((i) => ({
          ...i,
          movements: movementsFor(i.id as string).sort(
            (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
          ),
        }))
    },
  }
  const stockCount = {
    async findMany({ where, take }: { where: { projectId: string }; take?: number }) {
      const rows = [...state.counts.values()]
        .filter((c) => c.projectId === where.projectId)
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .slice(0, take ?? Number.POSITIVE_INFINITY)
      return rows.map((c) => ({
        ...c,
        items: [...state.countItems.values()]
          .filter((line) => line.countId === c.id)
          .map((line) => ({ ...line, inventoryItem: { ...state.items.get(line.inventoryItemId as string)! } })),
      }))
    },
  }
  const db = { inventoryItem, stockCount, __state: state }
  return { db }
})

import { db } from '@/backend/lib/db'
import { loadInventorySlice } from '@/backend/modules/inventory/repository'

type StubState = {
  items: Map<string, Record<string, unknown>>
  movements: Map<string, Record<string, unknown>>
  counts: Map<string, Record<string, unknown>>
  countItems: Map<string, Record<string, unknown>>
  reset: () => void
}
const state = (db as unknown as { __state: StubState }).__state

const P = 'proj-1'
const OTHER = 'proj-2'

// Fixed, distinct timestamps so newest-first ordering is deterministic.
const T = (h: number) => new Date(`2026-09-01T${String(8 + h).padStart(2, '0')}:00:00.000Z`)

interface SeedMovement {
  type: string
  quantity: number
  unitCost?: bigint | null
  reference?: string | null
  note?: string | null
  recordedBy?: string
  at: Date
}

/** Seed one inventory item with its full movement log (append-only order). */
function seedItem(
  projectId: string,
  spec: { materialName: string; unit?: string; location?: string; supplierId?: string | null },
  movements: SeedMovement[],
): string {
  const id = `item_${++state.seq}`
  state.items.set(id, {
    id,
    projectId,
    materialName: spec.materialName,
    unit: spec.unit ?? 'bag',
    location: spec.location ?? 'Site Store',
    supplierId: spec.supplierId ?? null,
    updatedAt: T(0),
  })
  movements.forEach((m, i) => {
    const mid = `mv_${++state.seq}_${i}`
    state.movements.set(mid, {
      id: mid,
      inventoryItemId: id,
      type: m.type,
      quantity: m.quantity,
      // Writers store the raw KSh number into the BigInt cents column (#282):
      unitCost: m.unitCost === undefined ? null : m.unitCost,
      reference: m.reference ?? null,
      note: m.note ?? null,
      recordedBy: m.recordedBy ?? 'Site Manager',
      createdAt: m.at,
    })
  })
  return id
}

beforeEach(() => {
  state.reset()
})

describe('loadInventorySlice — per-type sums and the closing formula (stubbed tables)', () => {
  it('sums every movement type and closes over the signed-delta equation', async () => {
    // One kitchen-sink item: all eight types, including a transfer back in.
    seedItem(P, { materialName: 'Cement', unit: 'bag' }, [
      { type: 'opening', quantity: 100, unitCost: 750n, at: T(1) },
      { type: 'received', quantity: 50, unitCost: 760n, at: T(2) },
      { type: 'consumed', quantity: 30, at: T(3) },
      { type: 'transferred_out', quantity: 20, at: T(4) },
      { type: 'transferred_in', quantity: 15, at: T(5) },
      { type: 'returned', quantity: 3, at: T(6) },
      { type: 'damaged', quantity: 5, at: T(7) },
      { type: 'adjusted', quantity: -8, at: T(8) },
    ])

    const slice = await loadInventorySlice(P)
    expect(slice.items).toHaveLength(1)
    const row = slice.items[0]
    expect(row.materialName).toBe('Cement')
    expect(row.unit).toBe('bag')
    expect(row.location).toBe('Site Store')
    expect(row.supplierId).toBeNull()
    expect(row.updatedAt).toBe(T(0).toISOString())

    // Per-type sums — each is the Σ of that type's quantities.
    expect(row.openingQty).toBe(100)
    expect(row.receivedQty).toBe(50)
    expect(row.consumedQty).toBe(30)
    expect(row.transferredQty).toBe(5) // out 20 − in 15 (the NET)
    expect(row.returnedQty).toBe(3)
    expect(row.damagedQty).toBe(5)
    expect(row.adjustedQty).toBe(-8) // signed by design

    // The closing formula: opening + received + returned + adjusted +
    // (transferred_in − transferred_out) − consumed − damaged, read off the
    // row's OWN fields (a self-consistency oracle for the sums above).
    expect(row.closingQty).toBe(100 + 50 + 3 - 8 + (15 - 20) - 30 - 5)
    expect(row.closingQty).toBe(105)

    // lowStock is a constant false today — pinned so making it real is a
    // deliberate change, not a silent one.
    expect(row.lowStock).toBe(false)
  })

  it('transferredQty is the NET out − in on BOTH sides of a transfer pair', async () => {
    // Site Store sends 12 bags to the Workshop, gets 7 back.
    const store = seedItem(P, { materialName: 'Cement', location: 'Site Store' }, [
      { type: 'opening', quantity: 40, at: T(1) },
      { type: 'transferred_out', quantity: 12, at: T(2) },
      { type: 'transferred_in', quantity: 7, at: T(3) },
    ])
    const workshop = seedItem(P, { materialName: 'Cement', location: 'Workshop' }, [
      { type: 'transferred_in', quantity: 12, at: T(2) },
      { type: 'transferred_out', quantity: 7, at: T(3) },
    ])

    const slice = await loadInventorySlice(P)
    const from = slice.items.find((i) => i.id === store)!
    const to = slice.items.find((i) => i.id === workshop)!

    // Sender: 12 out, 7 in → net +5. A "sum out only" regression shows 12;
    // a "sum both" regression shows 19; a sign flip shows −5.
    expect(from.transferredQty).toBe(5)
    expect(from.closingQty).toBe(40 - 12 + 7) // 35
    // Destination: 12 in, 7 out → net −12 + 7 = −5 (the mirror image).
    expect(to.transferredQty).toBe(-5)
    expect(to.closingQty).toBe(12 - 7) // 5
  })
})

describe('loadInventorySlice — stockValue from the latest cost-bearing movement', () => {
  it('multiplies the closing by the LATEST movement that carries a unitCost', async () => {
    // Mixed-cost history: opened @ 750, topped up @ 760, then three
    // cost-less movements AFTER the last cost (the hard case — the latest
    // ROW is not the latest COST).
    seedItem(P, { materialName: 'Cement' }, [
      { type: 'opening', quantity: 100, unitCost: 750n, at: T(1) },
      { type: 'received', quantity: 50, unitCost: 760n, at: T(2) },
      { type: 'consumed', quantity: 30, at: T(3) },
      { type: 'damaged', quantity: 5, at: T(4) },
      { type: 'adjusted', quantity: -10, at: T(5) },
    ])

    const slice = await loadInventorySlice(P)
    const row = slice.items[0]
    expect(row.closingQty).toBe(105)

    // KNOWN UNIT DRIFT (#282 — pinned as-is, fails on purpose when fixed):
    // writers store the KSh number raw into the cents column, so the loader
    // computes 105 × 760 "cents" → centsToKes → 798. The value being pinned
    // is the ARITHMETIC: closing × the LATEST cost (760), not the FIRST
    // (750 → 787.5), not the newest row (null → 0), i.e. exactly 798.
    expect(row.stockValue).toBe(798)
  })

  it('falls back to 0 when no movement ever carried a cost', async () => {
    seedItem(P, { materialName: 'Ballast' }, [
      { type: 'opening', quantity: 10, at: T(1) },
      { type: 'consumed', quantity: 4, at: T(2) },
    ])
    const slice = await loadInventorySlice(P)
    expect(slice.items[0].closingQty).toBe(6)
    expect(slice.items[0].stockValue).toBe(0) // lastCost ?? 0n
  })
})

describe('loadInventorySlice — newest-first movement flattening', () => {
  it('flattens movements across ALL items newest-first, denormalizing name/unit onto every row', async () => {
    const ballast = seedItem(P, { materialName: 'Ballast', unit: 'tonne' }, [
      { type: 'opening', quantity: 10, unitCost: 900n, at: T(1), reference: 'GRN-1', note: 'initial', recordedBy: 'Otieno' },
      { type: 'consumed', quantity: 2, at: T(3) },
    ])
    const nails = seedItem(P, { materialName: 'Nails', unit: 'kg', location: 'Workshop' }, [
      { type: 'opening', quantity: 8, at: T(2) },
      { type: 'damaged', quantity: 1, at: T(4) },
    ])

    const slice = await loadInventorySlice(P)
    expect(slice.movements).toHaveLength(4)

    // Interleaved timestamps ACROSS items → the flat list is globally
    // newest-first (T4, T3, T2, T1), not grouped per item.
    expect(slice.movements.map((m) => m.createdAt)).toEqual([
      T(4).toISOString(),
      T(3).toISOString(),
      T(2).toISOString(),
      T(1).toISOString(),
    ])

    // Row field mapping: the item's materialName/unit are denormalized onto
    // every movement; id/inventoryItemId/reference/note/recordedBy pass
    // through; createdAt is an ISO string.
    const newest = slice.movements[0]
    expect(newest.inventoryItemId).toBe(nails)
    expect(newest.materialName).toBe('Nails')
    expect(newest.unit).toBe('kg')
    expect(newest.type).toBe('damaged')
    expect(newest.quantity).toBe(1)
    expect(newest.unitCost).toBeNull()
    const oldest = slice.movements[3]
    expect(oldest.inventoryItemId).toBe(ballast)
    expect(oldest.materialName).toBe('Ballast')
    expect(oldest.unit).toBe('tonne')
    expect(oldest.type).toBe('opening')
    expect(oldest.quantity).toBe(10)
    // #282 drift, pinned as-is: centsToKes(900n) → 9 (the writer stored the
    // KSh number 900 into the cents column). Fails on purpose when fixed.
    expect(oldest.unitCost).toBe(9)
    expect(oldest.reference).toBe('GRN-1')
    expect(oldest.note).toBe('initial')
    expect(oldest.recordedBy).toBe('Otieno')
    expect(new Date(oldest.createdAt).toISOString()).toBe(oldest.createdAt) // ISO round-trips
  })
})

describe('loadInventorySlice — project scoping + slice shape', () => {
  it("never leaks another project's items or movements; an empty project yields the empty slice", async () => {
    seedItem(P, { materialName: 'Cement' }, [
      { type: 'opening', quantity: 100, at: T(1) },
      { type: 'consumed', quantity: 30, at: T(2) },
    ])
    seedItem(OTHER, { materialName: 'Cement' }, [
      { type: 'opening', quantity: 5, at: T(1) },
    ])

    const mine = await loadInventorySlice(P)
    expect(mine.items).toHaveLength(1)
    expect(mine.items[0].closingQty).toBe(70)
    expect(mine.movements).toHaveLength(2)

    const theirs = await loadInventorySlice(OTHER)
    expect(theirs.items).toHaveLength(1)
    expect(theirs.items[0].closingQty).toBe(5)
    expect(theirs.movements).toHaveLength(1)

    // A project with nothing at all: the full empty-slice shape, counts
    // slot included (the #194 half is pinned in the reconciliation suites).
    const empty = await loadInventorySlice('proj-empty')
    expect(empty).toEqual({ items: [], movements: [], counts: [] })
  })

  it('item rows do NOT double-carry the movement log (movements live in the flat list only)', async () => {
    seedItem(P, { materialName: 'Cement' }, [{ type: 'opening', quantity: 10, at: T(1) }])
    const slice = await loadInventorySlice(P)
    expect(slice.items).toHaveLength(1)
    expect('movements' in slice.items[0]).toBe(false)
    expect(slice.movements).toHaveLength(1) // …but the log is served once, flat
  })
})
