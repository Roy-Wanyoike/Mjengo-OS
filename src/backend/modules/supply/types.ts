// Supply & procurement (MjengoOS Finder) module — types for the `supply` slice.
//
// Carries the full procurement network state for a project: suppliers with
// catalogs, material requests (+lines), project approval rules + decisions,
// quotes, purchase orders (+lines, +deliveries with per-line counts). The
// landed-cost engine and ranking live in compare.ts (pure, shared with the
// client); dashboard math lives in insights.ts (pure as well).
//
// PURE, PRISMA-FREE shapes (CompareRow, …) are defined here so the client
// sections and the server service share ONE contract — the same pattern as
// modules/invoices/three-way.ts.

import type {
  Supplier, CatalogItem, MaterialRequest, MaterialRequestLine,
  ApprovalRule, Approval, Quote, QuoteLine, PurchaseOrder, PurchaseOrderLine,
  OrderDelivery, OrderDeliveryLine, DeliveryPhoto, Attachment,
} from '@prisma/client'

export type { ApprovalRule, Approval, Quote, QuoteLine, PurchaseOrder, PurchaseOrderLine, OrderDelivery, OrderDeliveryLine, DeliveryPhoto, Attachment } from '@prisma/client'

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
  /** Per-line bid detail (spec §32) — present when the quote was received multi-line. */
  lines?: QuoteLine[]
}

/**
 * One linked evidence photo on a delivery (see the DeliveryPhoto model):
 * `attachment.storageKey` is the URL the UI replays (same /api/upload storage
 * site photos and documents use). `deliveryLineId` scopes the photo to one
 * inspected line's count — the DISCREPANCY evidence; null = whole-delivery.
 */
export interface DeliveryPhotoWithAttachment extends DeliveryPhoto {
  attachment: Attachment
}

export interface DeliveryWithLines extends OrderDelivery {
  lines: OrderDeliveryLine[]
  photos: DeliveryPhotoWithAttachment[]
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
  /** SavedSupplier ids for THIS project (spec §30 "save supplier") — directory sorts them first. */
  savedSupplierIds: string[]
}

export const EMPTY_SUPPLY_SLICE: SupplySlice = {
  suppliers: [],
  requests: [],
  approvalRules: [],
  approvals: [],
  quotes: [],
  orders: [],
  savedSupplierIds: [],
}

// ---- PURE landed-cost engine contract (compare.ts — shared client/server) ----

/** Requested delivery speed (Finder spec §6 — "delivery day"). */
export type DeliveryDay = 'any' | 'same_day' | 'next_day' | 'two_days'

export interface CompareInput {
  materialName: string
  qty: number
  radiusKm?: number | null
  deliveryDay?: DeliveryDay | null
}

/** A supplier + its best-matching catalog item, flattened for the pure engine. */
export interface CompareCandidate {
  supplierId: string
  businessName: string
  county: string
  town?: string | null
  lat?: number | null
  lng?: number | null
  deliveryFeeBase: number
  freeDeliveryOver?: number | null
  minimumOrder: number
  reliabilityScore: number // 0-100
  responseHours: number
  item: {
    id: string
    name: string
    unit: string
    unitPrice: number
    stockQty: number
    minOrderQty: number
    /** Catalog listing metadata (spec §29 Product/Brand/Specification) — display-only. */
    category?: string | null
    brand?: string | null
    specification?: string | null
  }
}

export type StockState = 'full' | 'partial' | 'none'
export type EtaTier = 'same day' | 'next day' | '2+ days'

export interface ScoreParts {
  price: number
  distance: number
  stock: number
  speed: number
  reliability: number
  total: number
}

/** One ranked result row — everything the UI table + breakdown needs. */
export interface CompareRow {
  supplierId: string
  businessName: string
  county: string
  town: string | null
  itemName: string
  unit: string
  /** Catalog listing metadata (spec §29) — shown in search rows when present. */
  category: string | null
  brand: string | null
  specification: string | null
  unitPrice: number
  qty: number
  productCost: number
  deliveryFee: number
  transportFee: number
  totalLanded: number
  distanceKm: number | null
  stockQty: number
  stockState: StockState
  minOrderQty: number
  minimumOrder: number
  meetsMinOrder: boolean
  etaTier: EtaTier
  reliabilityScore: number
  scores: ScoreParts
  flags: { bestOverall: boolean; cheapestUnit: boolean }
}

export interface CompareSite {
  lat: number
  lng: number
  label: string
}

export interface CompareResult {
  site: CompareSite
  rows: CompareRow[]
}

/** The exact weighted-score formula (documented once, used everywhere):
 *  price 0.45 (best-landed/landed, normalized against the BEST total)
 *  distance 0.15 (best-km/km)
 *  stock 0.15 (full=1 · partial=0.5 · none=0)
 *  delivery speed 0.10 (same-day=1 · next-day=0.6 · 2+=0.3)
 *  reliability 0.15 (supplier reliabilityScore/100)
 */
export const COMPARE_WEIGHTS = { price: 0.45, distance: 0.15, stock: 0.15, speed: 0.1, reliability: 0.15 } as const

// ---- PURE approval-band contract (policy.ts / insights.ts — shared) ----

export interface RuleLike {
  id?: string
  minAmount: number
  maxAmount: number | null
  approverRole: string
  priority: number
  active: boolean
}

// ---- PURE estimation + BOQ-lite contract (insights.ts — shared) ----

export interface EstimateBasis {
  total: number
  source: 'quotes' | 'catalog'
  unpricedLines: string[] // material names with no catalog/quote price found
}

export interface BoqMaterialRow {
  materialKey: string
  displayNames: string[]
  unit: string
  required: number
  purchased: number
  remaining: number
}

export interface ProcurementTotals {
  required: number
  purchased: number
  committed: number
  remaining: number
  pendingRequests: number
  pendingApprovals: number
  ordersInTransit: number
  discrepancies: number
}
