// Supply & procurement (MjengoOS Finder) module — types for the `supply` slice.
//
// Carries the full procurement network state for a project: suppliers with
// catalogs, material requests (+lines), project approval rules + decisions,
// quotes, purchase orders (+lines, +deliveries with per-line counts). The
// landed-cost engine and ranking live in the service layer (agent 2-c).

import type {
  Supplier, CatalogItem, MaterialRequest, MaterialRequestLine,
  ApprovalRule, Approval, Quote, PurchaseOrder, PurchaseOrderLine,
  OrderDelivery, OrderDeliveryLine,
} from '@prisma/client'

// ---- domain enums ----

export type RequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'converted'
export type QuoteStatus = 'requested' | 'received' | 'declined'
export type OrderStatus =
  | 'draft' | 'pending_approval' | 'approved' | 'sent' | 'confirmed'
  | 'delivering' | 'delivered' | 'closed' | 'cancelled'
export type PaymentSource = 'client' | 'contractor' | 'project_wallet' | 'finance'
export type DeliveryStatus = 'dispatched' | 'received' | 'discrepancy'
export type ApproverRole = 'supervisor' | 'contractor' | 'client' | 'finance'
export type ApprovalDecision = 'pending' | 'approved' | 'rejected'

// ---- slice shapes ----

export interface SupplierWithCatalog extends Supplier {
  catalogItems: CatalogItem[]
}

export interface RequestWithLines extends MaterialRequest {
  lines: MaterialRequestLine[]
  quotes: QuoteDetail[]
  orders: PurchaseOrder[]
}

export interface QuoteDetail extends Quote {
  supplierName: string
  requestCode: string
}

export interface DeliveryWithLines extends OrderDelivery {
  lines: OrderDeliveryLine[]
}

export interface OrderWithDetail extends PurchaseOrder {
  lines: PurchaseOrderLine[]
  supplierName: string
  requestCode: string | null
  deliveries: DeliveryWithLines[]
}

/** The `supply` slice of ProjectPayload — populated by repository.loadSupplySlice. */
export interface SupplySlice {
  suppliers: SupplierWithCatalog[]
  requests: RequestWithLines[]
  approvalRules: ApprovalRule[]
  approvals: Approval[]
  quotes: QuoteDetail[]
  orders: OrderWithDetail[]
}

export const EMPTY_SUPPLY_SLICE: SupplySlice = {
  suppliers: [],
  requests: [],
  approvalRules: [],
  approvals: [],
  quotes: [],
  orders: [],
}
