// Inventory & BOQ actions (spec §28/§33/§35) — dispatched from
// lib/mjengo.ts applyAction(), which auto-writes the AuditEvent for every
// success — never log manually here.
//
// Thin controller, fat service: this dispatcher only routes; every rule lives
// in src/backend/modules/inventory/service.ts. F-PROCURE implements the service.

import {
  openStock,
  receiveStock,
  consumeStock,
  transferStock,
  returnStock,
  damageStock,
  adjustStock,
  createBoq,
  upsertBoqLine,
  deleteBoqLine,
  approveBoq,
  boqToRequest,
  saveSupplier,
  unsaveSupplier,
  updateQuote,
} from '@/backend/modules/inventory/service'

export const INVENTORY_ACTIONS = [
  'inventory.open', // { materialName, unit, qty, unitCost?, location?, supplierId? } — opening stock
  'inventory.receive', // { inventoryItemId | materialName+unit+location, qty, unitCost?, reference?, note? }
  'inventory.consume', // { inventoryItemId, qty, reference?, note? }
  'inventory.transfer', // { inventoryItemId, qty, toLocation, note? }
  'inventory.return', // { inventoryItemId, qty, note? }
  'inventory.damage', // { inventoryItemId, qty, damageNote }
  'inventory.adjust', // { inventoryItemId, qty, reason } — count correction (±)
  'boq.create', // { name, lines?: [...] }
  'boq.line.upsert', // { boqId, id?, materialName, unit, qty, estUnitPrice?, category?, note? }
  'boq.line.delete', // { id }
  'boq.approve', // { id }
  'boq.to_request', // { id, lineIds? } — generate MaterialRequest from BOQ lines
  'supplier.save', // { supplierId, note? } — save to project's supplier shortlist
  'supplier.unsave', // { supplierId }
  'quote.update', // { id, validUntil?, terms?, lines?: [...] } — quote validity/terms/multi-line detail
] as const

export async function applyInventoryAction(
  type: string,
  payload: any,
  projectId: string,
): Promise<any> {
  const p = payload ?? {}
  switch (type) {
    case 'inventory.open':
      return openStock(projectId, p)
    case 'inventory.receive':
      return receiveStock(projectId, p)
    case 'inventory.consume':
      return consumeStock(projectId, p)
    case 'inventory.transfer':
      return transferStock(projectId, p)
    case 'inventory.return':
      return returnStock(projectId, p)
    case 'inventory.damage':
      return damageStock(projectId, p)
    case 'inventory.adjust':
      return adjustStock(projectId, p)
    case 'boq.create':
      return createBoq(projectId, p)
    case 'boq.line.upsert':
      return upsertBoqLine(projectId, p)
    case 'boq.line.delete':
      return deleteBoqLine(projectId, p)
    case 'boq.approve':
      return approveBoq(projectId, p)
    case 'boq.to_request':
      return boqToRequest(projectId, p)
    case 'supplier.save':
      return saveSupplier(projectId, p)
    case 'supplier.unsave':
      return unsaveSupplier(projectId, p)
    case 'quote.update':
      return updateQuote(projectId, p)
    default:
      throw new Error(`Unknown inventory action: ${type}`)
  }
}
