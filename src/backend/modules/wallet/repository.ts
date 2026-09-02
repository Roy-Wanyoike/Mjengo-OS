// Finance slice loader for the project payload (spec §36-§40).
// F-MONEY full slice: ledger transactions, accounts with derived balances,
// escrow projection vs ledger consistency, payment requests with their ledger
// refs, and the budget → committed → spent → remaining rollup.

import { db } from '@/backend/lib/db'
import type { FinanceSlice, LedgerTxnRow, LedgerAccountRow } from './types'

export async function loadFinanceSlice(projectId: string): Promise<FinanceSlice> {
  const [project, paymentRequests, txns, accounts, phases, transactions] = await Promise.all([
    db.project.findUnique({ where: { id: projectId } }),
    db.paymentRequest.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    db.ledgerTransaction.findMany({
      where: { projectId },
      include: { entries: { include: { account: true } } },
      orderBy: { occurredAt: 'desc' },
      take: 60,
    }),
    db.ledgerAccount.findMany({ where: { projectId }, include: { entries: true } }),
    db.phase.findMany({ where: { projectId }, select: { budget: true } }),
    db.transaction.findMany({ where: { projectId } }),
  ])

  // Budget rollup: phase budgets are the source of truth (matches
  // ProjectSummary.budgetTotal); project.budget is the fallback.
  const budget = phases.length ? phases.reduce((s, p) => s + p.budget, 0) : project?.budget ?? 0
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

  // Ledger refs for paid payment requests (paidTxnId → Transaction.ledgerTxnId → ref)
  const ledgerRefByTxnId = new Map(txns.map((t) => [t.id, t.ref]))
  const prLedgerRef = new Map<string, string | null>()
  for (const pr of paymentRequests) {
    if (!pr.paidTxnId) continue
    const legacy = transactions.find((t) => t.id === pr.paidTxnId)
    const ref = legacy?.ledgerTxnId ? ledgerRefByTxnId.get(legacy.ledgerTxnId) ?? null : null
    prLedgerRef.set(pr.id, ref ?? legacy?.reference ?? null)
  }

  const accountRows: LedgerAccountRow[] = accounts.map((a) => {
    const debit = a.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0)
    const credit = a.entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0)
    const balance = a.kind === 'asset' || a.kind === 'expense' ? debit - credit : credit - debit
    return { code: a.code, name: a.name, kind: a.kind, normalSide: a.normalSide, balance }
  })

  // Escrow projection vs derived ledger balance (spec §39 — the ledger wins).
  const escrow = await db.escrowWallet.findUnique({ where: { projectId } })
  const derivedEscrow = accountRows.find((a) => a.code === `ESCROW:${projectId}`)?.balance ?? 0
  const escrowSlice = escrow
    ? {
        projected: escrow.balance,
        derived: derivedEscrow,
        consistent: Math.abs(derivedEscrow - escrow.balance) < 1,
        drift: Math.round((derivedEscrow - escrow.balance) * 100) / 100,
        ledgerAccountId: escrow.ledgerAccountId,
      }
    : null

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
      ledgerRef: prLedgerRef.get(p.id) ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
    ledger: { transactions: txnRows, accounts: accountRows },
    wallet: null,
    escrowLedgered: txns.some((t) => t.description.startsWith('Escrow top-up')),
    escrow: escrowSlice,
    committed,
    remaining: budget - committed - spent,
    budget,
    spent,
  }
}
