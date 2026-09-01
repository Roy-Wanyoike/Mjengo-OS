// Double-entry ledger engine (spec §39) — the single way money moves.
// Every financial write posts a LedgerTransaction with balanced debit/credit
// legs inside one db.$transaction. History is immutable: corrections are
// new reversal transactions, never edits or deletes.

import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export interface LedgerLineInput {
  accountCode: string
  side: 'debit' | 'credit'
  amount: number
  memo?: string
}

export interface PostLedgerInput {
  projectId: string | null
  description: string
  lines: LedgerLineInput[]
  postedBy: string
  postedRole: string
  occurredAt?: Date
  idempotencyKey?: string
  reversalOfId?: string
}

/** Platform chart of accounts (created lazily, idempotent). */
export const PLATFORM_ACCOUNTS = [
  { code: 'CASH_MPESA', name: 'Mobile Money Pool (simulated)', kind: 'asset', normalSide: 'debit' as const, ownerType: 'platform' },
  { code: 'CASH_BANK', name: 'Bank Float (simulated)', kind: 'asset', normalSide: 'debit' as const, ownerType: 'platform' },
]

export async function ensureAccount(code: string): Promise<{ id: string; kind: string; name: string }> {
  const existing = await db.ledgerAccount.findUnique({ where: { code } })
  if (existing) return { id: existing.id, kind: existing.kind, name: existing.name }
  return ensureAccountTx(db, code)
}

/**
 * Account resolution INSIDE a db.$transaction — used by postLedgerTransactionInTx
 * so atomic money flows never post against a half-created chart of accounts.
 * Understands the platform accounts, the ESCROW:<projectId> / EXPENSE:<projectId>
 * project convention and pre-created WALLET:<code> accounts; anything else must
 * be created explicitly first.
 */
export async function ensureAccountTx(tx: Prisma.TransactionClient, code: string): Promise<{ id: string; kind: string; name: string }> {
  const existing = await tx.ledgerAccount.findUnique({ where: { code } })
  if (existing) return { id: existing.id, kind: existing.kind, name: existing.name }
  const platform = PLATFORM_ACCOUNTS.find((a) => a.code === code)
  if (platform) {
    const created = await tx.ledgerAccount.create({ data: { code: platform.code, name: platform.name, kind: platform.kind, normalSide: platform.normalSide, ownerType: 'platform' } })
    return { id: created.id, kind: created.kind, name: created.name }
  }
  if (code.startsWith('ESCROW:')) {
    return ensureProjectAccountTx(tx, code.slice('ESCROW:'.length), code, `Project Escrow — ${code.slice(-6)}`, 'liability')
  }
  if (code.startsWith('EXPENSE:')) {
    return ensureProjectAccountTx(tx, code.slice('EXPENSE:'.length), code, `Project Expense — ${code.slice(-6)}`, 'expense')
  }
  throw new Error(`Unknown ledger account code: ${code} — create the account first`)
}

/** Project-scoped account (escrow / expense / payable). */
export async function ensureProjectAccount(projectId: string, code: string, name: string, kind: string): Promise<{ id: string; kind: string; name: string }> {
  const existing = await db.ledgerAccount.findUnique({ where: { code } })
  if (existing) return { id: existing.id, kind: existing.kind, name: existing.name }
  return ensureProjectAccountTx(db, projectId, code, name, kind)
}

/** Project-scoped account creation inside a db.$transaction. */
export async function ensureProjectAccountTx(tx: Prisma.TransactionClient, projectId: string, code: string, name: string, kind: string): Promise<{ id: string; kind: string; name: string }> {
  const existing = await tx.ledgerAccount.findUnique({ where: { code } })
  if (existing) return { id: existing.id, kind: existing.kind, name: existing.name }
  const created = await tx.ledgerAccount.create({
    data: { code, name, kind, normalSide: kind === 'asset' || kind === 'expense' ? 'debit' : 'credit', projectId, ownerType: 'project', ownerId: projectId },
  })
  return { id: created.id, kind: created.kind, name: created.name }
}

export async function ensureEscrowAccount(projectId: string) {
  return ensureProjectAccount(projectId, `ESCROW:${projectId}`, `Project Escrow — ${projectId.slice(-6)}`, 'liability')
}

export async function ensureExpenseAccount(projectId: string) {
  return ensureProjectAccount(projectId, `EXPENSE:${projectId}`, `Project Expense — ${projectId.slice(-6)}`, 'expense')
}

let refCounter = 0
export function nextLedgerRef(): string {
  const now = new Date()
  refCounter = (refCounter + 1) % 100000
  return `LX-${now.getFullYear()}-${String(refCounter).padStart(6, '0')}-${Date.now() % 1000}`
}

/** Cash account code for a payment rail — one mapping, one source of truth. */
export function cashAccountForMethod(method: string): 'CASH_MPESA' | 'CASH_BANK' {
  // mpesa settles into the (simulated) mobile-money pool; bank / card / cash
  // settle into the (simulated) bank float.
  return String(method).toLowerCase() === 'mpesa' ? 'CASH_MPESA' : 'CASH_BANK'
}

function validateLines(lines: LedgerLineInput[]) {
  if (!lines.length) throw new Error('Ledger transaction needs at least one line')
  for (const l of lines) {
    if (!(l.amount > 0)) throw new Error('Ledger amounts must be positive')
    if (l.side !== 'debit' && l.side !== 'credit') throw new Error('Ledger side must be debit or credit')
  }
  const debit = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)
  const credit = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0)
  if (Math.abs(debit - credit) > 0.005) {
    throw new Error(`Unbalanced ledger transaction: debits ${debit} ≠ credits ${credit}`)
  }
}

/**
 * Post one balanced double-entry transaction. Fails hard when:
 *  - lines are empty / amounts are non-positive
 *  - debits ≠ credits (spec §39 invariant)
 *  - idempotency key already used (returns the original txn — no double post)
 */
export async function postLedgerTransaction(input: PostLedgerInput) {
  return db.$transaction((tx) => postLedgerTransactionInTx(tx, input))
}

/**
 * The posting core, INSIDE a caller-owned db.$transaction — used by every
 * atomic money flow (escrow top-up, milestone release, invoice payment,
 * wages, expense posting, payment requests). Runs the idempotency check and
 * the chart-of-accounts resolution on the SAME tx client as the posting so
 * the whole money movement commits or rolls back as one unit.
 */
export async function postLedgerTransactionInTx(tx: Prisma.TransactionClient, input: PostLedgerInput) {
  validateLines(input.lines)

  if (input.idempotencyKey) {
    const existing = await tx.ledgerTransaction.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
    if (existing) return existing
  }

  const resolved = await Promise.all(
    input.lines.map(async (l) => ({ line: l, account: await ensureAccountTx(tx, l.accountCode) })),
  )

  const reversalOf = input.reversalOfId
    ? await tx.ledgerTransaction.findUnique({ where: { id: input.reversalOfId } })
    : null

  const txn = await tx.ledgerTransaction.create({
    data: {
      ref: nextLedgerRef(),
      projectId: input.projectId,
      description: input.description,
      occurredAt: input.occurredAt ?? new Date(),
      postedBy: input.postedBy,
      postedRole: input.postedRole,
      reversalOfId: reversalOf?.id ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      entries: {
        create: resolved.map(({ line, account }) => ({
          accountId: account.id,
          side: line.side,
          amount: line.amount,
          memo: line.memo ?? null,
        })),
      },
    },
    include: { entries: true },
  })
  if (reversalOf) {
    await tx.ledgerTransaction.update({
      where: { id: reversalOf.id },
      data: { status: 'reversed', reversalRef: txn.ref },
    })
  }
  return txn
}

/** Reverse a posted transaction with mirrored entries (never edit history). */
export async function reverseLedgerTransaction(txnId: string, reason: string, postedBy: string, postedRole: string) {
  const original = await db.ledgerTransaction.findUnique({
    where: { id: txnId },
    include: { entries: { include: { account: true } } },
  })
  if (!original) throw new Error('Ledger transaction not found')
  if (original.status === 'reversed') throw new Error('Transaction already reversed')

  const reversal = await postLedgerTransaction({
    projectId: original.projectId,
    description: `REVERSAL of ${original.ref} — ${reason}`,
    lines: original.entries.map((e) => ({
      accountCode: e.account.code,
      side: (e.side === 'debit' ? 'credit' : 'debit') as 'debit' | 'credit',
      amount: e.amount,
      memo: e.memo ?? undefined,
    })),
    postedBy,
    postedRole,
    reversalOfId: original.id,
  })
  return reversal
}

/** Derived balance for an account — the ONLY way balance is known (spec §39). */
export async function derivedBalance(accountCode: string): Promise<number> {
  const account = await db.ledgerAccount.findUnique({
    where: { code: accountCode },
    include: { entries: true },
  })
  if (!account) return 0
  const debit = account.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0)
  const credit = account.entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0)
  return account.kind === 'asset' || account.kind === 'expense' ? debit - credit : credit - debit
}

/** Tx operations used by the wallet service (kept here for reuse). */
export type TxClient = Prisma.TransactionClient
