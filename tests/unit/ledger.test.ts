/**
 * Double-entry ledger invariants (src/backend/modules/ledger/service.ts).
 *
 * The ledger is "the single way money moves" (spec §39). Its core rules are
 * enforced in pure code paths that only need a Prisma transaction client, so
 * this file swaps @/backend/lib/db for a tiny in-memory stub and tests the
 * REAL posting/reversal logic:
 *  · unbalanced (debits ≠ credits) or malformed lines never post;
 *  · a posted transaction carries balanced legs;
 *  · an idempotency key replays the original transaction — never a double post;
 *  · a reversal is a NEW mirrored transaction that flips the original's
 *    status, never an edit of history;
 *  · derived balances follow the account's normal side.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: just enough of ledgerAccount / ledgerTransaction /
// $transaction for the posting core. __state exposes the tables for assertions.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    accounts: new Map<string, Record<string, unknown>>(),
    txns: new Map<string, Record<string, unknown>>(),
    entries: new Map<string, Record<string, unknown>>(),
    reset() {
      state.accounts.clear()
      state.txns.clear()
      state.entries.clear()
      state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const entriesFor = (txnId: string) =>
    [...state.entries.values()]
      .filter((e) => e.transactionId === txnId)
      .map((e) => ({ ...e, account: state.accounts.get(e.accountId as string) ?? null }))

  const entriesForAccount = (accountId: string) =>
    [...state.entries.values()].filter((e) => e.accountId === accountId)
  const ledgerAccount = {
    async findUnique({ where }: { where: { code?: string; id?: string } }) {
      let a: Record<string, unknown> | undefined
      if (where.id) a = state.accounts.get(where.id)
      else if (where.code) a = [...state.accounts.values()].find((x) => x.code === where.code)
      return a ? { ...a, entries: entriesForAccount(a.id as string) } : null
    },
    async create({ data }: { data: Record<string, unknown> }) {
      const a: Record<string, unknown> = { id: nid('acct'), ...data }
      state.accounts.set(a.id as string, a)
      return a
    },
  }
  const ledgerTransaction = {
    async findUnique({ where }: { where: { id?: string; idempotencyKey?: string } }) {
      let t: Record<string, unknown> | undefined
      if (where.id) t = state.txns.get(where.id)
      else if (where.idempotencyKey) {
        t = [...state.txns.values()].find((x) => x.idempotencyKey === where.idempotencyKey)
      }
      return t ? { ...t, entries: entriesFor(t.id as string) } : null
    },
    async create({ data }: { data: Record<string, unknown> & { entries?: { create: Record<string, unknown>[] } } }) {
      const { entries, ...rest } = data
      const t: Record<string, unknown> = { id: nid('txn'), status: 'posted', reversalRef: null, ...rest }
      const created = (entries?.create ?? []).map((l) => {
        const e: Record<string, unknown> = { id: nid('entry'), transactionId: t.id, ...l }
        state.entries.set(e.id as string, e)
        return { ...e, account: state.accounts.get(e.accountId as string) ?? null }
      })
      state.txns.set(t.id as string, t)
      return { ...t, entries: created }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const t = state.txns.get(where.id)
      if (!t) throw new Error(`stub: txn ${where.id} not found`)
      Object.assign(t, data)
      return { ...t, entries: entriesFor(where.id) }
    },
  }
  const db = {
    ledgerAccount,
    ledgerTransaction,
    async $transaction(fn: (tx: typeof db) => unknown) {
      return fn(db)
    },
    __state: state,
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import {
  cashAccountForMethod, derivedBalance, ensureAccount, postLedgerTransaction,
  reverseLedgerTransaction,
} from '@/backend/modules/ledger/service'

const state = (db as unknown as { __state: ReturnType<typeof getState> }).__state

/** The posting core always returns the transaction WITH its entries (include). */
type Posted = {
  id: string
  ref: string
  status: string
  description: string
  reversalOfId: string | null
  entries: { id: string; side: string; amount: number; memo: string | null }[]
}
const asPosted = (t: unknown): Posted => t as Posted
function getState() {
  return undefined as unknown as {
    accounts: Map<string, Record<string, unknown>>
    txns: Map<string, Record<string, unknown>>
    entries: Map<string, Record<string, unknown>>
    reset: () => void
  }
}

const BALANCED_LINES = [
  { accountCode: 'CASH_MPESA', side: 'debit' as const, amount: 1000 },
  { accountCode: 'ESCROW:proj-1', side: 'credit' as const, amount: 1000 },
]

const post = (over: Record<string, unknown> = {}) =>
  postLedgerTransaction({
    projectId: 'proj-1',
    description: 'escrow top-up',
    lines: BALANCED_LINES,
    postedBy: 'finance@mjengo.os',
    postedRole: 'finance',
    ...over,
  })

beforeEach(() => {
  state.reset()
})

describe('validateLines — unbalanced or malformed transactions never post', () => {
  it('rejects debits ≠ credits', async () => {
    await expect(
      post({
        lines: [
          { accountCode: 'CASH_MPESA', side: 'debit', amount: 1000 },
          { accountCode: 'ESCROW:proj-1', side: 'credit', amount: 999 },
        ],
      }),
    ).rejects.toThrow(/Unbalanced ledger transaction: debits 1000 ≠ credits 999/)
  })

  it('rejects an empty line set', async () => {
    await expect(post({ lines: [] })).rejects.toThrow('Ledger transaction needs at least one line')
  })

  it('rejects non-positive amounts (zero or negative money is nonsense)', async () => {
    await expect(
      post({ lines: [{ accountCode: 'CASH_MPESA', side: 'debit', amount: 0 }, { accountCode: 'CASH_MPESA', side: 'credit', amount: 0 }] }),
    ).rejects.toThrow('Ledger amounts must be positive')
    await expect(
      post({ lines: [{ accountCode: 'CASH_MPESA', side: 'debit', amount: -5 }, { accountCode: 'CASH_MPESA', side: 'credit', amount: -5 }] }),
    ).rejects.toThrow('Ledger amounts must be positive')
  })

  it('rejects a nonsense side', async () => {
    await expect(
      post({ lines: [{ accountCode: 'CASH_MPESA', side: 'up', amount: 5 } as never] }),
    ).rejects.toThrow('Ledger side must be debit or credit')
  })

  it('nothing was written when validation fails', async () => {
    await expect(post({ lines: [] })).rejects.toThrow()
    expect(state.txns.size).toBe(0)
    expect(state.entries.size).toBe(0)
  })
})

describe('postLedgerTransaction — balanced double entry', () => {
  it('creates one transaction whose debit legs sum to its credit legs', async () => {
    const txn = asPosted(await post())
    const debit = txn.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0)
    const credit = txn.entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0)
    expect(debit).toBe(1000)
    expect(credit).toBe(1000)
    expect(txn.status).toBe('posted')
    expect(txn.reversalOfId).toBeNull()
  })

  it('resolves the platform cash account and the project escrow account', async () => {
    await post()
    const cash = await ensureAccount('CASH_MPESA')
    const escrow = await ensureAccount('ESCROW:proj-1')
    expect(cash.kind).toBe('asset')
    expect(escrow.kind).toBe('liability')
    // ownership lives on the account row (ensureAccount returns only id/kind/name)
    const escrowRow = [...state.accounts.values()].find((a) => a.code === 'ESCROW:proj-1')
    expect(escrowRow!.ownerType).toBe('project')
    expect(escrowRow!.ownerId).toBe('proj-1')
  })

  it('replays the original transaction for a repeated idempotency key (no double post)', async () => {
    const first = asPosted(await post({ idempotencyKey: 'topup-42' }))
    const replay = asPosted(await post({ idempotencyKey: 'topup-42' }))
    expect(replay.id).toBe(first.id)
    expect([...state.txns.values()].filter((t) => t.idempotencyKey === 'topup-42')).toHaveLength(1)
    expect(state.entries.size).toBe(2) // still exactly two legs
  })
})

describe('ensureAccountTx — chart of accounts resolution', () => {
  it('is idempotent per code (one account row, ever)', async () => {
    const a = await ensureAccount('CASH_BANK')
    const b = await ensureAccount('CASH_BANK')
    expect(a.id).toBe(b.id)
    expect([...state.accounts.values()].filter((x) => x.code === 'CASH_BANK')).toHaveLength(1)
  })

  it('ESCROW:<projectId> is a liability with a credit normal side', async () => {
    const acct = await ensureAccount('ESCROW:proj-2')
    expect(acct.kind).toBe('liability')
  })

  it('EXPENSE:<projectId> is an expense with a debit normal side', async () => {
    const acct = await ensureAccount('EXPENSE:proj-2')
    expect(acct.kind).toBe('expense')
  })

  it('unknown codes are refused — no silent implicit accounts', async () => {
    await expect(ensureAccount('MISC_WHATEVER')).rejects.toThrow(/Unknown ledger account code/)
  })
})

describe('reverseLedgerTransaction — corrections are new entries, never edits', () => {
  it('creates a mirrored transaction and flips the original status', async () => {
    const original = asPosted(await post())
    const originalEntryIds = [...state.entries.values()].filter((e) => e.transactionId === original.id).map((e) => e.id)

    const reversal = asPosted(await reverseLedgerTransaction(original.id, 'wrong amount', 'finance@mjengo.os', 'finance'))

    // the original's history is untouched (append-only): same entries, now marked
    expect([...state.entries.values()].filter((e) => e.transactionId === original.id).map((e) => e.id)).toEqual(originalEntryIds)
    const marked = [...state.txns.values()].find((t) => t.id === original.id)
    expect(marked!.status).toBe('reversed')
    expect(marked!.reversalRef).toBe(reversal.ref)

    // the reversal points back at the original and mirrors every leg
    expect(reversal.reversalOfId).toBe(original.id)
    expect(reversal.description).toContain('REVERSAL of')
    expect(reversal.entries.map((e) => e.side).sort()).toEqual(['credit', 'debit'])
    const bySide = (side: string) => reversal.entries.find((e) => e.side === side)
    expect(bySide('debit')!.amount).toBe(1000) // escrow leg flipped to debit
    expect(bySide('credit')!.amount).toBe(1000) // cash leg flipped to credit
  })

  it('a reversal nets every touched account back to zero', async () => {
    const original = asPosted(await post())
    await reverseLedgerTransaction(original.id, 'test reversal', 'finance@mjengo.os', 'finance')
    expect(await derivedBalance('CASH_MPESA')).toBe(0)
    expect(await derivedBalance('ESCROW:proj-1')).toBe(0)
  })

  it('refuses to reverse an already-reversed transaction', async () => {
    const original = asPosted(await post())
    await reverseLedgerTransaction(original.id, 'first', 'finance@mjengo.os', 'finance')
    await expect(reverseLedgerTransaction(original.id, 'second', 'finance@mjengo.os', 'finance')).rejects.toThrow(
      'Transaction already reversed',
    )
  })

  it('refuses to reverse an unknown transaction id', async () => {
    await expect(reverseLedgerTransaction('nope', 'x', 'finance@mjengo.os', 'finance')).rejects.toThrow(
      'Ledger transaction not found',
    )
  })
})

describe('derivedBalance — balances are projections of entries', () => {
  it('asset accounts are debit-minus-credit', async () => {
    await post()
    expect(await derivedBalance('CASH_MPESA')).toBe(1000)
  })

  it('liability accounts are credit-minus-debit', async () => {
    await post()
    expect(await derivedBalance('ESCROW:proj-1')).toBe(1000)
  })

  it('an unknown account has balance 0 (no throw)', async () => {
    expect(await derivedBalance('CASH_BANK')).toBe(0)
  })
})

describe('cashAccountForMethod — payment rail mapping', () => {
  it("M-Pesa settles into the mobile-money pool", () => {
    // The rail enum is the lowercase word 'mpesa' (PaymentMethod); casing is
    // tolerated, but a hyphenated brand spelling is NOT a rail this app emits.
    expect(cashAccountForMethod('mpesa')).toBe('CASH_MPESA')
    expect(cashAccountForMethod('MPESA')).toBe('CASH_MPESA')
    expect(cashAccountForMethod('Mpesa')).toBe('CASH_MPESA')
  })

  it('everything else settles into the bank float', () => {
    for (const m of ['bank', 'card', 'cash', 'cheque', '']) {
      expect(cashAccountForMethod(m)).toBe('CASH_BANK')
    }
  })
})
