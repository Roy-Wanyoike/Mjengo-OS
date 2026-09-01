// Inventory domain types (spec §33/§35) — the project payload slices and the
// shapes the UI renders. Closing stock is always derived from movements.

export type StockMovementType =
  | 'opening'
  | 'received'
  | 'consumed'
  | 'transferred_in'
  | 'transferred_out'
  | 'returned'
  | 'damaged'
  | 'adjusted'

export interface InventoryItemRow {
  id: string
  materialName: string
  unit: string
  location: string
  supplierId: string | null
  openingQty: number
  receivedQty: number
  consumedQty: number
  transferredQty: number
  returnedQty: number
  damagedQty: number
  adjustedQty: number
  closingQty: number
  stockValue: number
  lowStock: boolean
  updatedAt: string
}

export interface StockMovementRow {
  id: string
  inventoryItemId: string
  materialName: string
  unit: string
  type: StockMovementType
  quantity: number
  unitCost: number | null
  reference: string | null
  note: string | null
  recordedBy: string
  createdAt: string
}

export interface InventorySlice {
  items: InventoryItemRow[]
  movements: StockMovementRow[]
}

export interface BoqLineRow {
  id: string
  materialName: string
  unit: string
  qty: number
  estUnitPrice: number
  category: string | null
  note: string | null
}

export interface BoqRow {
  id: string
  name: string
  version: number
  status: string
  lines: BoqLineRow[]
  total: number
  createdAt: string
}

export interface BoqSlice {
  boqs: BoqRow[]
}
