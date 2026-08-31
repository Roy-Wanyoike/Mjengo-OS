// Invoices module — types for the `invoices` slice.
//
// Carries the invoice lifecycle state for a project: every invoice with its
// lines + supplier/order links (names inlined for display), plus the A-1-lite
// ledger-consistency projection (roadmap §8). The 3-way match (PO vs invoice
// vs delivery) is computed by the shared pure functions in three-way.ts.

import type { Invoice, InvoiceLine, PurchaseOrder, Supplier } from '@prisma/client'

// ---- domain enums ----

export type InvoiceStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid' | 'disputed'
export type PaymentMethod = 'mpesa' | 'bank' | 'card' | 'wallet' | 'cash'
export type PaidByRole = 'client' | 'contractor' | 'finance'

// ---- 3-way match shapes (shared pure computation — service + UI) ----

/** One row of the per-line matrix: PO qty | invoice qty | delivered qty. */
export interface MatchLine {
  name: string
  /** Quantity on the purchase order (null = line not on the PO / fee line). */
  poQty: number | null
  invQty: number
  /** Physically received qty (null = no delivery record to compare against). */
  deliveredQty: number | null
  /** True when this line is a delivery/transport fee reconciled to the PO fee. */
  feeLine: boolean
}

/** An honest, human-reviewable discrepancy record — never an accusation. */
export interface MatchIssue {
  name: string
  po: number | null
  inv: number
  delivered: number | null
  issue: string
}

export interface ThreeWayReport {
  mode: 'three-way' | 'two-way'
  hasOrder: boolean
  hasDelivery: boolean
  lines: MatchLine[]
  mismatches: MatchIssue[]
  note: string
}

// ---- A-1-lite ledger consistency shapes ----

export interface LedgerBreakdown {
  /** Σ runtime escrow releases (Transaction type 'milestone' — money.ts). */
  releases: number
  /** Σ invoice payments paid FROM the escrow wallet (type 'invoice', method 'wallet'). */
  walletInvoicePayments: number
  /** Σ invoice payments on external rails (M-Pesa/bank/card/cash). */
  externalInvoicePayments: number
  /** Top-ups are NOT ledgered by money.ts escrow.topup — reported as null, honestly. */
  topups: number | null
  unreconciledCount: number
}

export interface LedgerCheck {
  consistent: boolean
  drift: number
  breakdown: LedgerBreakdown
  note: string
}

// ---- slice shapes ----

export interface InvoiceWithLines extends Invoice {
  lines: InvoiceLine[]
  supplierName: string | null
  orderCode: string | null
}

/** The `invoices` slice of ProjectPayload — populated by repository.loadInvoicesSlice. */
export interface InvoicesSlice {
  invoices: InvoiceWithLines[]
  /** A-1-lite projection: does the Transaction ledger reconcile with the wallet/entities? */
  ledgerCheck: LedgerCheck
}

export const EMPTY_INVOICES_SLICE: InvoicesSlice = {
  invoices: [],
  ledgerCheck: {
    consistent: true,
    drift: 0,
    breakdown: {
      releases: 0,
      walletInvoicePayments: 0,
      externalInvoicePayments: 0,
      topups: null,
      unreconciledCount: 0,
    },
    note: 'No transactions on file yet.',
  },
}

// Re-exported for convenience in the service/repository layers (agent 2-d).
export type { PurchaseOrder, Supplier }
