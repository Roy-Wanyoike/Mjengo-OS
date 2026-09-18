/**
 * SQL SUM aggregation equivalence (issue #144 — the aggregation half of DB-6).
 *
 * derivedBalance, the wallet ops' in-tx re-checks and the wallet list now
 * aggregate Σdebit/Σcredit IN SQL (ledgerEntry.groupBy → SELECT side,
 * SUM(amount) … GROUP BY side) instead of loading an account's entire entry
 * history into JS and reducing it. This file pins that the two computations
 * are THE SAME NUMBER, not just similar:
 *
 *  · the REAL service code (derivedBalance / accountSideSums / listWallets)
 *    runs unmodified against a db stub whose ledgerAccount / ledgerEntry /
 *    walletAccount delegates translate the exact Prisma call shapes into
 *    real SQL on a REAL better-sqlite3 :memory: database with the FULL
 *    migration history applied (00_init … 15_hot_path_indexes — so the
 *    CHECK constraints, the migration-14 insert gates and the hot-path
 *    indexes are all live, exactly like production);
 *  · a PRIVATE reference reduce in this file re-implements the pre-#144
 *    in-JS math verbatim (filter by side, reduce in bigint, kind-keyed
 *    sign convention) and the two are compared over RANDOM entry sets —
 *    many accounts, all five account kinds, 0–40 entries each, amounts up
 *    to 10^14 cents (stress the i64 SUM, not just doubles);
 *  · the wallet list is compared row-for-row (every key, including
 *    ledgerAccountCode and the KSh balance) against the reference
 *    implementation of the old `include: { entries: true }` + reduce shape,
 *  · deterministic PRNG (fixed seed) — a failure names its case index and
 *    replays identically.
 *
 * Seeding deliberately goes through DIRECT SQL inserts (transactions born
 * 'pending', legs attached while pending — the migration-14-legal writer
 * shape) so the DB-level guards run on every row this test writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'

// The db stub: every delegate translates the EXACT Prisma call shape the
// service issues into real SQL against a real migrated SQLite database.
vi.mock('@/backend/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3')
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations')
  const sqlite = new Database(':memory:')
  // BigInt everywhere: Prisma's SQLite connector maps INTEGER → BigInt for
  // BigInt columns (exact i64 SUMs, no double rounding) — mirror that.
  sqlite.defaultSafeIntegers(true)
  for (const dir of readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d+_/.test(d))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'))
  }

  const toWalletRow = (r: Record<string, unknown>) => ({
    ...r,
    createdAt: new Date(r.createdAt as string),
    updatedAt: new Date(r.updatedAt as string),
  })

  const db = {
    // derivedBalance: findUnique(code) → { id, kind } (no entries include).
    ledgerAccount: {
      async findUnique({ where }: { where: { code: string } }) {
        const row = sqlite.prepare('SELECT "id", "kind" FROM LedgerAccount WHERE "code" = ?').get(where.code)
        return row ?? null
      },
      // listWallets: bounded account rows only (id, code, ownerId).
      async findMany({ where }: { where: { ownerType: string } }) {
        return sqlite.prepare('SELECT "id", "code", "ownerId" FROM LedgerAccount WHERE "ownerType" = ?').all(where.ownerType)
      },
    },
    // The SQL SUM aggregation under test — real GROUP BY, real SUM(amount).
    ledgerEntry: {
      async groupBy({
        by,
        _sum,
        where,
      }: {
        by: string[]
        _sum?: { amount?: boolean }
        where?: { accountId?: string | { in: string[] } }
      }) {
        const clauses: string[] = []
        const params: unknown[] = []
        const acct = where?.accountId
        if (typeof acct === 'string') {
          clauses.push('"accountId" = ?')
          params.push(acct)
        } else if (acct && typeof acct === 'object' && Array.isArray(acct.in)) {
          if (acct.in.length === 0) return []
          clauses.push(`"accountId" IN (${acct.in.map(() => '?').join(', ')})`)
          params.push(...acct.in)
        }
        const cols = by.map((f) => `"${f}"`).join(', ')
        const sql =
          `SELECT ${cols}${_sum?.amount ? ', SUM("amount") AS "amount"' : ''} FROM "LedgerEntry"` +
          `${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} GROUP BY ${cols}`
        const rows = sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>
        return rows.map((r) => {
          const out: Record<string, unknown> = {}
          for (const f of by) out[f] = r[f]
          if (_sum?.amount) out._sum = { amount: r.amount === null ? null : BigInt(r.amount as bigint) }
          return out
        })
      },
    },
    walletAccount: {
      async findMany({
        where,
      }: {
        where?: { OR?: Array<{ ownerId?: string; ownerType?: string | { not?: string } }> }
      }) {
        if (!where) return sqlite.prepare('SELECT * FROM WalletAccount ORDER BY "code" ASC').all().map(toWalletRow)
        if (where.OR?.length === 2 && where.OR[0].ownerType === 'project' && typeof where.OR[1].ownerType === 'object') {
          // listWallets' project-scoped OR shape, verbatim.
          return sqlite
            .prepare(
              `SELECT * FROM WalletAccount WHERE ("ownerId" = ? AND "ownerType" = 'project') OR ("ownerType" <> 'project') ORDER BY "code" ASC`,
            )
            .all(where.OR[0].ownerId)
            .map(toWalletRow)
        }
        throw new Error(`stub: unsupported walletAccount.findMany where ${JSON.stringify(where)}`)
      },
    },
    __sqlite: sqlite,
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { centsToKes } from '@/backend/lib/money'
import { accountSideSums, derivedBalance } from '@/backend/modules/ledger/service'
import { listWallets } from '@/backend/modules/wallet/service'

const sqlite = (db as unknown as { __sqlite: Database.Database }).__sqlite

// ---------------------------------------------------------------- seeding

/** Deterministic PRNG (fixed seed): a failure replays identically. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260918)
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
/** 1 cent .. 10^14 cents — deep into i64 territory, far past double safety. */
const randCents = () => BigInt(randInt(1, 100_000_000_000_000))

const KINDS = ['asset', 'liability', 'revenue', 'expense', 'equity'] as const

interface SeededEntry {
  side: 'debit' | 'credit'
  amount: bigint
}
interface SeededAccount {
  id: string
  code: string
  kind: string
  ownerType: string
  ownerId: string | null
  entries: SeededEntry[]
}
interface SeededWallet {
  id: string
  code: string
  label: string
  ownerType: string
  ownerId: string | null
  createdAt: Date
}

const insAccount = () =>
  sqlite.prepare(
    `INSERT INTO LedgerAccount (id, code, name, kind, normalSide, projectId, ownerType, ownerId, active, createdAt) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, CURRENT_TIMESTAMP)`,
  )
const insTxn = () =>
  sqlite.prepare(
    `INSERT INTO LedgerTransaction (id, ref, description, occurredAt, postedBy, postedRole, status, createdAt) VALUES (?, ?, 'property test', CURRENT_TIMESTAMP, 'test', 'system', 'pending', CURRENT_TIMESTAMP)`,
  )
const insEntry = () =>
  sqlite.prepare(`INSERT INTO LedgerEntry (id, txnId, accountId, side, amount, createdAt) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
const insWallet = () =>
  sqlite.prepare(
    `INSERT INTO WalletAccount (id, code, label, ownerType, ownerId, currency, status, ledgerAccountId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 'KES', 'active', NULL, ?, ?)`,
  )
/** Fixed wallet timestamps (no CURRENT_TIMESTAMP) — the stub's Date parse and
 * the reference's must be byte-identical across timezones. */
const WALLET_TS = '2026-01-01T00:00:00'

/** Wipe the ledger/wallet tables (maintenance flag lifts the append-only guards). */
function resetTables() {
  sqlite.exec('INSERT OR REPLACE INTO LedgerMaintenance (id, allow) VALUES (1, 1)')
  sqlite.exec('DELETE FROM LedgerEntry; DELETE FROM LedgerTransaction; DELETE FROM LedgerAccount; DELETE FROM WalletAccount;')
  sqlite.exec('DELETE FROM LedgerMaintenance')
}

/**
 * Seed one random case: N accounts (all kinds, some wallet-owned), 0–40
 * entries each; wallet rows for MOST wallet-owned accounts (some wallets
 * deliberately have no account, some accounts no wallet — both null paths).
 */
function seedCase(caseNo: number): { accounts: SeededAccount[]; wallets: SeededWallet[] } {
  resetTables()
  const accounts: SeededAccount[] = []
  const wallets: SeededWallet[] = []
  const nAccounts = randInt(1, 8)
  let txnSeq = 0
  let entrySeq = 0
  let walletSeq = 0
  for (let i = 0; i < nAccounts; i++) {
    const id = `acct-${caseNo}-${i}`
    const kind = KINDS[randInt(0, KINDS.length - 1)]
    const walletOwned = rand() < 0.6
    // Wallet-owned accounts get a UNIQUE ownerId (one account per wallet —
    // the production shape; listWallets' `find` stays unambiguous).
    const ownerId = walletOwned ? `w-${caseNo}-${i}` : rand() < 0.5 ? `p-${caseNo}` : null
    const code = `ACC:${id}`
    insAccount().run(id, code, `Account ${i}`, kind, kind === 'asset' || kind === 'expense' ? 'debit' : 'credit', walletOwned ? 'wallet' : 'project', ownerId)
    const entries: SeededEntry[] = []
    const nEntries = randInt(0, 40)
    for (let j = 0; j < nEntries; j++) {
      const txnId = `txn-${caseNo}-${txnSeq++}`
      insTxn().run(txnId, `LX-${txnId}`)
      const side: 'debit' | 'credit' = rand() < 0.5 ? 'debit' : 'credit'
      const amount = randCents()
      insEntry().run(`e-${caseNo}-${entrySeq++}`, txnId, id, side, amount)
      entries.push({ side, amount })
    }
    accounts.push({ id, code, kind, ownerType: walletOwned ? 'wallet' : 'project', ownerId, entries })
    if (walletOwned && rand() < 0.8) {
      const walletId = ownerId as string
      const code2 = `W-${String(++walletSeq).padStart(4, '0')}`
      const ownerType = rand() < 0.7 ? 'project' : 'organization'
      const walletOwnerId = ownerType === 'project' ? `p-${caseNo}` : null
      insWallet().run(walletId, code2, `Wallet ${code2}`, ownerType, walletOwnerId, WALLET_TS, WALLET_TS)
      wallets.push({ id: walletId, code: code2, label: `Wallet ${code2}`, ownerType, ownerId: walletOwnerId, createdAt: new Date(WALLET_TS) })
    }
  }
  // A wallet with NO backing account (ledgerAccountCode null path).
  if (rand() < 0.5) {
    const walletId = `w-${caseNo}-orphan`
    const code2 = `W-${String(++walletSeq).padStart(4, '0')}`
    insWallet().run(walletId, code2, `Wallet ${code2}`, 'organization', null, WALLET_TS, WALLET_TS)
    wallets.push({ id: walletId, code: code2, label: `Wallet ${code2}`, ownerType: 'organization', ownerId: null, createdAt: new Date(WALLET_TS) })
  }
  return { accounts, wallets }
}

// ---------------------------------------------------- the reference (old) math

/** The pre-#144 derivedBalance, verbatim: load every entry, reduce in JS. */
function referenceDerivedBalance(kind: string, entries: SeededEntry[]): bigint {
  const debit = entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0n)
  const credit = entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0n)
  return kind === 'asset' || kind === 'expense' ? debit - credit : credit - debit
}

/** The pre-#144 listWallets, verbatim: all wallet accounts + entries, reduce. */
function referenceListWallets(projectId: string | undefined, accounts: SeededAccount[], wallets: SeededWallet[]) {
  const walletAccounts = accounts.filter((a) => a.ownerType === 'wallet')
  return [...wallets]
    .filter((w) =>
      projectId ? (w.ownerId === projectId && w.ownerType === 'project') || w.ownerType !== 'project' : true,
    )
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((w) => {
      const account = walletAccounts.find((a) => a.ownerId === w.id)
      const debit = account ? account.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0n) : 0n
      const credit = account ? account.entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0n) : 0n
      return {
        id: w.id,
        code: w.code,
        label: w.label,
        ownerType: w.ownerType,
        ownerId: w.ownerId,
        currency: 'KES',
        status: 'active',
        ledgerAccountCode: account?.code ?? null,
        balance: centsToKes(credit - debit),
        createdAt: w.createdAt.toISOString(),
      }
    })
}

// ---------------------------------------------------------------- the tests

beforeEach(() => {
  resetTables()
})

describe('property: SQL SUM balance ≡ the old in-JS reduce (issue #144)', () => {
  const CASES = 150

  it(`derivedBalance (real service, real SQLite SUM) equals the reference reduce on ${CASES} random cases, every account kind`, async () => {
    for (let caseNo = 0; caseNo < CASES; caseNo++) {
      const { accounts } = seedCase(caseNo)
      for (const a of accounts) {
        const expected = referenceDerivedBalance(a.kind, a.entries)
        const got = await derivedBalance(a.code)
        expect(got, `case ${caseNo}: account ${a.code} (${a.kind}, ${a.entries.length} entries)`).toBe(expected)
      }
    }
  })

  it(`accountSideSums (the wallet ops' in-tx re-check) returns the reference Σdebit/Σcredit on ${CASES} random cases`, async () => {
    for (let caseNo = 0; caseNo < CASES; caseNo++) {
      const { accounts } = seedCase(1000 + caseNo)
      for (const a of accounts) {
        const expectedDebit = a.entries.filter((e) => e.side === 'debit').reduce((s, e) => s + e.amount, 0n)
        const expectedCredit = a.entries.filter((e) => e.side === 'credit').reduce((s, e) => s + e.amount, 0n)
        const got = await accountSideSums(db, a.id)
        expect(got.debit, `case ${caseNo}: Σdebit of ${a.code}`).toBe(expectedDebit)
        expect(got.credit, `case ${caseNo}: Σcredit of ${a.code}`).toBe(expectedCredit)
      }
    }
  })

  it(`listWallets (one grouped aggregate) matches the old include-entries reduce row-for-row, unscoped and project-scoped`, async () => {
    for (let caseNo = 0; caseNo < CASES; caseNo++) {
      const { accounts, wallets } = seedCase(2000 + caseNo)
      // Unscoped (finance/admin v1 route).
      expect(await listWallets(), `case ${caseNo}: unscoped list`).toEqual(referenceListWallets(undefined, accounts, wallets))
      // Project-scoped (the OR shape the route passes verbatim).
      expect(await listWallets(`p-${caseNo}`), `case ${caseNo}: project-scoped list`).toEqual(
        referenceListWallets(`p-${caseNo}`, accounts, wallets),
      )
    }
  })

  it('edge cases: empty history, single-sided, debit-heavy, unknown code, ceiling amounts', async () => {
    resetTables()
    insAccount().run('a-empty', 'ACC:EMPTY', 'Empty', 'liability', 'credit', 'project', 'p-x')
    insAccount().run('a-debit-only', 'ACC:DEBIT_ONLY', 'DebitOnly', 'asset', 'debit', 'project', 'p-x')
    insAccount().run('a-credit-only', 'ACC:CREDIT_ONLY', 'CreditOnly', 'revenue', 'credit', 'project', 'p-x')
    insAccount().run('a-huge', 'ACC:HUGE', 'Huge', 'liability', 'credit', 'project', 'p-x')
    insTxn().run('t-1', 'LX-T1')
    insEntry().run('e-1', 't-1', 'a-debit-only', 'debit', 9_000_000_000_000n)
    insTxn().run('t-2', 'LX-T2')
    insEntry().run('e-2', 't-2', 'a-credit-only', 'credit', 12_345_678_901_234n)
    // Ceiling stress: 40 × 9×10^12 cents ≈ 3.6×10^14 — far past double
    // precision, trivially inside i64. SQL SUM must stay EXACT.
    insTxn().run('t-3', 'LX-T3')
    for (let i = 0; i < 40; i++) insEntry().run(`e-3-${i}`, 't-3', 'a-huge', 'credit', 9_000_000_000_000n)

    expect(await derivedBalance('ACC:EMPTY')).toBe(0n)
    expect(await derivedBalance('ACC:DEBIT_ONLY')).toBe(9_000_000_000_000n) // asset: debit − credit
    expect(await derivedBalance('ACC:CREDIT_ONLY')).toBe(12_345_678_901_234n) // revenue: credit − debit
    expect(await derivedBalance('ACC:HUGE')).toBe(360_000_000_000_000n) // 40 × 9×10^12, exact
    expect(await derivedBalance('ACC:NO_SUCH_ACCOUNT')).toBe(0n) // unknown account: honest zero, no throw
  })

  it('one aggregate per balance: derivedBalance issues exactly one ledgerEntry.groupBy (call-count pin)', async () => {
    // Structural pin of the "constant memory" claim: derivedBalance resolves
    // the account row, then issues EXACTLY ONE grouped aggregate scoped to
    // that account. If someone reintroduces a row-loading path (findMany /
    // include entries), this fails before any latency regression shows up.
    const { accounts } = seedCase(3000)
    const account = accounts[0]
    const groupBySpy = vi.spyOn(db.ledgerEntry, 'groupBy')
    try {
      await derivedBalance(account.code)
      expect(groupBySpy).toHaveBeenCalledTimes(1)
      expect((groupBySpy.mock.calls[0][0] as { where: { accountId: string } }).where.accountId).toBe(account.id)
    } finally {
      groupBySpy.mockRestore()
    }
  })
})
