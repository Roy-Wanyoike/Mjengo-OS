// Invoices module — data access.
//
// loadInvoicesSlice(projectId) loads the project's invoices with lines and
// supplier/order links flattened into display fields, PLUS the A-1-lite
// ledger-consistency projection (three-way.ts computeLedgerConsistency) so
// the Finder invoices section can show the integrity chip without another
// round-trip. Read-only with respect to the wallet — the projection never
// mutates stored balances.

import { db } from '@/backend/lib/db'
import type { Prisma } from '@prisma/client'
import { centsToKes } from '@/backend/lib/money'
import { computeLedgerConsistency } from './three-way'
import type { InvoicesSlice, InvoiceWithLines } from './types'

/** Prisma row (bigint cents) → API DTO (KSh numbers) — the slice boundary. */
function toInvoiceWithLines(
  i: Prisma.InvoiceGetPayload<{ include: { lines: true; supplier: true; order: true } }>,
): InvoiceWithLines {
  return {
    id: i.id,
    invoiceCode: i.invoiceCode,
    projectId: i.projectId,
    orderId: i.orderId,
    supplierId: i.supplierId,
    status: i.status,
    createdBy: i.createdBy,
    subtotal: centsToKes(i.subtotal),
    tax: centsToKes(i.tax),
    total: centsToKes(i.total),
    dueDate: i.dueDate,
    issuedAt: i.issuedAt,
    submittedAt: i.submittedAt,
    decidedAt: i.decidedAt,
    decidedBy: i.decidedBy,
    paidAt: i.paidAt,
    paidByRole: i.paidByRole,
    paymentMethod: i.paymentMethod,
    paymentReference: i.paymentReference,
    note: i.note,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    lines: i.lines.map((l) => ({
      id: l.id,
      invoiceId: l.invoiceId,
      name: l.name,
      qty: l.qty,
      unitPrice: centsToKes(l.unitPrice),
      lineTotal: centsToKes(l.lineTotal),
    })),
    supplierName: i.supplier?.businessName ?? null,
    orderCode: i.order?.orderCode ?? null,
  }
}

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

  const rows: InvoiceWithLines[] = invoices.map(toInvoiceWithLines)

  const ledgerCheck = computeLedgerConsistency({
    walletBalance: centsToKes(wallet?.balance ?? 0n),
    transactions: transactions.map((t) => ({
      type: t.type,
      method: t.method,
      amount: centsToKes(t.amount),
      reference: t.reference,
    })),
    releasedMilestoneIds: milestones.filter((m) => m.status === 'released').map((m) => m.id),
    paidInvoiceReferences: rows
      .filter((i) => i.status === 'paid')
      .map((i) => i.paymentReference ?? ''),
  })

  return { invoices: rows, ledgerCheck }
}
