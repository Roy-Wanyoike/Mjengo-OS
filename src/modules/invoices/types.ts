// Invoices module — types for the `invoices` slice.
//
// Carries the invoice lifecycle state for a project: every invoice with its
// lines + supplier/order links (names inlined for display). The 3-way match
// (PO vs invoice vs delivery) is computed by the service layer (agent 2-d).

import type { Invoice, InvoiceLine, PurchaseOrder, Supplier } from '@prisma/client'

// ---- domain enums ----

export type InvoiceStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid' | 'disputed'
export type PaymentMethod = 'mpesa' | 'bank' | 'card' | 'wallet' | 'cash'
export type PaidByRole = 'client' | 'contractor' | 'finance'

// ---- slice shapes ----

export interface InvoiceWithLines extends Invoice {
  lines: InvoiceLine[]
  supplierName: string | null
  orderCode: string | null
}

/** The `invoices` slice of ProjectPayload — populated by repository.loadInvoicesSlice. */
export interface InvoicesSlice {
  invoices: InvoiceWithLines[]
}

export const EMPTY_INVOICES_SLICE: InvoicesSlice = { invoices: [] }

// Re-exported for convenience in the service/repository layers (agent 2-d).
export type { PurchaseOrder, Supplier }
