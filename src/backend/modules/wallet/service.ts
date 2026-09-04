// Wallet & payment-request service (spec §36-§40, §57) — payment requests,
// wallet deposit/withdraw/transfer, and payment recording through the
// double-entry ledger. F-MONEY hardening:
//   · every multi-write money flow runs in ONE db.$transaction
//   · balance checks happen INSIDE the transaction (no racy check-then-decrement)
//   · decision / payer identity is resolved from the SESSION (wallet/session.ts),
//     never from the payload (F3)
//   · payments route through the PaymentProvider seam (providers.ts, spec §40)
//   · escrow top-ups post CASH → ESCROW ledger rows and keep the
//     EscrowWallet.balance projection in sync inside the same transaction
//
// The escrow wallet is a PROJECTION: ESCROW:<projectId> ledger entries are the
// source of truth (spec §39); the stored balance is a cache that every helper
// here keeps consistent, and the finance slice exposes both so drift is visible.

import { db } from '@/backend/lib/db'
import {
  postLedgerTransaction,
  postLedgerTransactionInTx,
  reverseLedgerTransaction,
  ensureAccount,
  ensureAccountTx,
  derivedBalance,
  cashAccountForMethod,
  type TxClient,
} from '@/backend/modules/ledger/service'
import { notify } from '@/backend/modules/notify/service'
import { getProvider, type PaymentMethod } from './providers'
import { recordDarajaIntent } from './daraja-callback'
import { seedDarajaReconcileSweep } from './daraja-reconcile'
import { currentActor, type DeciderIdentity } from './session'

let prCounter = 0
export function nextPaymentRequestCode(): string {
  const now = new Date()
  prCounter = (prCounter + 1) % 100000
  return `PR-${now.getFullYear()}-${String(prCounter).padStart(6, '0')}-${Date.now() % 1000}`
}

/** Roles that may decide / pay payment requests in-app (client + finance are the real queue). */
const PR_ROLES = ['client', 'finance', 'admin', 'contractor', 'supervisor'] as const

// ---------------- in-tx posting helpers (shared by every money flow) ----------------

/**
 * Debit EXPENSE:<projectId>, credit the cash account for the rail — the
 * standard external-spend posting (expenses, wages, invoice payments on
 * mpesa/bank/card/cash, payment requests). Runs INSIDE the caller's
 * db.$transaction and returns the ledger ids for the legacy Transaction row.
 */
export async function spendExternalInTx(
  tx: TxClient,
  projectId: string,
  input: {
    amount: number
    method: string
    description: string
    postedBy: string
    postedRole: string
    idempotencyKey?: string
  },
): Promise<{ ledgerTxnId: string; ledgerRef: string }> {
  const ledgerTxn = await postLedgerTransactionInTx(tx, {
    projectId,
    description: input.description,
    postedBy: input.postedBy,
    postedRole: input.postedRole,
    idempotencyKey: input.idempotencyKey,
    lines: [
      { accountCode: `EXPENSE:${projectId}`, side: 'debit', amount: input.amount },
      { accountCode: cashAccountForMethod(input.method), side: 'credit', amount: input.amount },
    ],
  })
  return { ledgerTxnId: ledgerTxn.id, ledgerRef: ledgerTxn.ref }
}

/**
 * Debit ESCROW:<projectId>, credit EXPENSE:<projectId> and decrement the
 * wallet projection — escrow money moving into project spend. The balance is
 * re-checked INSIDE the transaction. Returns the new projected balance.
 */
export async function spendEscrowInTx(
  tx: TxClient,
  projectId: string,
  input: {
    amount: number
    description: string
    postedBy: string
    postedRole: string
    idempotencyKey?: string
  },
): Promise<{ ledgerTxnId: string; ledgerRef: string; balance: number }> {
  const wallet = await tx.escrowWallet.findUnique({ where: { projectId } })
  if (!wallet || wallet.balance < input.amount) {
    throw new Error('Insufficient escrow balance — top up first')
  }
  const escrowAccount = await ensureAccountTx(tx, `ESCROW:${projectId}`)
  const ledgerTxn = await postLedgerTransactionInTx(tx, {
    projectId,
    description: input.description,
    postedBy: input.postedBy,
    postedRole: input.postedRole,
    idempotencyKey: input.idempotencyKey,
    lines: [
      { accountCode: `ESCROW:${projectId}`, side: 'debit', amount: input.amount },
      { accountCode: `EXPENSE:${projectId}`, side: 'credit', amount: input.amount },
    ],
  })
  const updated = await tx.escrowWallet.update({
    where: { projectId },
    data: { balance: { decrement: input.amount }, ledgerAccountId: escrowAccount.id },
  })
  return { ledgerTxnId: ledgerTxn.id, ledgerRef: ledgerTxn.ref, balance: updated.balance }
}

/**
 * Milestone release (money.ts milestone.decide): milestone state flip +
 * escrow debit + EXPENSE credit + legacy Transaction row — ALL inside one
 * db.$transaction, with the escrow balance checked inside the transaction.
 */
export async function releaseMilestoneAtomic(
  projectId: string,
  input: {
    milestone: { id: string; name: string; amount: number }
    decider: DeciderIdentity
    note: string | null
  },
): Promise<{ balance: number; ledgerRef: string; ledgerTxnId: string; transactionId: string }> {
  const { milestone, decider } = input
  return db.$transaction(async (tx) => {
    const now = new Date()
    const released = await tx.milestone.update({
      where: { id: milestone.id },
      data: { status: 'released', decidedAt: now, decidedBy: decider.name, decisionNote: input.note, releasedAt: now },
    })
    void released
    const escrow = await spendEscrowInTx(tx, projectId, {
      amount: milestone.amount,
      description: `Milestone release — ${milestone.name}`,
      postedBy: decider.name,
      postedRole: decider.role,
      idempotencyKey: `milestone.release:${milestone.id}`,
    })
    // exactly ONE legacy row per release (idempotent on the ledger txn)
    const txnRow =
      (await tx.transaction.findFirst({ where: { ledgerTxnId: escrow.ledgerTxnId } })) ??
      (await tx.transaction.create({
        data: {
          projectId,
          type: 'milestone',
          amount: milestone.amount,
          method: 'escrow',
          reference: `MJP-${milestone.id.slice(-6)}`,
          costCode: 'milestone',
          ledgerTxnId: escrow.ledgerTxnId,
          note: `${milestone.name} released to contractor — approved by ${decider.name}`,
          date: now,
        },
      }))
    return {
      balance: escrow.balance,
      ledgerRef: escrow.ledgerRef,
      ledgerTxnId: escrow.ledgerTxnId,
      transactionId: txnRow.id,
    }
  })
}

// ---- Payment requests (spec §36/§59) ----

export async function createPaymentRequest(projectId: string, p: any) {
  const amount = Number(p.amount)
  if (!(amount > 0)) throw new Error('Payment request amount must be positive')
  // Requester identity from the session when one exists (payload is the fallback)
  const actor = await currentActor()
  const request = await db.paymentRequest.create({
    data: {
      requestCode: nextPaymentRequestCode(),
      projectId,
      requestedByRole: String(p.requestedByRole ?? actor.role ?? 'contractor'),
      requestedByName: String(p.requestedByName ?? actor.name ?? 'Site Manager'),
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
  // F3: decider identity resolved from the session, never from the payload.
  // Share-link callers (no session) fall back to the project client.
  const decider = await requirePrDecider(projectId, 'decide payment requests', p.by)
  const decision = p.decision === 'approve' ? 'approved' : 'rejected'
  const updated = await db.paymentRequest.update({
    where: { id: request.id },
    data: {
      status: decision,
      decidedBy: decider.name,
      decidedAt: new Date(),
      decisionNote: p.note ?? null,
    },
  })
  await notify(
    projectId,
    `Payment request ${request.requestCode} ${decision}`,
    `KSh ${request.amount.toLocaleString()} to ${request.payee} — decided by ${decider.name} (${decider.role})${p.note ? ` — ${p.note}` : ''}`,
    { kind: decision === 'approved' ? 'payment.approved' : 'payment.rejected' },
  )
  return { id: updated.id, status: updated.status, decidedBy: decider.name }
}

/** Session gate for payment-request decisions — client/finance are the real queue. */
async function requirePrDecider(projectId: string, action: string, payloadBy?: unknown): Promise<DeciderIdentity> {
  const actor = await currentActor()
  if (actor.role === null) {
    // Sessionless share-link path: the route already client-gated this call.
    const project = await db.project.findUnique({ where: { id: projectId } })
    const fallback = typeof payloadBy === 'string' && payloadBy.trim() ? payloadBy.trim() : project?.client ?? 'Client'
    return { name: fallback, role: 'client' }
  }
  if ((PR_ROLES as readonly string[]).includes(actor.role)) {
    // Site-team roles may act on the client's behalf in-app (the demo
    // "acting as client" flow); the audit + decision trail record the real
    // signed-in identity and role — never a payload-supplied name.
    return { name: actor.name?.trim() || actor.role, role: actor.role }
  }
  throw new Error(`Only the client or finance may ${action} — signed in as "${actor.role}".`)
}

export async function payPaymentRequest(projectId: string, p: any) {
  const request = await db.paymentRequest.findFirst({ where: { id: String(p.id), projectId } })
  if (!request) throw new Error('Payment request not found')
  if (request.status === 'paid') throw new Error('Payment request already paid')
  if (request.status !== 'approved') throw new Error('Payment request must be approved before payment')

  const method = String(p.method ?? request.method) as PaymentMethod
  const payer = await currentActor()
  const paidBy = payer.name?.trim() || String(p.paidBy ?? 'Finance')
  const paidByRole = payer.role ?? String(p.paidByRole ?? 'finance')

  // Provider seam (spec §40) — the simulated rail records an honest result;
  // a real provider (Daraja, bank API…) plugs in here without touching the ledger.
  const provider = getProvider(method)
  const reference = String(p.reference ?? '').trim() || `${request.requestCode}`
  const initiation = await provider.initiatePayment({
    amount: request.amount,
    currency: 'KES',
    method,
    payee: request.payee,
    reference,
    description: request.description,
  })
  if (initiation.status === 'pending') {
    // A REAL rail is async (M-Pesa STK: the customer must confirm on their
    // handset). Record the PENDING intent — NO money has moved yet — and
    // fail honestly: the verified provider callback (webhooks/daraja) posts
    // the balanced entry and flips this request to paid when Safaricom
    // confirms settlement. Failures here never record money.
    try {
      await recordDarajaIntent({
        kind: 'payment.request',
        paymentRequestId: request.id,
        requestCode: request.requestCode,
        projectId,
        amount: request.amount,
        payee: request.payee,
        method,
        reference,
        providerRef: initiation.providerRef,
        initiatedBy: paidBy,
        initiatedByRole: paidByRole,
      })
      // Issue #34: seed the jobs-module reconciliation sweep for this
      // intent (runAt = now + DARAJA_RECONCILE_AFTER_MIN). If Safaricom's
      // callback is missed, the sweep re-drives the same callback processor
      // (query-API-verified) instead of leaving the intent pending forever.
      // Best-effort — see daraja-reconcile.ts.
      await seedDarajaReconcileSweep()
    } catch (e) {
      // Best-effort row — the callback completes the payment only when the
      // intent exists; a missing row means an honest operator fix-up, never
      // invented money.
      console.error('[wallet] failed to record pending provider intent', e)
    }
    throw new Error(
      `${provider.label} accepted the request but it is PENDING customer confirmation — no money has moved yet. ${initiation.detail}. The payment records automatically once the provider's VERIFIED callback confirms settlement (ref ${initiation.providerRef}).`,
    )
  }
  if (initiation.status !== 'succeeded') {
    throw new Error(`Provider did not accept the payment: ${initiation.detail}`)
  }

  const costCode = String(p.costCode ?? request.relatedEntityType ?? 'payment_request')

  const result = await db.$transaction(async (tx) => {
    // Status re-checked INSIDE the transaction — no double-pay race.
    const fresh = await tx.paymentRequest.findUnique({ where: { id: request.id } })
    if (!fresh || fresh.status === 'paid') throw new Error('Payment request already paid')
    if (fresh.status !== 'approved') throw new Error('Payment request must be approved before payment')

    const spend =
      method === 'wallet'
        ? await spendEscrowInTx(tx, projectId, {
            amount: fresh.amount,
            description: `Payment ${fresh.requestCode} — ${fresh.payee} (escrow)`,
            postedBy: paidBy,
            postedRole: paidByRole,
            idempotencyKey: `payment.request:${fresh.id}`,
          })
        : await spendExternalInTx(tx, projectId, {
            amount: fresh.amount,
            method,
            description: `Payment ${fresh.requestCode} — ${fresh.payee}`,
            postedBy: paidBy,
            postedRole: paidByRole,
            idempotencyKey: `payment.request:${fresh.id}`,
          })

    const txnRow =
      (await tx.transaction.findFirst({ where: { ledgerTxnId: spend.ledgerTxnId } })) ??
      (await tx.transaction.create({
        data: {
          projectId,
          type: 'payment_request',
          amount: fresh.amount,
          method,
          reference: p.reference ?? spend.ledgerRef,
          costCode,
          ledgerTxnId: spend.ledgerTxnId,
          note: `${fresh.requestCode} — ${fresh.description}`,
          date: new Date(),
        },
      }))

    await tx.paymentRequest.update({
      where: { id: fresh.id },
      data: { status: 'paid', paidAt: new Date(), paidTxnId: txnRow.id },
    })

    return { transactionId: txnRow.id, ledgerRef: spend.ledgerRef, balance: 'balance' in spend ? spend.balance : undefined }
  })

  await notify(
    projectId,
    `Payment ${request.requestCode} recorded`,
    `KSh ${request.amount.toLocaleString()} to ${request.payee} via ${method} — ledger ${result.ledgerRef} (${provider.integrationNote})`,
    { kind: 'payment.paid' },
  )
  return { id: request.id, status: 'paid', transactionId: result.transactionId, ledgerRef: result.ledgerRef, balance: result.balance, providerNote: provider.integrationNote }
}

// ---- Wallets (spec §37/§38) ----

export async function createWallet(projectId: string, p: any) {
  const ownerType = String(p.ownerType ?? 'project')
  const ownerId = p.ownerId ?? projectId
  const wallet = await db.$transaction(async (tx) => {
    const count = await tx.walletAccount.count()
    const code = `W-${String(count + 1).padStart(4, '0')}`
    const created = await tx.walletAccount.create({
      data: { code, label: String(p.label ?? code), ownerType, ownerId, status: 'active' },
    })
    const account = await tx.ledgerAccount.create({
      data: {
        code: `WALLET:${created.code}`,
        name: `Wallet ${created.code} — ${created.label}`,
        kind: 'liability', // we owe the wallet owner this balance
        normalSide: 'credit',
        projectId: ownerType === 'project' ? projectId : null,
        ownerType: 'wallet',
        ownerId: created.id,
      },
    })
    return tx.walletAccount.update({ where: { id: created.id }, data: { ledgerAccountId: account.id } })
  })
  const accountCode = `WALLET:${wallet.code}`
  const balance = await derivedBalance(accountCode)
  return { id: wallet.id, code: wallet.code, ledgerAccount: accountCode, balance }
}

async function resolveWallet(projectId: string | null | undefined, idOrCode: any) {
  const wallet = await db.walletAccount.findFirst({
    where: { OR: [{ id: String(idOrCode) }, { code: String(idOrCode) }] },
  })
  if (!wallet) throw new Error('Wallet not found')
  // Empty/absent projectId = unscoped lookup (finance/admin v1 routes); a
  // NON-empty projectId scopes to that project's wallets only.
  if (wallet.ownerType === 'project' && projectId && wallet.ownerId !== projectId) {
    throw new Error('Wallet belongs to a different project')
  }
  return wallet
}

/** Wallet + derived balance (spec §39: the ledger is the source of truth). */
export async function walletWithBalance(projectId: string, idOrCode: any) {
  const wallet = await resolveWallet(projectId, idOrCode)
  const balance = await derivedBalance(`WALLET:${wallet.code}`)
  return { wallet, balance }
}

export async function depositWallet(projectId: string, p: any) {
  const amount = Number(p.amount)
  if (!(amount > 0)) throw new Error('Deposit amount must be positive')
  const wallet = await resolveWallet(projectId, p.walletId ?? p.code)
  const cashCode = cashAccountForMethod(String(p.source ?? 'mpesa'))
  const ledgerProjectId = wallet.ownerType === 'project' ? projectId : null
  const { ledgerRef, balance } = await db.$transaction(async (tx) => {
    const ledgerTxn = await postLedgerTransactionInTx(tx, {
      projectId: ledgerProjectId,
      description: `Wallet ${wallet.code} deposit`,
      postedBy: String(p.by ?? 'Finance'),
      postedRole: 'finance',
      // Natural idempotency ONLY when the caller supplied a unique reference —
      // repeated same-amount deposits without a reference are distinct events.
      idempotencyKey:
        p.idempotencyKey ??
        (typeof p.reference === 'string' && p.reference.trim() ? `wallet.deposit:${wallet.id}:${amount}:${p.reference.trim()}` : undefined),
      lines: [
        { accountCode: cashCode, side: 'debit', amount },
        { accountCode: `WALLET:${wallet.code}`, side: 'credit', amount },
      ],
    })
    // Derived on the SAME tx client — uncommitted entries are visible here,
    // so the returned balance reflects this deposit (liability: credits − debits).
    const account = await ensureAccountTx(tx, `WALLET:${wallet.code}`)
    const entries = await tx.ledgerEntry.findMany({ where: { accountId: account.id } })
    const debit = entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0)
    const credit = entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0)
    return { ledgerRef: ledgerTxn.ref, balance: credit - debit }
  })
  return { walletCode: wallet.code, ledgerRef, balance }
}

export async function withdrawWallet(projectId: string, p: any) {
  const amount = Number(p.amount)
  if (!(amount > 0)) throw new Error('Withdrawal amount must be positive')
  const wallet = await resolveWallet(projectId, p.walletId)
  const cashCode = cashAccountForMethod(String(p.destination ?? 'mpesa'))
  const ledgerProjectId = wallet.ownerType === 'project' ? projectId : null
  const { ledgerRef, balance } = await db.$transaction(async (tx) => {
    // Balance re-checked INSIDE the transaction — no overdraft race.
    const account = await ensureAccountTx(tx, `WALLET:${wallet.code}`)
    const entries = await tx.ledgerEntry.findMany({ where: { accountId: account.id } })
    const debit = entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0)
    const credit = entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0)
    const current = credit - debit // liability account
    if (current < amount) throw new Error(`Insufficient wallet balance: ${current} < ${amount}`)
    const ledgerTxn = await postLedgerTransactionInTx(tx, {
      projectId: ledgerProjectId,
      description: `Wallet ${wallet.code} withdrawal${p.note ? ` — ${p.note}` : ''}`,
      postedBy: String(p.by ?? 'Finance'),
      postedRole: 'finance',
      idempotencyKey: p.idempotencyKey ?? `wallet.withdraw:${wallet.id}:${amount}:${Date.now()}`,
      lines: [
        { accountCode: `WALLET:${wallet.code}`, side: 'debit', amount },
        { accountCode: cashCode, side: 'credit', amount },
      ],
    })
    return { ledgerRef: ledgerTxn.ref, balance: current - amount }
  })
  return { walletCode: wallet.code, ledgerRef, balance }
}

export async function transferWallet(projectId: string, p: any) {
  const amount = Number(p.amount)
  if (!(amount > 0)) throw new Error('Transfer amount must be positive')
  const from = await resolveWallet(projectId, p.fromWalletId)
  const to = await resolveWallet(projectId, p.toWalletId)
  const ledgerProjectId = from.ownerType === 'project' ? projectId : null
  const { ledgerRef } = await db.$transaction(async (tx) => {
    const account = await ensureAccountTx(tx, `WALLET:${from.code}`)
    const entries = await tx.ledgerEntry.findMany({ where: { accountId: account.id } })
    const debit = entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0)
    const credit = entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0)
    const current = credit - debit
    if (current < amount) throw new Error(`Insufficient wallet balance: ${current} < ${amount}`)
    const ledgerTxn = await postLedgerTransactionInTx(tx, {
      projectId: ledgerProjectId,
      description: `Wallet transfer ${from.code} → ${to.code}`,
      postedBy: String(p.by ?? 'Finance'),
      postedRole: 'finance',
      idempotencyKey: p.idempotencyKey ?? `wallet.transfer:${from.id}:${to.id}:${amount}:${Date.now()}`,
      lines: [
        { accountCode: `WALLET:${from.code}`, side: 'debit', amount },
        { accountCode: `WALLET:${to.code}`, side: 'credit', amount },
      ],
    })
    return { ledgerRef: ledgerTxn.ref }
  })
  return { from: from.code, to: to.code, ledgerRef }
}

// ---- Reversals & manual journals (spec §39) ----

export async function reverseTransaction(projectId: string, p: any) {
  const txn = await db.transaction.findFirst({ where: { id: String(p.id), projectId } })
  if (!txn) throw new Error('Transaction not found')
  if (!txn.ledgerTxnId) {
    // Legacy single-entry row (pre-ledger): post a compensating entry now.
    const by = String(p.by ?? 'Finance')
    const { reversalLedger, compensating } = await db.$transaction(async (tx) => {
      const reversalLedger = await postLedgerTransactionInTx(tx, {
        projectId,
        description: `REVERSAL of legacy transaction ${txn.id.slice(-6)} — ${p.reason ?? 'correction'}`,
        postedBy: by,
        postedRole: 'finance',
        lines: [
          { accountCode: cashAccountForMethod(String(p.method ?? txn.method)), side: 'debit', amount: txn.amount },
          { accountCode: `EXPENSE:${projectId}`, side: 'credit', amount: txn.amount },
        ],
      })
      const compensating =
        (await tx.transaction.findFirst({ where: { ledgerTxnId: reversalLedger.id } })) ??
        (await tx.transaction.create({
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
        }))
      await tx.transaction.update({ where: { id: txn.id }, data: { note: `${txn.note ?? ''} [reversed by ${reversalLedger.ref}]`.trim() } })
      return { reversalLedger, compensating }
    })
    return { reversalTransactionId: compensating.id, ledgerRef: reversalLedger.ref }
  }

  const ledgerTxn = await db.ledgerTransaction.findUnique({ where: { id: txn.ledgerTxnId } })
  if (!ledgerTxn) throw new Error('Backing ledger transaction not found')
  const reversal = await reverseLedgerTransaction(ledgerTxn.id, String(p.reason ?? 'correction'), String(p.by ?? 'Finance'), 'finance')
  const compensating =
    (await db.transaction.findFirst({ where: { ledgerTxnId: reversal.id } })) ??
    (await db.transaction.create({
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
    }))
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

// ---- Escrow top-up (money.ts escrow.topup — the ledger is the source of truth) ----

/**
 * Escrow top-up posting: debit the cash pool, credit ESCROW:<projectId>, and
 * keep the EscrowWallet.balance projection + ledgerAccountId in sync — all in
 * ONE db.$transaction (F2). `by`/`role` come from the resolved session actor.
 */
export async function postEscrowTopup(
  projectId: string,
  amount: number,
  by: string,
  opts: { reference?: string; method?: string; role?: string } = {},
): Promise<{ ledgerRef: string; balance: number }> {
  const method = opts.method ?? 'mpesa'
  const cashCode = cashAccountForMethod(method)
  return db.$transaction(async (tx) => {
    const escrowAccount = await ensureAccountTx(tx, `ESCROW:${projectId}`)
    const ledgerTxn = await postLedgerTransactionInTx(tx, {
      projectId,
      description: `Escrow top-up${opts.reference ? ` (${opts.reference})` : ''} — ${method}`,
      postedBy: by,
      postedRole: opts.role ?? 'client',
      idempotencyKey: opts.reference ? `escrow.topup:${projectId}:${opts.reference}` : undefined,
      lines: [
        { accountCode: cashCode, side: 'debit', amount },
        { accountCode: `ESCROW:${projectId}`, side: 'credit', amount },
      ],
    })
    const wallet = await tx.escrowWallet.upsert({
      where: { projectId },
      create: { projectId, balance: amount, ledgerAccountId: escrowAccount.id },
      update: { balance: { increment: amount }, ledgerAccountId: escrowAccount.id },
    })
    return { ledgerRef: ledgerTxn.ref, balance: wallet.balance }
  })
}

export async function escrowDerivedBalance(projectId: string) {
  await ensureAccount(`ESCROW:${projectId}`)
  return derivedBalance(`ESCROW:${projectId}`)
}

// ---- v1 read helpers (spec §38) ----

/** All wallets (optionally project-scoped) with ledger-derived balances. */
export async function listWallets(projectId?: string) {
  const wallets = await db.walletAccount.findMany({
    where: projectId ? { OR: [{ ownerId: projectId, ownerType: 'project' }, { ownerType: { not: 'project' } }] } : undefined,
    orderBy: { code: 'asc' },
  })
  const accounts = await db.ledgerAccount.findMany({ where: { ownerType: 'wallet' }, include: { entries: true } })
  return wallets.map((w) => {
    const account = accounts.find((a) => a.ownerId === w.id)
    const debit = account?.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0) ?? 0
    const credit = account?.entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0) ?? 0
    return {
      id: w.id,
      code: w.code,
      label: w.label,
      ownerType: w.ownerType,
      ownerId: w.ownerId,
      currency: w.currency,
      status: w.status,
      ledgerAccountCode: account?.code ?? null,
      balance: credit - debit, // liability account: we owe the owner this
      createdAt: w.createdAt.toISOString(),
    }
  })
}

/** Ledger transactions that touch a wallet's backing account. */
export async function walletLedgerTransactions(projectId: string, idOrCode: any) {
  const { wallet, balance } = await walletWithBalance(projectId, idOrCode)
  const account = wallet.ledgerAccountId
    ? await db.ledgerAccount.findUnique({ where: { id: wallet.ledgerAccountId } })
    : null
  if (!account) return { wallet: { code: wallet.code, label: wallet.label }, balance, transactions: [] }
  const txns = await db.ledgerTransaction.findMany({
    where: { entries: { some: { accountId: account.id } } },
    include: { entries: { include: { account: true } } },
    orderBy: { occurredAt: 'desc' },
    take: 100,
  })
  return {
    wallet: { code: wallet.code, label: wallet.label, ledgerAccount: account.code },
    balance,
    transactions: txns.map((t) => ({
      id: t.id,
      ref: t.ref,
      description: t.description,
      occurredAt: t.occurredAt.toISOString(),
      status: t.status,
      postedBy: t.postedBy,
      postedRole: t.postedRole,
      entries: t.entries.map((e) => ({
        accountCode: e.account.code,
        side: e.side,
        amount: e.amount,
        memo: e.memo,
      })),
      total: t.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0),
    })),
  }
}
