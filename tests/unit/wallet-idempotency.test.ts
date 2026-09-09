/**
 * Money idempotency for wallet withdraw/transfer (issue #75 / audit BE-3 +
 * BE-9) — the REAL src/backend/modules/wallet/service.ts and the REAL
 * modules/wallet/http.ts withIdempotency over an in-memory Prisma stub
 * (ledger.test.ts idiom for the service seams, v1-wallets idiom for the
 * idempotency replay).
 *
 * The bug (BE-3): withdrawWallet/transferWallet fell back to idempotency
 * keys embedding Date.now() when the caller sent no Idempotency-Key — every
 * retry after a lost response minted a NEW key and posted a SECOND ledger
 * debit (real double-pay risk). The fix: natural keys derive ONLY from
 * immutable request content (wallets, amount, currency, rail, note, actor),
 * so a retry replays the original result; the replay check runs BEFORE the
 * balance check so a retried withdrawal that emptied the wallet returns the
 * original ledgerRef instead of "Insufficient wallet balance".
 *
 * The companion fix (BE-9): withIdempotency stores a sha256 fingerprint of
 * the request payload next to the result (JSON envelope in the existing
 * responseBody TEXT column — no schema change) and a key reused with a
 * DIFFERENT payload answers 409 instead of silently replaying the stored
 * body. Legacy records (no envelope) keep replaying.
 *
 * Pinned:
 *   · same logical withdraw, retried → ONE ledger debit, same ledgerRef;
 *   · a retried withdrawal that emptied the wallet still replays (no
 *     "Insufficient wallet balance" on a retry);
 *   · distinct content (different note/amount) or a distinct explicit key
 *     still posts a second, intentional movement — the header path works;
 *   · transfer retry → one debit + one credit, same ledgerRef;
 *   · withIdempotency: same key + same payload → replay; same key +
 *     different payload → 409 (run never re-executed); legacy record →
 *     replay; no key → plain execution, nothing recorded.
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory Prisma stub: walletAccount + the ledger tables + idempotencyRecord
// (for the REAL withIdempotency). __state exposes the tables for assertions.
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    wallets: new Map<string, Record<string, unknown>>(),
    accounts: new Map<string, Record<string, unknown>>(),
    txns: new Map<string, Record<string, unknown>>(),
    entries: new Map<string, Record<string, unknown>>(),
    idem: new Map<string, Record<string, unknown>>(),
    reset() {
      state.wallets.clear()
      state.accounts.clear()
      state.txns.clear()
      state.entries.clear()
      state.idem.clear()
      state.seq = 0
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const entriesForAccount = (accountId: string) =>
    [...state.entries.values()].filter((e) => e.accountId === accountId)
  const entriesFor = (txnId: string) =>
    [...state.entries.values()]
      .filter((e) => e.txnId === txnId)
      .map((e) => ({ ...e, account: state.accounts.get(e.accountId as string) ?? null }))

  const ledgerAccount = {
    async findUnique({ where }: { where: { id?: string; code?: string } }) {
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
  const walletAccount = {
    async findFirst({ where }: { where?: { OR?: Array<{ id?: string; code?: string }> } }) {
      for (const cond of where?.OR ?? []) {
        if (cond.id) {
          const w = state.wallets.get(cond.id)
          if (w) return { ...w }
        }
        if (cond.code) {
          const w = [...state.wallets.values()].find((x) => x.code === cond.code)
          if (w) return { ...w }
        }
      }
      return null
    },
  }
  const ledgerEntry = {
    async findMany({ where }: { where: { accountId: string } }) {
      return entriesForAccount(where.accountId).map((e) => ({ ...e }))
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
    async create({
      data,
    }: { data: Record<string, unknown> & { entries?: { create: Record<string, unknown>[] } } }) {
      const { entries, ...rest } = data
      const t: Record<string, unknown> = { id: nid('txn'), status: 'posted', reversalRef: null, ...rest }
      const created = (entries?.create ?? []).map((l) => {
        const e: Record<string, unknown> = { id: nid('entry'), txnId: t.id, ...l }
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
  const idempotencyRecord = {
    async findUnique({ where }: { where: { key: string } }) {
      const r = state.idem.get(where.key)
      return r ? { ...r } : null
    },
    async create({ data }: { data: Record<string, unknown> }) {
      state.idem.set(data.key as string, { ...data })
      return { ...data }
    },
  }
  const db = {
    walletAccount,
    ledgerAccount,
    ledgerEntry,
    ledgerTransaction,
    idempotencyRecord,
    async $transaction(fn: (tx: typeof db) => unknown) {
      return fn(db)
    },
    __state: state,
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { withdrawWallet, transferWallet } from '@/backend/modules/wallet/service'
import { withIdempotency } from '@/backend/modules/wallet/http'

const state = (db as unknown as { __state: ReturnType<typeof getState> }).__state
function getState() {
  return undefined as unknown as {
    wallets: Map<string, Record<string, unknown>>
    accounts: Map<string, Record<string, unknown>>
    txns: Map<string, Record<string, unknown>>
    entries: Map<string, Record<string, unknown>>
    idem: Map<string, Record<string, unknown>>
    reset: () => void
  }
}

// ---------------------------------------------------------------- fixtures

const W1 = { id: 'w-1', code: 'W-0001', label: 'Riverside main', ownerType: 'project', ownerId: 'p-1', currency: 'KES', status: 'active' }
const W2 = { id: 'w-2', code: 'W-0002', label: 'Riverside float', ownerType: 'project', ownerId: 'p-1', currency: 'KES', status: 'active' }

/** Seed: both wallets exist with backing ledger accounts; W-0001 holds 10,000. */
function seedWallets() {
  state.wallets.set('w-1', { ...W1 })
  state.wallets.set('w-2', { ...W2 })
  const la1 = { id: 'la-1', code: 'WALLET:W-0001', ownerType: 'wallet', ownerId: 'w-1' }
  const la2 = { id: 'la-2', code: 'WALLET:W-0002', ownerType: 'wallet', ownerId: 'w-2' }
  state.accounts.set('la-1', la1)
  state.accounts.set('la-2', la2)
  state.entries.set('seed-1', { id: 'seed-1', txnId: 'seed-txn', accountId: 'la-1', side: 'credit', amount: 10_000, memo: null })
}

/** Wallet-account legs by side (the ledger rows a withdraw/transfer produces). */
const legsOf = (accountId: string, side: 'debit' | 'credit', amount: number) =>
  [...state.entries.values()].filter(
    (e) => e.accountId === accountId && e.side === side && e.amount === amount,
  )

beforeEach(() => {
  state.reset()
  seedWallets()
})

// ------------------------------------------------- BE-3: withdraw retries

describe('withdrawWallet — deterministic natural idempotency key (BE-3)', () => {
  const P = { walletId: 'w-1', amount: 2_500, destination: 'mpesa', note: 'Fuel advance', by: 'finance' }

  it('the SAME logical withdraw retried twice → exactly ONE ledger debit, same ledgerRef (no double-pay)', async () => {
    const first = await withdrawWallet('p-1', P)
    const retry = await withdrawWallet('p-1', { ...P }) // byte-identical retry — no key, no header

    expect(retry.ledgerRef).toBe(first.ledgerRef)
    expect(retry.balance).toBe(first.balance) // 7,500 — not 5,000
    // exactly one wallet debit leg for this amount — the retry posted NOTHING
    expect(legsOf('la-1', 'debit', 2_500)).toHaveLength(1)
    // and exactly one cash credit leg (the posting happened once, not twice)
    expect(
      [...state.entries.values()].filter(
        (e) => e.accountId !== 'la-1' && e.accountId !== 'la-2' && e.side === 'credit' && e.amount === 2_500,
      ),
    ).toHaveLength(1)
  })

  it('a retried withdrawal that emptied the wallet REPLAYS instead of "Insufficient wallet balance"', async () => {
    const first = await withdrawWallet('p-1', { walletId: 'w-1', amount: 10_000, by: 'finance' })
    expect(first.balance).toBe(0)
    // the retry sees balance 0 < 10,000 — but the money already moved once:
    // the replay check fires BEFORE the balance check and returns the original.
    const retry = await withdrawWallet('p-1', { walletId: 'w-1', amount: 10_000, by: 'finance' })
    expect(retry.ledgerRef).toBe(first.ledgerRef)
    expect(retry.balance).toBe(0)
    expect(legsOf('la-1', 'debit', 10_000)).toHaveLength(1)
  })

  it('no Date.now() in the derived key: two identical calls derive the SAME key (one unique ledger idempotencyKey)', async () => {
    await withdrawWallet('p-1', P)
    await withdrawWallet('p-1', { ...P })
    const keys = [...state.txns.values()].map((t) => t.idempotencyKey)
    const naturalKeys = keys.filter((k) => String(k).startsWith('wallet.withdraw:'))
    expect(naturalKeys).toHaveLength(1) // same key both times — the dedupe that Date.now() broke
  })

  it('DISTINCT content (different note or amount) is NOT falsely deduped — intentional distinct movements still post', async () => {
    await withdrawWallet('p-1', { ...P, note: 'Fuel advance' })
    await withdrawWallet('p-1', { ...P, note: 'Tool repair' }) // different note = different intent
    await withdrawWallet('p-1', { ...P, amount: 1_000 }) // different amount
    expect(legsOf('la-1', 'debit', 2_500)).toHaveLength(2)
    expect(legsOf('la-1', 'debit', 1_000)).toHaveLength(1)
  })

  it('the explicit Idempotency-Key path still works: same key → replay; a DIFFERENT key → a second intentional withdrawal', async () => {
    await withdrawWallet('p-1', { ...P, idempotencyKey: 'op-42' })
    const replay = await withdrawWallet('p-1', { ...P, idempotencyKey: 'op-42' })
    expect(legsOf('la-1', 'debit', 2_500)).toHaveLength(1)
    await withdrawWallet('p-1', { ...P, idempotencyKey: 'op-43' })
    expect(legsOf('la-1', 'debit', 2_500)).toHaveLength(2) // distinct key = distinct event
    expect(replay.ledgerRef).toBeTruthy()
  })
})

// ------------------------------------------------- BE-3: transfer retries

describe('transferWallet — deterministic natural idempotency key (BE-3)', () => {
  it('the SAME logical transfer retried twice → ONE debit + ONE credit, same ledgerRef', async () => {
    const first = await transferWallet('p-1', { fromWalletId: 'w-1', toWalletId: 'w-2', amount: 1_000, by: 'finance' })
    const retry = await transferWallet('p-1', { fromWalletId: 'w-1', toWalletId: 'w-2', amount: 1_000, by: 'finance' })
    expect(retry.ledgerRef).toBe(first.ledgerRef)
    expect(retry.from).toBe('W-0001')
    expect(retry.to).toBe('W-0002')
    expect(legsOf('la-1', 'debit', 1_000)).toHaveLength(1)
    expect(legsOf('la-2', 'credit', 1_000)).toHaveLength(1)
  })

  it('a transfer to a different destination wallet is a distinct movement (no false dedup)', async () => {
    state.wallets.set('w-3', { id: 'w-3', code: 'W-0003', label: 'Org float', ownerType: 'organization', ownerId: 'org-1', currency: 'KES', status: 'active' })
    state.accounts.set('la-3', { id: 'la-3', code: 'WALLET:W-0003', ownerType: 'wallet', ownerId: 'w-3' })
    await transferWallet('p-1', { fromWalletId: 'w-1', toWalletId: 'w-2', amount: 500, by: 'finance' })
    await transferWallet('p-1', { fromWalletId: 'w-1', toWalletId: 'w-3', amount: 500, by: 'finance' })
    expect(legsOf('la-1', 'debit', 500)).toHaveLength(2)
  })
})

// ------------------------------------- BE-9: withIdempotency payload mismatch

describe('withIdempotency — payload fingerprint + 409 on key reuse with a different body (BE-9)', () => {
  const url = 'http://localhost/api/v1/wallets/w-1/withdraw'
  const reqWithKey = (key: string) =>
    new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key } })

  it('first run records the result WITH the payload hash; same key + same payload → replay without re-running', async () => {
    const run = vi.fn(async () => ({ walletCode: 'W-0001', ledgerRef: 'LX-1', balance: 7_500 }))
    const first = await withIdempotency(reqWithKey('k-1'), 'v1.wallet.withdraw', 'p-1', run, { amount: 2_500 })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, data: { walletCode: 'W-0001', ledgerRef: 'LX-1', balance: 7_500 } })
    const record = state.idem.get('k-1') as Record<string, unknown>
    expect(record.scope).toBe('v1.wallet.withdraw')
    expect(record.projectId).toBe('p-1')
    const stored = JSON.parse(record.responseBody as string)
    expect(stored.body).toEqual({ walletCode: 'W-0001', ledgerRef: 'LX-1', balance: 7_500 })
    expect(stored.payloadHash).toMatch(/^[0-9a-f]{64}$/)

    const replay = await withIdempotency(reqWithKey('k-1'), 'v1.wallet.withdraw', 'p-1', run, { amount: 2_500 })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({
      ok: true, data: { walletCode: 'W-0001', ledgerRef: 'LX-1', balance: 7_500 },
      replayed: true, scope: 'v1.wallet.withdraw',
    })
    expect(run).toHaveBeenCalledTimes(1) // never re-executed
  })

  it('same key + DIFFERENT payload → 409, the stored body is NOT replayed, the run never executes', async () => {
    const run = vi.fn(async () => ({ walletCode: 'W-0001', ledgerRef: 'LX-2', balance: 7_500 }))
    await withIdempotency(reqWithKey('k-2'), 'v1.wallet.withdraw', 'p-1', run, { amount: 2_500 })
    const conflict = await withIdempotency(reqWithKey('k-2'), 'v1.wallet.withdraw', 'p-1', run, { amount: 999 })
    expect(conflict.status).toBe(409)
    const body = (await conflict.json()) as { error: string }
    expect(body.error).toMatch(/different payload/i)
    expect(body.ok).toBeUndefined() // v1 error shape: { error } only
    expect(run).toHaveBeenCalledTimes(1)
    // the record is untouched: a same-payload retry still replays
    const replay = await withIdempotency(reqWithKey('k-2'), 'v1.wallet.withdraw', 'p-1', run, { amount: 2_500 })
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as Record<string, unknown>).replayed).toBe(true)
  })

  it('LEGACY records (stored before the fingerprint) still replay unconditionally — back-compat', async () => {
    state.idem.set('k-legacy', {
      key: 'k-legacy', scope: 'v1.wallet.withdraw', projectId: 'p-1',
      responseBody: JSON.stringify({ walletCode: 'W-0001', ledgerRef: 'LX-OLD', balance: 1 }),
    })
    const run = vi.fn(async () => ({ ledgerRef: 'LX-NEW' }))
    const res = await withIdempotency(reqWithKey('k-legacy'), 'v1.wallet.withdraw', 'p-1', run, { amount: 5 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true, data: { walletCode: 'W-0001', ledgerRef: 'LX-OLD', balance: 1 },
      replayed: true, scope: 'v1.wallet.withdraw',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('no key → the run executes plainly and nothing is recorded (the header stays optional)', async () => {
    const run = vi.fn(async () => ({ ok: true }))
    const req = new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' } })
    const res = await withIdempotency(req, 'v1.wallet.withdraw', 'p-1', run, { amount: 1 })
    expect(res.status).toBe(200)
    expect(run).toHaveBeenCalledTimes(1)
    expect(state.idem.size).toBe(0)
  })
})
