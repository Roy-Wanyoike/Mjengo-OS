/**
 * Honest low-stock crossings (issue #207) — the service write paths +
 * notifyLowStockCrossing seam in src/backend/modules/inventory/service.ts.
 *
 * #207 made lowStock a server-owned flag (ONE rule — modules/inventory/
 * low-stock.ts). The flag itself is pinned where it is computed
 * (inventory-slices.test.ts, over the #195 harness); THIS file pins the
 * event half of the issue's expected behavior: crossing the threshold
 * notifies the roles that reorder, through the existing notify seam —
 * ONE notification per CROSSING, never per read.
 *
 * Pinned here (in-memory Prisma stub mirroring inventory-atomicity.test.ts,
 * plus a spy on the notify seam):
 *
 *  · CROSSING — a consume that flips the item from not-low to low fires
 *    exactly ONE notify (kind 'stock.low', audienceRole 'contractor',
 *    project-scoped, material/unit/closing in the body);
 *  · ONE PER CROSSING — a second consume while ALREADY low fires nothing;
 *    recovering (receive) and crossing again fires a SECOND notify — the
 *    counter tracks crossings, not writes or reads;
 *  · NO CROSSING, NO NOISE — healthy-stock movements never notify; a
 *    rolled-back write (stub-injected movement failure) never notifies
 *    (the notification is emitted only after the transaction commits);
 *  · THE THRESHOLD GOVERNS — a reorderLevel set through inventory.open
 *    makes a crossing the derived default would NOT flag, and the level
 *    persists on the item row (the upsert is the configuration seam);
 *  · BORN LOW — opening a line below its own reorder point is an honest
 *    first crossing;
 *  · TRANSFERS CARRY THE THRESHOLD — a transfer's destination item is
 *    created with the source's reorderLevel (the threshold belongs to
 *    the material, not the shelf);
 *  · VALIDATION — reorderLevel is parsed at the boundary: garbage and
 *    negatives are refused BEFORE any row is written; 0 is legal (the
 *    "alert only at stockout" setting).
 *
 * Deliberately NOT duplicated here: the flag's arithmetic (inventory-slices
 * .test.ts), the movement math/atomicity (inventory-atomicity.test.ts), and
 * the count-post crossing (inventory-reconciliation-realdb.test.ts, where
 * posting a shortfall count crosses an item into low on the real engine).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The notify seam, spied: service.notifyLowStockCrossing calls THIS and
// nothing else — one row per crossing is the contract under test.
vi.mock('@/backend/modules/notify/service', () => ({
  notify: vi.fn(async () => ({ id: 'notif_1' })),
}))

// In-memory Prisma stub: just enough of inventoryItem / stockMovement /
// $transaction for the movement core (the inventory-atomicity.test.ts idiom).
// The upsert honours the #207 reorderLevel on both branches.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    items: new Map<string, Record<string, unknown>>(),
    movements: new Map<string, Record<string, unknown>>(),
    failOnMovementType: null as string | null,
    reset() {
      state.items.clear()
      state.movements.clear()
      state.seq = 0
      state.failOnMovementType = null
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const movementsFor = (itemId: string) =>
    [...state.movements.values()].filter((m) => m.inventoryItemId === itemId)

  const inventoryItem = {
    async upsert({ where, update, create }: { where: { projectId_materialName_location: Record<string, string> }; update: Record<string, unknown>; create: Record<string, unknown> }) {
      const key = where.projectId_materialName_location
      const existing = [...state.items.values()].find(
        (i) => i.projectId === key.projectId && i.materialName === key.materialName && i.location === key.location,
      )
      if (existing) {
        // Replace (never mutate in place) so $transaction snapshots restore cleanly.
        const updated = {
          ...existing,
          unit: update.unit,
          ...(update.supplierId !== undefined ? { supplierId: update.supplierId } : {}),
          ...(update.reorderLevel !== undefined ? { reorderLevel: update.reorderLevel } : {}),
        }
        state.items.set(updated.id as string, updated)
        return { ...updated, movements: movementsFor(updated.id as string) }
      }
      const item: Record<string, unknown> = { id: nid('item'), ...create }
      state.items.set(item.id as string, item)
      return { ...item, movements: [] }
    },
    async findFirst({ where }: { where: { id: string; projectId: string } }) {
      const item = state.items.get(where.id)
      return item && item.projectId === where.projectId
        ? { ...item, movements: movementsFor(where.id) }
        : null
    },
  }
  const stockMovement = {
    async create({ data }: { data: Record<string, unknown> }) {
      if (state.failOnMovementType && data.type === state.failOnMovementType) {
        throw new Error(`stub: simulated failure writing ${String(data.type)}`)
      }
      const m: Record<string, unknown> = { id: nid('mv'), createdAt: new Date(), ...data }
      state.movements.set(m.id as string, m)
      return { ...m }
    },
  }
  const db = {
    inventoryItem,
    stockMovement,
    async $transaction(fn: (tx: typeof db) => unknown) {
      const items = new Map(state.items)
      const movements = new Map(state.movements)
      try {
        return await fn(db)
      } catch (err) {
        state.items = items
        state.movements = movements
        throw err
      }
    },
    __state: state,
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { notify } from '@/backend/modules/notify/service'
import {
  consumeStock,
  openStock,
  receiveStock,
  transferStock,
} from '@/backend/modules/inventory/service'

const notifySpy = vi.mocked(notify)
type StubState = {
  items: Map<string, Record<string, unknown>>
  movements: Map<string, Record<string, unknown>>
  failOnMovementType: string | null
  reset: () => void
}
const state = (db as unknown as { __state: StubState }).__state

const P = 'proj-1'

beforeEach(() => {
  state.reset()
  notifySpy.mockClear()
})

describe('#207 — a threshold crossing notifies the reordering role (once per crossing)', () => {
  it('a consume that flips the item into low fires exactly ONE notify through the seam', async () => {
    const { inventoryItemId } = await openStock(P, { materialName: 'Cement', unit: 'bag', qty: 10 })
    // 10 in → 10% threshold = 1. Consume 9: closing 1 ≤ 1 → LOW (crossing).
    const r = await consumeStock(P, { inventoryItemId, qty: 9 })

    expect(r.lowStockCrossing).toBe(true)
    expect(r.closingQty).toBe(1)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    const [projectId, title, body, opts] = notifySpy.mock.calls[0]
    expect(projectId).toBe(P)
    expect(title).toBe('Low stock: Cement')
    expect(body).toContain('Cement')
    expect(body).toContain('1 bag')
    expect(opts).toMatchObject({ kind: 'stock.low', audienceRole: 'contractor' })
  })

  it('a second consume while ALREADY low fires nothing — one per crossing, not per write', async () => {
    const { inventoryItemId } = await openStock(P, { materialName: 'Cement', unit: 'bag', qty: 10 })
    await consumeStock(P, { inventoryItemId, qty: 9 }) // crossing → 1 notify
    expect(notifySpy).toHaveBeenCalledTimes(1)

    // Still draining, still low: closing 0 — no NEW crossing, no notify.
    const r = await consumeStock(P, { inventoryItemId, qty: 1 })
    expect(r.lowStockCrossing).toBe(false)
    expect(r.closingQty).toBe(0)
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('recovering out of low is silent; crossing AGAIN is a fresh crossing with a second notify', async () => {
    const { inventoryItemId } = await openStock(P, { materialName: 'Cement', unit: 'bag', qty: 10 })
    await consumeStock(P, { inventoryItemId, qty: 9 }) // → low (1)
    await receiveStock(P, { materialName: 'Cement', unit: 'bag', qty: 20 }) // closing 21 → recovered, silent
    expect(notifySpy).toHaveBeenCalledTimes(1)

    // Drain to 1 again (21 − 20): 1 ≤ (30 × 10% = 3) → LOW → fresh crossing.
    const r = await consumeStock(P, { inventoryItemId, qty: 20 })
    expect(r.lowStockCrossing).toBe(true)
    expect(r.closingQty).toBe(1)
    expect(notifySpy).toHaveBeenCalledTimes(2)
  })

  it('healthy-stock movements never notify', async () => {
    const { inventoryItemId } = await openStock(P, { materialName: 'Ballast', unit: 'tonne', qty: 100 })
    const r = await consumeStock(P, { inventoryItemId, qty: 5 }) // closing 95 of 100
    expect(r.lowStockCrossing).toBe(false)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('a ROLLED-BACK write never notifies — the row is emitted only after the transaction commits', async () => {
    const { inventoryItemId } = await openStock(P, { materialName: 'Cement', unit: 'bag', qty: 10 })
    state.failOnMovementType = 'consumed'
    await expect(consumeStock(P, { inventoryItemId, qty: 9 })).rejects.toThrow(/simulated failure/)
    expect(notifySpy).not.toHaveBeenCalled()
    // And the ledger is untouched: the retry that WILL commit still crosses.
    state.failOnMovementType = null
    const r = await consumeStock(P, { inventoryItemId, qty: 9 })
    expect(r.lowStockCrossing).toBe(true)
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })
})

describe('#207 — the explicit reorderLevel governs crossings (and is the configuration seam)', () => {
  it('a level set through inventory.open makes a crossing the derived default would NOT flag', async () => {
    // 100 in, reorderLevel 60: consume 40 → closing 60 ≤ 60 → LOW. The
    // derived default (10% of 100 = 10) would call 60 perfectly healthy.
    const { inventoryItemId } = await openStock(P, { materialName: 'Cement', unit: 'bag', qty: 100, reorderLevel: 60 })
    const healthy = await consumeStock(P, { inventoryItemId, qty: 30 }) // closing 70 > 60
    expect(healthy.lowStockCrossing).toBe(false)
    expect(notifySpy).not.toHaveBeenCalled()

    const crossing = await consumeStock(P, { inventoryItemId, qty: 10 }) // closing 60 == level
    expect(crossing.lowStockCrossing).toBe(true)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0][3]).toMatchObject({ kind: 'stock.low' })
  })

  it('the level persists on the item row; a later receive without one leaves it alone', async () => {
    const { inventoryItemId } = await openStock(P, { materialName: 'Cement', unit: 'bag', qty: 50, reorderLevel: 12 })
    let item = [...state.items.values()].find((i) => i.id === inventoryItemId)!
    expect(item.reorderLevel).toBe(12)

    // receiveStock upserts the same (project, material, location) — absent
    // reorderLevel must NOT clobber the stored 12.
    await receiveStock(P, { materialName: 'Cement', unit: 'bag', qty: 5 })
    item = [...state.items.values()].find((i) => i.id === inventoryItemId)!
    expect(item.reorderLevel).toBe(12)

    // …and the still-stored level still governs: closing 55 → 30 → ≤ 12 later.
    await consumeStock(P, { inventoryItemId, qty: 43 }) // closing 12 == level → crossing
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('opening a line below its own reorder point is an honest first crossing (born low)', async () => {
    const r = await openStock(P, { materialName: 'Tiles', unit: 'box', qty: 5, reorderLevel: 10 })
    expect(r.closingQty).toBe(5)
    expect(r.lowStockCrossing).toBe(true)
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('a transfer destination is created with the source reorderLevel — the threshold travels with the material', async () => {
    const { inventoryItemId } = await openStock(P, { materialName: 'Cement', unit: 'bag', qty: 100, reorderLevel: 25 })
    const r = await transferStock(P, { inventoryItemId, qty: 30, toLocation: 'Slab store' })
    expect(r.from.closingQty).toBe(70)
    expect(r.from.lowStockCrossing).toBe(false) // 70 > 25
    expect(r.to.closingQty).toBe(30)
    expect(r.to.lowStockCrossing).toBe(false) // 30 > 25 — but the level is THERE:

    const dest = [...state.items.values()].find((i) => i.location === 'Slab store')!
    expect(dest.reorderLevel).toBe(25)

    // Drain the destination under the inherited level → crossing + notify.
    const drain = await consumeStock(P, { inventoryItemId: dest.id as string, qty: 15 }) // closing 15 ≤ 25
    expect(drain.lowStockCrossing).toBe(true)
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('reorderLevel is validated at the boundary — garbage and negatives refused before any write', async () => {
    await expect(openStock(P, { materialName: 'Cement', unit: 'bag', qty: 10, reorderLevel: 'soon' }))
      .rejects.toThrow(/reorderLevel must be zero or more/)
    await expect(openStock(P, { materialName: 'Cement', unit: 'bag', qty: 10, reorderLevel: -1 }))
      .rejects.toThrow(/reorderLevel must be zero or more/)
    await expect(receiveStock(P, { materialName: 'Cement', unit: 'bag', qty: 10, reorderLevel: 1e12 }))
      .rejects.toThrow(/exceeds the cap/)
    expect(state.items.size).toBe(0) // nothing was written
    expect(notifySpy).not.toHaveBeenCalled()

    // 0 is legal — the "alert only at stockout" setting.
    const r = await openStock(P, { materialName: 'Cement', unit: 'bag', qty: 3, reorderLevel: 0 })
    expect(r.lowStockCrossing).toBe(false) // closing 3 > 0
    expect(notifySpy).not.toHaveBeenCalled()
  })
})
