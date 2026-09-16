// Inventory domain service (spec §33/§35) — F-PROCURE implements the real
// business rules. Signatures below are the contract the dispatcher expects:
// every function is atomic with its StockMovement append and returns a
// { inventoryItemId, movement, closingQty } result shape.
//
// DB-2 hardening: every write path runs in ONE db.$transaction (the wallet /
// ledger house pattern — guards INSIDE the transaction, not before it);
// consume/transfer project the closing balance from the movements that
// already exist BEFORE persisting, so over-consumption throws without
// leaving a row; transfers write their out+in legs as one atomic unit; and
// every result reports the REAL derived closingQty (return/damage/adjust
// used to hardcode 0).

import { db } from '@/backend/lib/db'
import type { TxClient } from '@/backend/modules/ledger/service'
import { derivedClosingQty } from './repository'

export interface MovementResult {
  inventoryItemId: string
  materialName: string
  unit: string
  movementId: string
  type: string
  quantity: number
  closingQty: number
}

async function upsertItem(
  tx: TxClient,
  projectId: string,
  materialName: string,
  unit: string,
  location: string,
  supplierId?: string | null,
) {
  return tx.inventoryItem.upsert({
    where: { projectId_materialName_location: { projectId, materialName, location } },
    update: { unit, supplierId: supplierId ?? undefined },
    create: { projectId, materialName, unit, location, supplierId: supplierId ?? null },
    include: { movements: true },
  })
}

async function appendMovement(
  tx: TxClient,
  projectId: string,
  inventoryItemId: string,
  type: string,
  quantity: number,
  unitCost: number | null,
  reference: string | null,
  note: string | null,
  recordedBy: string,
) {
  return tx.stockMovement.create({
    data: { projectId, inventoryItemId, type, quantity, unitCost, reference, note, recordedBy },
  })
}

/** Item scoped to the project, WITH its movement log, inside a transaction. */
async function findItem(tx: TxClient, projectId: string, inventoryItemId: string) {
  const item = await tx.inventoryItem.findFirst({ where: { id: inventoryItemId, projectId }, include: { movements: true } })
  if (!item) throw new Error('Inventory item not found')
  return item
}

export async function openStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const item = await upsertItem(tx, projectId, String(p.materialName), String(p.unit), p.location ?? 'Site Store', p.supplierId ?? null)
    const movement = await appendMovement(tx, projectId, item.id, 'opening', Number(p.qty), p.unitCost != null ? Number(p.unitCost) : null, null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function receiveStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const item = await upsertItem(tx, projectId, String(p.materialName), String(p.unit), p.location ?? 'Site Store', p.supplierId ?? null)
    const movement = await appendMovement(tx, projectId, item.id, 'received', Number(p.qty), p.unitCost != null ? Number(p.unitCost) : null, p.reference ?? null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function consumeStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const qty = Number(p.qty)
    // DB-2: project the closing balance from the movements that ALREADY exist
    // before touching the database — over-consumption must throw without
    // persisting a row (the old code appended first and only then checked).
    if (derivedClosingQty(item.movements) - qty < 0) {
      throw new Error('Cannot consume more than closing stock')
    }
    const movement = await appendMovement(tx, projectId, item.id, 'consumed', qty, null, p.reference ?? null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function transferStock(projectId: string, p: any): Promise<any> {
  // DB-2: the out and in legs are ONE atomic unit — the old code wrote them
  // back-to-back with no transaction, so a failure between them stranded the
  // "out" half and silently lost stock. The out leg is guarded by the same
  // negative-stock projection as consume.
  return db.$transaction(async (tx) => {
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const qty = Number(p.qty)
    if (derivedClosingQty(item.movements) - qty < 0) {
      throw new Error('Cannot transfer more than closing stock')
    }
    const out = await appendMovement(tx, projectId, item.id, 'transferred_out', qty, null, null, `→ ${p.toLocation}: ${p.note ?? ''}`, p.recordedBy ?? 'Site Manager')
    const to = await upsertItem(tx, projectId, item.materialName, item.unit, String(p.toLocation), item.supplierId)
    const into = await appendMovement(tx, projectId, to.id, 'transferred_in', qty, null, null, `← ${item.location}`, p.recordedBy ?? 'Site Manager')
    return { from: { inventoryItemId: item.id, movementId: out.id }, to: { inventoryItemId: to.id, movementId: into.id } }
  })
}

export async function returnStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const movement = await appendMovement(tx, projectId, item.id, 'returned', Number(p.qty), null, null, p.note ?? null, p.recordedBy ?? 'Site Manager')
    // DB-2: real derived closing — this path used to hardcode closingQty: 0.
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function damageStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const movement = await appendMovement(tx, projectId, item.id, 'damaged', Number(p.qty), null, null, String(p.damageNote ?? 'damaged'), p.recordedBy ?? 'Site Manager')
    // DB-2: real derived closing — this path used to hardcode closingQty: 0.
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
}

export async function adjustStock(projectId: string, p: any): Promise<MovementResult> {
  return db.$transaction(async (tx) => {
    const item = await findItem(tx, projectId, String(p.inventoryItemId))
    const movement = await appendMovement(tx, projectId, item.id, 'adjusted', Number(p.qty), null, null, String(p.reason ?? 'count correction'), p.recordedBy ?? 'Site Manager')
    // DB-2: real derived closing — this path used to hardcode closingQty: 0.
    const closing = derivedClosingQty(item.movements.concat([movement]))
    return { inventoryItemId: item.id, materialName: item.materialName, unit: item.unit, movementId: movement.id, type: movement.type, quantity: movement.quantity, closingQty: closing }
  })
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
