// Finance slice loader for the project payload (spec §36-§40).
// F-MONEY implements the full slice — ledger transactions, accounts with
// derived balances, wallet projection, payment requests, committed/remaining.
// This baseline loads what the schema already guarantees.

import { db } from '@/lib/db'
import type { FinanceSlice, LedgerTxnRow, LedgerAccountRow } from './types'

export async function loadFinanceSlice(projectId: string): Promise<FinanceSlice> {
  const [project, paymentRequests, txns, accounts] = await Promise.all([
    db.project.findUnique({ where: { id: projectId }, include: { phases: true } }),
    db.paymentRequest.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    db.ledgerTransaction.findMany({
      where: { projectId },
      include: { entries: { include: { account: true } } },
      orderBy: { occurredAt: 'desc' },
      take: 60,
    }),
    db.ledgerAccount.findMany({ where: { projectId }, include: { entries: true } }),
  ])

  const budget = project?.budget ?? 0
  const transactions = project ? await db.transaction.findMany({ where: { projectId } }) : []
  const spent = transactions.reduce((s, t) => s + t.amount, 0)

  const openPos = project ? await db.purchaseOrder.findMany({ where: { projectId } }) : []
  const openInvoices = project
    ? await db.invoice.findMany({ where: { projectId, status: 'approved' } })
    : []
  const pendingVariations = project
    ? await db.variationOrder.findMany({ where: { projectId, status: 'submitted' } })
    : []
  const committed =
    openPos.filter((p) => !['closed', 'cancelled'].includes(p.status)).reduce((s, p) => s + p.total, 0) +
    openInvoices.reduce((s, i) => s + i.total, 0) +
    pendingVariations.filter((v) => v.budgetImpact > 0).reduce((s, v) => s + v.budgetImpact, 0)

  const txnRows: LedgerTxnRow[] = txns.map((t) => ({
    id: t.id,
    ref: t.ref,
    description: t.description,
    occurredAt: t.occurredAt.toISOString(),
    status: t.status,
    reversalOfRef: t.reversalRef,
    postedBy: t.postedBy,
    postedRole: t.postedRole,
    entries: t.entries.map((e) => ({
      accountCode: e.account.code,
      accountName: e.account.name,
      side: e.side,
      amount: e.amount,
    })),
    total: t.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0),
  }))

  const accountRows: LedgerAccountRow[] = accounts.map((a) => {
    const debit = a.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0)
    const credit = a.entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0)
    const balance = a.kind === 'asset' || a.kind === 'expense' ? debit - credit : credit - debit
    return { code: a.code, name: a.name, kind: a.kind, normalSide: a.normalSide, balance }
  })

  return {
    paymentRequests: paymentRequests.map((p) => ({
      id: p.id,
      requestCode: p.requestCode,
      description: p.description,
      amount: p.amount,
      payee: p.payee,
      method: p.method,
      status: p.status,
      relatedEntityType: p.relatedEntityType,
      relatedEntityId: p.relatedEntityId,
      requestedByRole: p.requestedByRole,
      requestedByName: p.requestedByName,
      decidedBy: p.decidedBy,
      decidedAt: p.decidedAt?.toISOString() ?? null,
      decisionNote: p.decisionNote,
      paidAt: p.paidAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
    ledger: { transactions: txnRows, accounts: accountRows },
    wallet: null,
    escrowLedgered: txns.length > 0,
    committed,
    remaining: budget - committed - spent,
  }
}
