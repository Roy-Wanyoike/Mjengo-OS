// Wallet / finance domain types (spec §36-§40) — the FinanceSlice payload:
// payment requests, double-entry ledger view, wallet projection, and the
// budget → committed → spent → remaining rollup.

export interface PaymentRequestRow {
  id: string
  requestCode: string
  description: string
  amount: number
  payee: string
  method: string
  status: string
  relatedEntityType: string | null
  relatedEntityId: string | null
  requestedByRole: string
  requestedByName: string
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  paidAt: string | null
  createdAt: string
}

export interface LedgerEntryRow {
  accountCode: string
  accountName: string
  side: string // debit, credit
  amount: number
}

export interface LedgerTxnRow {
  id: string
  ref: string
  description: string
  occurredAt: string
  status: string // posted, reversed
  reversalOfRef: string | null
  postedBy: string
  postedRole: string
  entries: LedgerEntryRow[]
  total: number
}

export interface LedgerAccountRow {
  code: string
  name: string
  kind: string // asset, liability, revenue, expense, equity
  normalSide: string
  balance: number
}

export interface WalletRow {
  code: string
  label: string
  ownerType: string
  balance: number // derived from ledger entries
  status: string
}

export interface FinanceSlice {
  paymentRequests: PaymentRequestRow[]
  ledger: {
    transactions: LedgerTxnRow[]
    accounts: LedgerAccountRow[]
  }
  wallet: WalletRow | null
  escrowLedgered: boolean // true when top-ups post ledger rows (A-1 complete)
  committed: number // open POs + approved-unpaid invoices + pending variations
  remaining: number // budget − committed − spent
}
