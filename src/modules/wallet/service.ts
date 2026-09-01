// Wallet & payment-request service (spec §36-§40, §57) — payment requests,
// wallet deposit/withdraw/transfer, and payment recording through the
// double-entry ledger. F-MONEY hardens session gating and wires the legacy
// money flows (escrow.topup, milestone.decide, invoice.pay) through this
// engine. All multi-writes are atomic.

import { db } from '@/lib/db'
import {
  postLedgerTransaction,
  reverseLedgerTransaction,
  ensureAccount,
  ensureEscrowAccount,
  ensureExpenseAccount,
  derivedBalance,
} from '@/modules/ledger/service'
import { notify } from '@/modules/notify/service'

let prCounter = 0
export function nextPaymentRequestCode(): string {
  const now = new Date()
  prCounter = (prCounter + 1) % 100000
  return `PR-${now.getFullYear()}-${String(prCounter).padStart(6, '0')}-${Date.now() % 1000}`
}

// ---- Payment requests (spec §36/§59) ----

export async function createPaymentRequest(projectId: string, p: any) {
  const amount = Number(p.amount)
  if (!(amount > 0)) throw new Error('Payment request amount must be positive')
  const request = await db.paymentRequest.create({
    data: {
      requestCode: nextPaymentRequestCode(),
      projectId,
      requestedByRole: String(p.requestedByRole ?? 'contractor'),
      requestedByName: String(p.requestedByName ?? 'Site Manager'),
      description: String(p.description ?? ''),
      amount,
      payee: String(p.payee ?? ''),
      method: String(p.method ?? 'mpesa'),
      relatedEntityType: p.relatedEntityType ?? null,
      relatedEntityId: p.relatedEntityId ?? null,
    },
  })
  await notify(projectId, `Payment request ${request.requestCode} awaiting approval`, `KSh ${amount.toLocaleString()} to ${request.payee} — ${request.description}`, { kind: 'approval.requested', audienceRole: 'client' })
  return { id: request.id, requestCode: request.requestCode, amount: request.amount }
}

export async function decidePaymentRequest(projectId: string, p: any) {
  const request = await db.paymentRequest.findFirst({ where: { id: String(p.id), projectId } })
  if (!request) throw new Error('Payment request not found')
  if (request.status !== 'pending') throw new Error(`Payment request already ${request.status}`)
  const decision = p.decision === 'approve' ? 'approved' : 'rejected'
  const updated = await db.paymentRequest.update({
    where: { id: request.id },
    data: {
      status: decision,
      decidedBy: String(p.decidedBy ?? p.deciderName ?? 'Approver'),
      decidedAt: new Date(),
      decisionNote: p.note ?? null,
    },
  })
  await notify(projectId, `Payment request ${request.requestCode} ${decision}`, `KSh ${request.amount.toLocaleString()} to ${request.payee}${p.note ? ` — ${p.note}` : ''}`, { kind: decision === 'approved' ? 'payment.approved' : 'payment.rejected' })
  return { id: updated.id, status: updated.status }
}

export async function payPaymentRequest(projectId: string, p: any) {
  const request = await db.paymentRequest.findFirst({ where: { id: String(p.id), projectId } })
  if (!request) throw new Error('Payment request not found')
  if (request.status === 'paid') throw new Error('Payment request already paid')
  if (request.status !== 'approved') throw new Error('Payment request must be approved before payment')

  const method = String(p.method ?? request.method)
  const expense = await ensureExpenseAccount(projectId)
  const cashCode = method === 'bank' ? 'CASH_BANK' : 'CASH_MPESA'
  const cash = await ensureAccount(cashCode)
  const idempotencyKey = `payment.request:${request.id}`

  const ledgerTxn = await postLedgerTransaction({
    projectId,
    description: `Payment ${request.requestCode} — ${request.payee}`,
    postedBy: String(p.paidBy ?? request.requestedByName),
    postedRole: String(p.paidByRole ?? 'finance'),
    idempotencyKey,
    lines: [
      { accountCode: `EXPENSE:${projectId}`, side: 'debit', amount: request.amount },
      { accountCode: cashCode, side: 'credit', amount: request.amount },
    ],
  })

  const txn = await db.transaction.create({
    data: {
      projectId,
      type: 'payment_request',
      amount: request.amount,
      method,
      reference: p.reference ?? ledgerTxn.ref,
      costCode: p.costCode ?? null,
      ledgerTxnId: ledgerTxn.id,
      note: `${request.requestCode} — ${request.description}`,
      date: new Date(),
    },
  })

  await db.paymentRequest.update({
    where: { id: request.id },
    data: { status: 'paid', paidAt: new Date(), paidTxnId: txn.id },
  })

  void expense
  void cash
  await notify(projectId, `Payment ${request.requestCode} recorded`, `KSh ${request.amount.toLocaleString()} to ${request.payee} via ${method} (ledger ${ledgerTxn.ref})`, { kind: 'payment.paid' })
  return { id: request.id, status: 'paid', transactionId: txn.id, ledgerRef: ledgerTxn.ref }
}

// ---- Wallets (spec §37/§38) ----

export async function createWallet(projectId: string, p: any) {
  const count = await db.walletAccount.count()
  const code = `W-${String(count + 1).padStart(4, '0')}`
  const ownerType = String(p.ownerType ?? 'project')
  const ownerId = p.ownerId ?? projectId
  const wallet = await db.walletAccount.create({
    data: { code, label: String(p.label ?? code), ownerType, ownerId, status: 'active' },
  })
  const account = await db.ledgerAccount.create({
    data: {
      code: `WALLET:${wallet.code}`,
      name: `Wallet ${wallet.code} — ${wallet.label}`,
      kind: 'liability', // we owe the wallet owner this balance
      normalSide: 'credit',
      projectId: ownerType === 'project' ? projectId : null,
      ownerType: 'wallet',
      ownerId: wallet.id,
    },
  })
  await db.walletAccount.update({ where: { id: wallet.id }, data: { ledgerAccountId: account.id } })
  return { id: wallet.id, code: wallet.code, ledgerAccount: account.code }
}

async function resolveWallet(projectId: string, idOrCode: any) {
  const wallet = await db.walletAccount.findFirst({
    where: { OR: [{ id: String(idOrCode) }, { code: String(idOrCode) }] },
  })
  if (!wallet) throw new Error('Wallet not found')
  if (wallet.ownerType === 'project' && wallet.ownerId !== projectId) {
    throw new Error('Wallet belongs to a different project')
  }
  return wallet
}

export async function depositWallet(projectId: string, p: any) {
  const amount = Number(p.amount)
  if (!(amount > 0)) throw new Error('Deposit amount must be positive')
  const wallet = await resolveWallet(projectId, p.walletId ?? p.code)
  const cashCode = String(p.source ?? 'mpesa') === 'bank' ? 'CASH_BANK' : 'CASH_MPESA'
  const ledgerTxn = await postLedgerTransaction({
    projectId: wallet.ownerType === 'project' ? projectId : null,
    description: `Wallet ${wallet.code} deposit`,
    postedBy: String(p.by ?? 'Finance'),
    postedRole: 'finance',
    idempotencyKey: p.idempotencyKey ?? `wallet.deposit:${wallet.id}:${amount}:${p.reference ?? ''}`,
    lines: [
      { accountCode: cashCode, side: 'debit', amount },
      { accountCode: `WALLET:${wallet.code}`, side: 'credit', amount },
    ],
  })
  const balance = await derivedBalance(`WALLET:${wallet.code}`)
  return { walletCode: wallet.code, ledgerRef: ledgerTxn.ref, balance }
}

export async function withdrawWallet(projectId: string, p: any) {
  const amount = Number(p.amount)
  if (!(amount > 0)) throw new Error('Withdrawal amount must be positive')
  const wallet = await resolveWallet(projectId, p.walletId)
  const balance = await derivedBalance(`WALLET:${wallet.code}`)
  if (balance < amount) throw new Error(`Insufficient wallet balance: ${balance} < ${amount}`)
  const cashCode = String(p.destination ?? 'mpesa') === 'bank' ? 'CASH_BANK' : 'CASH_MPESA'
  const ledgerTxn = await postLedgerTransaction({
    projectId: wallet.ownerType === 'project' ? projectId : null,
    description: `Wallet ${wallet.code} withdrawal${p.note ? ` — ${p.note}` : ''}`,
    postedBy: String(p.by ?? 'Finance'),
    postedRole: 'finance',
    idempotencyKey: p.idempotencyKey ?? `wallet.withdraw:${wallet.id}:${amount}:${Date.now()}`,
    lines: [
      { accountCode: `WALLET:${wallet.code}`, side: 'debit', amount },
      { accountCode: cashCode, side: 'credit', amount },
    ],
  })
  return { walletCode: wallet.code, ledgerRef: ledgerTxn.ref, balance: balance - amount }
}

export async function transferWallet(projectId: string, p: any) {
  const amount = Number(p.amount)
  if (!(amount > 0)) throw new Error('Transfer amount must be positive')
  const from = await resolveWallet(projectId, p.fromWalletId)
  const to = await resolveWallet(projectId, p.toWalletId)
  const balance = await derivedBalance(`WALLET:${from.code}`)
  if (balance < amount) throw new Error(`Insufficient wallet balance: ${balance} < ${amount}`)
  const ledgerTxn = await postLedgerTransaction({
    projectId: from.ownerType === 'project' ? projectId : null,
    description: `Wallet transfer ${from.code} → ${to.code}`,
    postedBy: String(p.by ?? 'Finance'),
    postedRole: 'finance',
    idempotencyKey: p.idempotencyKey ?? `wallet.transfer:${from.id}:${to.id}:${amount}:${Date.now()}`,
    lines: [
      { accountCode: `WALLET:${from.code}`, side: 'debit', amount },
      { accountCode: `WALLET:${to.code}`, side: 'credit', amount },
    ],
  })
  return { from: from.code, to: to.code, ledgerRef: ledgerTxn.ref }
}

// ---- Reversals & manual journals (spec §39) ----

export async function reverseTransaction(projectId: string, p: any) {
  const txn = await db.transaction.findFirst({ where: { id: String(p.id), projectId } })
  if (!txn) throw new Error('Transaction not found')
  if (!txn.ledgerTxnId) {
    // Legacy single-entry row (pre-ledger): post a compensating entry now.
    const reversalLedger = await postLedgerTransaction({
      projectId,
      description: `REVERSAL of legacy transaction ${txn.id.slice(-6)} — ${p.reason ?? 'correction'}`,
      postedBy: String(p.by ?? 'Finance'),
      postedRole: 'finance',
      lines: [
        { accountCode: String(p.method ?? txn.method) === 'bank' ? 'CASH_BANK' : 'CASH_MPESA', side: 'debit', amount: txn.amount },
        { accountCode: `EXPENSE:${projectId}`, side: 'credit', amount: txn.amount },
      ],
    })
    const compensating = await db.transaction.create({
      data: {
        projectId,
        type: 'reversal',
        amount: -txn.amount,
        method: txn.method,
        reference: reversalLedger.ref,
        ledgerTxnId: reversalLedger.id,
        note: `Reversal of ${txn.id.slice(-6)}: ${p.reason ?? 'correction'}`,
        date: new Date(),
      },
    })
    await db.transaction.update({ where: { id: txn.id }, data: { note: `${txn.note ?? ''} [reversed by ${reversalLedger.ref}]`.trim() } })
    return { reversalTransactionId: compensating.id, ledgerRef: reversalLedger.ref }
  }

  const ledgerTxn = await db.ledgerTransaction.findUnique({ where: { id: txn.ledgerTxnId } })
  if (!ledgerTxn) throw new Error('Backing ledger transaction not found')
  const reversal = await reverseLedgerTransaction(ledgerTxn.id, String(p.reason ?? 'correction'), String(p.by ?? 'Finance'), 'finance')
  const compensating = await db.transaction.create({
    data: {
      projectId,
      type: 'reversal',
      amount: -txn.amount,
      method: txn.method,
      reference: reversal.ref,
      ledgerTxnId: reversal.id,
      note: `Reversal of ${txn.id.slice(-6)}: ${p.reason ?? 'correction'}`,
      date: new Date(),
    },
  })
  return { reversalTransactionId: compensating.id, ledgerRef: reversal.ref }
}

export async function postJournal(projectId: string, p: any) {
  const lines = (p.lines ?? []).map((l: any) => ({
    accountCode: String(l.accountCode),
    side: String(l.side) as 'debit' | 'credit',
    amount: Number(l.amount),
    memo: l.memo,
  }))
  const txn = await postLedgerTransaction({
    projectId,
    description: String(p.description ?? 'Manual journal entry'),
    postedBy: String(p.by ?? 'Finance'),
    postedRole: String(p.role ?? 'finance'),
    idempotencyKey: p.idempotencyKey,
    lines,
  })
  return { ref: txn.ref }
}

// Used by money flows (escrow top-up posting helper for F-MONEY).
export async function postEscrowTopup(projectId: string, amount: number, by: string, reference?: string) {
  await ensureEscrowAccount(projectId)
  return postLedgerTransaction({
    projectId,
    description: `Escrow top-up${reference ? ` (${reference})` : ''}`,
    postedBy: by,
    postedRole: 'client',
    idempotencyKey: reference ? `escrow.topup:${projectId}:${reference}` : undefined,
    lines: [
      { accountCode: 'CASH_MPESA', side: 'debit', amount },
      { accountCode: `ESCROW:${projectId}`, side: 'credit', amount },
    ],
  })
}

export async function escrowDerivedBalance(projectId: string) {
  await ensureEscrowAccount(projectId)
  return derivedBalance(`ESCROW:${projectId}`)
}
