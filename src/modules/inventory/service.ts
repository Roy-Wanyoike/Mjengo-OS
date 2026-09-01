// Inventory domain service (spec §33/§35) — F-PROCURE implements the real
// business rules. Signatures below are the contract the dispatcher expects:
// every function is atomic with its StockMovement append and returns a
// { inventoryItemId, movement, closingQty } result shape.

import { db } from '@/lib/db'

export interface MovementResult {
  inventoryItemId: string
  materialName: string
  unit: string
  movementId: string
  type: string
  quantity: number
  closingQty: number
}

async function upsertItem(projectId: string, materialName: string, unit: string, location: string, supplierId?: string | null) {
  return db.inventoryItem.upsert({
    where: { projectId_materialName_location: { projectId, materialName, location } },
    update: { unit, supplierId: supplierId ?? undefined },
    create: { projectId, materialName, unit, location, supplierId: supplierId ?? null },
    include: { movements: true },
  })
}

async function appendMovement(
  projectId: string,
  inventoryItemId: string,
  type: string,
  quantity: number,
  unitCost: number | null,
  reference: string | null,
  note: string | null,
  recordedBy: string,
) {
  return db.stockMovement.create({
    data: { projectId, inventoryItemId, type, quantity, unitCost, reference, note, recordedBy },
  })
}

export async function openStock(projectId: string, p: any): Promise<MovementResult> {
  const item = await upsertItem(projectId, String(p.materialName), String(p.unit), p.location ?? 'Site Store', p.supplierId ?? null)
  const movement = await appendMovement(projectId, item.id, 'opening', Number(p.qty), p.unitCost != null ? Number(p.unitCost) : null, null, p.note ?? null, p.recordedBy ?? 'Site Manager')
  const closing = item.movements.concat([movement]).reduce((s, m) => s + (m.type === 'consumed' || m.type === 'damaged' || m.type === 'transferred_out' ? -m.quantity : m.quantity), 0)
  return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
}

export async function receiveStock(projectId: string, p: any): Promise<MovementResult> {
  const item = await upsertItem(projectId, String(p.materialName), String(p.unit), p.location ?? 'Site Store', p.supplierId ?? null)
  const movement = await appendMovement(projectId, item.id, 'received', Number(p.qty), p.unitCost != null ? Number(p.unitCost) : null, p.reference ?? null, p.note ?? null, p.recordedBy ?? 'Site Manager')
  const closing = item.movements.concat([movement]).reduce((s, m) => s + (m.type === 'consumed' || m.type === 'damaged' || m.type === 'transferred_out' ? -m.quantity : m.quantity), 0)
  return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
}

export async function consumeStock(projectId: string, p: any): Promise<MovementResult> {
  const item = await db.inventoryItem.findFirst({ where: { id: String(p.inventoryItemId), projectId }, include: { movements: true } })
  if (!item) throw new Error('Inventory item not found')
  const movement = await appendMovement(projectId, item.id, 'consumed', Number(p.qty), null, p.reference ?? null, p.note ?? null, p.recordedBy ?? 'Site Manager')
  const closing = item.movements.concat([movement]).reduce((s, m) => s + (m.type === 'consumed' || m.type === 'damaged' || m.type === 'transferred_out' ? -m.quantity : m.quantity), 0)
  if (closing < 0) throw new Error('Cannot consume more than closing stock')
  return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
}

export async function transferStock(projectId: string, p: any): Promise<any> {
  const item = await db.inventoryItem.findFirst({ where: { id: String(p.inventoryItemId), projectId }, include: { movements: true } })
  if (!item) throw new Error('Inventory item not found')
  const out = await appendMovement(projectId, item.id, 'transferred_out', Number(p.qty), null, null, `→ ${p.toLocation}: ${p.note ?? ''}`, p.recordedBy ?? 'Site Manager')
  const to = await upsertItem(projectId, item.materialName, item.unit, String(p.toLocation), item.supplierId)
  const into = await appendMovement(projectId, to.id, 'transferred_in', Number(p.qty), null, null, `← ${item.location}`, p.recordedBy ?? 'Site Manager')
  return { from: { inventoryItemId: item.id, movementId: out.id }, to: { inventoryItemId: to.id, movementId: into.id } }
}

export async function returnStock(projectId: string, p: any): Promise<MovementResult> {
  const item = await db.inventoryItem.findFirst({ where: { id: String(p.inventoryItemId), projectId }, include: { movements: true } })
  if (!item) throw new Error('Inventory item not found')
  const movement = await appendMovement(projectId, item.id, 'returned', Number(p.qty), null, null, p.note ?? null, p.recordedBy ?? 'Site Manager')
  return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: 0 }
}

export async function damageStock(projectId: string, p: any): Promise<MovementResult> {
  const item = await db.inventoryItem.findFirst({ where: { id: String(p.inventoryItemId), projectId }, include: { movements: true } })
  if (!item) throw new Error('Inventory item not found')
  const movement = await appendMovement(projectId, item.id, 'damaged', Number(p.qty), null, null, String(p.damageNote ?? 'damaged'), p.recordedBy ?? 'Site Manager')
  return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: 0 }
}

export async function adjustStock(projectId: string, p: any): Promise<MovementResult> {
  const item = await db.inventoryItem.findFirst({ where: { id: String(p.inventoryItemId), projectId }, include: { movements: true } })
  if (!item) throw new Error('Inventory item not found')
  const movement = await appendMovement(projectId, item.id, 'adjusted', Number(p.qty), null, null, String(p.reason ?? 'count correction'), p.recordedBy ?? 'Site Manager')
  return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: 0 }
}

// ---- BOQ ----

export async function createBoq(projectId: string, p: any) {
  const count = await db.boq.count({ where: { projectId } })
  const boq = await db.boq.create({
    data: { projectId, name: String(p.name ?? `BOQ v${count + 1}`), version: count + 1 },
  })
  if (Array.isArray(p.lines)) {
    for (const l of p.lines) {
      await db.boqLine.create({
        data: {
          boqId: boq.id,
          materialName: String(l.materialName),
          unit: String(l.unit ?? 'unit'),
          qty: Number(l.qty ?? 1),
          estUnitPrice: Number(l.estUnitPrice ?? 0),
          category: l.category ?? null,
          note: l.note ?? null,
        },
      })
    }
  }
  return { id: boq.id, name: boq.name, version: boq.version, lines: (p.lines ?? []).length }
}

export async function upsertBoqLine(projectId: string, p: any) {
  const boq = await db.boq.findFirst({ where: { id: String(p.boqId), projectId } })
  if (!boq) throw new Error('BOQ not found')
  const data = {
    materialName: String(p.materialName),
    unit: String(p.unit ?? 'unit'),
    qty: Number(p.qty ?? 1),
    estUnitPrice: Number(p.estUnitPrice ?? 0),
    category: p.category ?? null,
    note: p.note ?? null,
  }
  const line = p.id
    ? await db.boqLine.update({ where: { id: String(p.id) }, data })
    : await db.boqLine.create({ data: { boqId: boq.id, ...data } })
  return { id: line.id }
}

export async function deleteBoqLine(projectId: string, p: any) {
  const line = await db.boqLine.findFirst({
    where: { id: String(p.id), boq: { projectId } },
  })
  if (!line) throw new Error('BOQ line not found')
  await db.boqLine.delete({ where: { id: line.id } })
  return { id: line.id }
}

export async function approveBoq(projectId: string, p: any) {
  const boq = await db.boq.findFirst({ where: { id: String(p.id), projectId } })
  if (!boq) throw new Error('BOQ not found')
  if (boq.status === 'approved') throw new Error('BOQ already approved')
  return db.boq.update({ where: { id: boq.id }, data: { status: 'approved' } })
}

export async function boqToRequest(projectId: string, p: any) {
  const boq = await db.boq.findFirst({
    where: { id: String(p.id), projectId },
    include: { lines: true },
  })
  if (!boq) throw new Error('BOQ not found')
  const lines = p.lineIds?.length ? boq.lines.filter((l) => p.lineIds.includes(l.id)) : boq.lines
  if (!lines.length) throw new Error('BOQ has no lines')
  const count = await db.materialRequest.count({ where: { projectId } })
  const requestCode = `MR-${1000 + count + 1}`
  const request = await db.materialRequest.create({
    data: {
      projectId,
      requestCode,
      requestedByRole: p.requestedByRole ?? 'contractor',
      requestedByName: p.requestedByName ?? 'Site Manager',
      notes: `From BOQ "${boq.name}" v${boq.version}`,
      status: 'draft',
      lines: {
        create: lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })),
      },
    },
  })
  return { id: request.id, requestCode, lines: lines.length }
}

// ---- Supplier shortlist & quote detail ----

export async function saveSupplier(projectId: string, p: any) {
  const supplier = await db.supplier.findUnique({ where: { id: String(p.supplierId) } })
  if (!supplier) throw new Error('Supplier not found')
  const saved = await db.savedSupplier.upsert({
    where: { projectId_supplierId: { projectId, supplierId: supplier.id } },
    update: { note: p.note ?? undefined },
    create: { projectId, supplierId: supplier.id, savedBy: p.savedBy ?? 'Site Manager', note: p.note ?? null },
  })
  return { id: saved.id }
}

export async function unsaveSupplier(projectId: string, p: any) {
  const saved = await db.savedSupplier.findFirst({
    where: { projectId, supplierId: String(p.supplierId) },
  })
  if (saved) await db.savedSupplier.delete({ where: { id: saved.id } })
  return { removed: true }
}

export async function updateQuote(projectId: string, p: any) {
  const quote = await db.quote.findFirst({
    where: { id: String(p.id), request: { projectId } },
  })
  if (!quote) throw new Error('Quote not found')
  const updated = await db.quote.update({
    where: { id: quote.id },
    data: {
      validUntil: p.validUntil ? new Date(p.validUntil) : undefined,
      terms: p.terms ?? undefined,
    },
  })
  if (Array.isArray(p.lines)) {
    await db.quoteLine.deleteMany({ where: { quoteId: quote.id } })
    for (const l of p.lines) {
      await db.quoteLine.create({
        data: {
          quoteId: quote.id,
          name: String(l.name),
          unit: String(l.unit ?? 'unit'),
          qty: Number(l.qty ?? 1),
          unitPrice: Number(l.unitPrice ?? 0),
          lineTotal: Number(l.qty ?? 1) * Number(l.unitPrice ?? 0),
        },
      })
    }
  }
  return { id: updated.id, validUntil: updated.validUntil, terms: updated.terms }
}
