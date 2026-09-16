/**
 * Inventory atomicity (DB-2) — src/backend/modules/inventory/service.ts.
 *
 * Closing stock is derived from the append-only StockMovement log, so the
 * service write paths are the invariant's last line of defence:
 *  · over-consumption is rejected BEFORE any movement row is persisted;
 *  · return / damage / adjust report the REAL derived closing (the old code
 *    hardcoded closingQty: 0);
 *  · a transfer's out+in legs are ONE atomic unit — the second write failing
 *    rolls the first one back too.
 *
 * Mirrors tests/unit/ledger.test.ts: @/backend/lib/db is swapped for an
 * in-memory stub whose $transaction snapshots state and restores it on throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: just enough of inventoryItem / stockMovement /
// $transaction for the movement core. __state exposes the tables for
// assertions; failOnMovementType injects a write failure for rollback tests.
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
import { derivedClosingQty } from '@/backend/modules/inventory/repository'
import {
  adjustStock, consumeStock, damageStock, openStock, receiveStock, returnStock, transferStock,
} from '@/backend/modules/inventory/service'

type StubState = {
  items: Map<string, Record<string, unknown>>
  movements: Map<string, Record<string, unknown>>
  failOnMovementType: string | null
  reset: () => void
}
const state = (db as unknown as { __state: StubState }).__state
const movementsOf = (itemId: string) =>
  [...state.movements.values()].filter((m) => m.inventoryItemId === itemId)

const P = 'proj-1'
async function seedItem(qty = 10): Promise<string> {
  const r = await openStock(P, { materialName: 'Cement', unit: 'bags', qty, location: 'Site Store', unitCost: 750 })
  return r.inventoryItemId
}

beforeEach(() => {
  state.reset()
})

describe('consumeStock — over-consumption never persists (DB-2)', () => {
  it('rejects consuming more than closing stock and writes no movement row', async () => {
    const itemId = await seedItem(10)
    await expect(consumeStock(P, { inventoryItemId: itemId, qty: 15 })).rejects.toThrow(
      'Cannot consume more than closing stock',
    )
    expect(movementsOf(itemId).filter((m) => m.type === 'consumed')).toHaveLength(0)
    expect(state.movements.size).toBe(1) // only the opening row survives
    expect(derivedClosingQty(movementsOf(itemId))).toBe(10)
  })

  it('accepts consumption up to the exact closing stock and reports it', async () => {
    const itemId = await seedItem(10)
    const r = await consumeStock(P, { inventoryItemId: itemId, qty: 10 })
    expect(r.closingQty).toBe(0)
    expect(movementsOf(itemId)).toHaveLength(2)
  })

  it('reports the real projected closing after a partial consumption', async () => {
    const itemId = await seedItem(10)
    const r = await consumeStock(P, { inventoryItemId: itemId, qty: 4 })
    expect(r.closingQty).toBe(6)
  })

  it('unknown item id is rejected', async () => {
    await expect(consumeStock(P, { inventoryItemId: 'nope', qty: 1 })).rejects.toThrow('Inventory item not found')
  })
})

describe('return / damage / adjust — real derived closing, not a hardcoded 0 (DB-2)', () => {
  it('returnStock adds the returned qty to the derived closing', async () => {
    const itemId = await seedItem(10)
    await consumeStock(P, { inventoryItemId: itemId, qty: 4 }) // closing 6
    const r = await returnStock(P, { inventoryItemId: itemId, qty: 3, note: 'unused bags back' })
    expect(r.type).toBe('returned')
    expect(r.closingQty).toBe(9)
  })

  it('damageStock subtracts from the derived closing', async () => {
    const itemId = await seedItem(10)
    const r = await damageStock(P, { inventoryItemId: itemId, qty: 2, damageNote: 'rain damage' })
    expect(r.type).toBe('damaged')
    expect(r.closingQty).toBe(8)
  })

  it('adjustStock applies the signed adjustment to the derived closing', async () => {
    const itemId = await seedItem(10)
    const up = await adjustStock(P, { inventoryItemId: itemId, qty: 5, reason: 'count correction' })
    expect(up.closingQty).toBe(15)
    const down = await adjustStock(P, { inventoryItemId: itemId, qty: -3, reason: 'count correction' })
    expect(down.closingQty).toBe(12)
  })

  it('every result matches the repository movement-sum oracle', async () => {
    const itemId = await seedItem(10)
    await receiveStock(P, { materialName: 'Cement', unit: 'bags', qty: 5, location: 'Site Store' })
    await consumeStock(P, { inventoryItemId: itemId, qty: 3 })
    const r = await damageStock(P, { inventoryItemId: itemId, qty: 2 })
    expect(r.closingQty).toBe(derivedClosingQty(movementsOf(itemId)))
    expect(r.closingQty).toBe(10)
  })
})

describe('transferStock — atomic out+in legs (DB-2)', () => {
  it('moves stock between locations as one unit with real closings on both sides', async () => {
    const itemId = await seedItem(10)
    const r = await transferStock(P, { inventoryItemId: itemId, qty: 4, toLocation: 'Workshop' })
    expect(movementsOf(itemId).map((m) => m.type)).toContain('transferred_out')
    const toId = r.to.inventoryItemId as string
    expect(toId).not.toBe(itemId)
    expect(movementsOf(toId).map((m) => m.type)).toEqual(['transferred_in'])
    expect(derivedClosingQty(movementsOf(itemId))).toBe(6)
    expect(derivedClosingQty(movementsOf(toId))).toBe(4)
  })

  it('rejects transferring more than closing stock (nothing persisted)', async () => {
    const itemId = await seedItem(3)
    await expect(transferStock(P, { inventoryItemId: itemId, qty: 5, toLocation: 'Workshop' })).rejects.toThrow(
      'Cannot transfer more than closing stock',
    )
    expect(state.movements.size).toBe(1)
    expect(state.items.size).toBe(1)
  })

  it('rolls the out leg back when the in leg write fails', async () => {
    const itemId = await seedItem(10)
    state.failOnMovementType = 'transferred_in'
    await expect(transferStock(P, { inventoryItemId: itemId, qty: 4, toLocation: 'Workshop' })).rejects.toThrow(
      /simulated failure writing transferred_in/,
    )
    const legs = [...state.movements.values()].filter((m) => m.type === 'transferred_out' || m.type === 'transferred_in')
    expect(legs).toHaveLength(0) // neither leg survived
    expect(state.items.size).toBe(1) // the destination item creation rolled back too
    expect(derivedClosingQty(movementsOf(itemId))).toBe(10)
  })
})
