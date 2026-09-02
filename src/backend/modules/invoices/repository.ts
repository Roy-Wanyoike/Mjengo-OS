// Invoices module — data access.
//
// loadInvoicesSlice(projectId) loads the project's invoices with lines and
// supplier/order links flattened into display fields, PLUS the A-1-lite
// ledger-consistency projection (three-way.ts computeLedgerConsistency) so
// the Finder invoices section can show the integrity chip without another
// round-trip. Read-only with respect to the wallet — the projection never
// mutates stored balances.

import { db } from '@/backend/lib/db'
import { computeLedgerConsistency } from './three-way'
import type { InvoicesSlice, InvoiceWithLines } from './types'

export async function loadInvoicesSlice(projectId: string): Promise<InvoicesSlice> {
  const [invoices, transactions, wallet, milestones] = await Promise.all([
    db.invoice.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { lines: true, supplier: true, order: true },
    }),
    db.transaction.findMany({ where: { projectId }, orderBy: { date: 'desc' } }),
    db.escrowWallet.findUnique({ where: { projectId } }),
    db.milestone.findMany({ where: { projectId }, select: { id: true, status: true } }),
  ])

  const rows: InvoiceWithLines[] = invoices.map((i) => ({
    ...i,
    supplierName: i.supplier?.businessName ?? null,
    orderCode: i.order?.orderCode ?? null,
  }))

  const ledgerCheck = computeLedgerConsistency({
    walletBalance: wallet?.balance ?? 0,
    transactions: transactions.map((t) => ({
      type: t.type,
      method: t.method,
      amount: t.amount,
      reference: t.reference,
    })),
    releasedMilestoneIds: milestones.filter((m) => m.status === 'released').map((m) => m.id),
    paidInvoiceReferences: rows
      .filter((i) => i.status === 'paid')
      .map((i) => i.paymentReference ?? ''),
  })

  return { invoices: rows, ledgerCheck }
}
