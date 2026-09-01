// Inventory slice loaders for the project payload (spec §33/§35).
// Derived closing stock from append-only movements — never stored.

import { db } from '@/lib/db'
import type { InventorySlice, BoqSlice, StockMovementRow, StockMovementType } from './types'

export async function loadInventorySlice(projectId: string): Promise<InventorySlice> {
  const items = await db.inventoryItem.findMany({
    where: { projectId },
    include: { movements: { orderBy: { createdAt: 'desc' } } },
  })
  const rows = items.map((item) => {
    const sum = (type: string) =>
      item.movements.filter((m) => m.type === type).reduce((s, m) => s + m.quantity, 0)
    const openingQty = sum('opening')
    const receivedQty = sum('received')
    const consumedQty = sum('consumed')
    const transferredQty = sum('transferred_out') - sum('transferred_in')
    const returnedQty = sum('returned')
    const damagedQty = sum('damaged')
    const adjustedQty = sum('adjusted')
    const closingQty =
      openingQty + receivedQty + returnedQty + sum('transferred_in') -
      sum('transferred_out') - consumedQty - damagedQty + adjustedQty
    const lastCost = item.movements.find((m) => m.unitCost != null)?.unitCost ?? 0
    const movements: StockMovementRow[] = item.movements.map((m) => ({
      id: m.id,
      inventoryItemId: m.inventoryItemId,
      materialName: item.materialName,
      unit: item.unit,
      type: m.type as StockMovementType,
      quantity: m.quantity,
      unitCost: m.unitCost,
      reference: m.reference,
      note: m.note,
      recordedBy: m.recordedBy,
      createdAt: m.createdAt.toISOString(),
    }))
    return {
      id: item.id,
      materialName: item.materialName,
      unit: item.unit,
      location: item.location,
      supplierId: item.supplierId,
      openingQty,
      receivedQty,
      consumedQty,
      transferredQty,
      returnedQty,
      damagedQty,
      adjustedQty,
      closingQty,
      stockValue: closingQty * lastCost,
      lowStock: false,
      updatedAt: item.updatedAt.toISOString(),
      movements,
    }
  })
  // Flatten movements newest-first across items
  const allMovements = rows
    .flatMap((r) => r.movements)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const itemsWithoutMovements = rows.map(({ movements, ...rest }) => rest)
  return { items: itemsWithoutMovements, movements: allMovements }
}

export async function loadBoqSlice(projectId: string): Promise<BoqSlice> {
  const boqs = await db.boq.findMany({
    where: { projectId },
    include: { lines: true },
    orderBy: { createdAt: 'desc' },
  })
  return {
    boqs: boqs.map((b) => ({
      id: b.id,
      name: b.name,
      version: b.version,
      status: b.status,
      total: b.lines.reduce((s, l) => s + l.qty * l.estUnitPrice, 0),
      lines: b.lines.map((l) => ({
        id: l.id,
        materialName: l.materialName,
        unit: l.unit,
        qty: l.qty,
        estUnitPrice: l.estUnitPrice,
        category: l.category,
        note: l.note,
      })),
      createdAt: b.createdAt.toISOString(),
    })),
  }
}
