/**
 * /api/v1 — the WALLET family REST contract (issue #69, test wave 2):
 *   GET  /api/v1/wallets                    list (paginated) / provider rails
 *   POST /api/v1/wallets                    create (project vs platform scope)
 *   GET  /api/v1/wallets/:id                detail (id or code, ledger-derived)
 *   GET  /api/v1/wallets/:id/balance        the DERIVED balance + its meaning
 *   GET  /api/v1/wallets/:id/transactions   TRUE keyset pagination (the unbounded list)
 *   POST /api/v1/wallets/:id/deposit        credit from a cash rail
 *   POST /api/v1/wallets/:id/withdraw       debit into a cash rail
 *   POST /api/v1/wallets/:id/transfer       wallet→wallet, same-wallet 422
 *
 * Pinned invariants:
 *   · ROLE SCOPING — the whole family is FINANCE_ROLES (finance + admin);
 *     every other signed-in role answers 403 'Not permitted for role "x"'
 *     before any flag/db/service work. Anonymous → 401 'Sign in required'.
 *   · WALLET FLAG GATE — the uniform rule: flag OFF + non-admin → 403
 *     'Feature disabled by feature flag (wallet) — …' and the service/db
 *     seams are NEVER invoked (each read + each mutation pinned); admins
 *     bypass; flag ON → the routes behave normally (gate is additive).
 *   · CURSOR PAGINATION — the wallet LIST is bounded (route-layer pageOf:
 *     deterministic slices, no overlap, nextCursor null on the last page,
 *     a cursor outside the list → 400 { field: 'cursor' }); the TRANSACTIONS
 *     list is the unbounded keyset one ((occurredAt DESC, id DESC) asked of
 *     the db verbatim, take = limit+1, pages stable under inserts at the
 *     head, a cursor that is not a txn of THIS wallet's account → 400).
 *   · ERROR SHAPES — one { error, field? } contract: 400 zod strictObject
 *     (unknown keys listed by name, honest bounds), 401 anonymous, 403 role/
 *     flag, 404 the not-found message family ('Wallet not found', 'Wallet
 *     belongs to a different project'), 422 same-wallet transfer, 400
 *     business messages passed through by mapServiceError, 500 only for
 *     non-Error failures (with a server log).
 *   · IDEMPOTENCY (real modules/wallet/http.ts over the db stub): a repeated
 *     Idempotency-Key replays the stored body with { replayed: true, scope },
 *     never re-running the service; failures are never recorded (retry stays
 *     possible); the flag gate and the 422 guard fire BEFORE the record.
 *   · ENVELOPE — every success is { ok: true, data, …extra } (jsonOk); the
 *     list carries nextCursor/hasMore TOP-LEVEL, the transactions page
 *     carries them INSIDE data (documented divergence — the array key stays
 *     `transactions`).
 *   · HONEST MONEY SEMANTICS — deposits post into the wallet's OWNING
 *     project's ledger scope even without an explicit projectId; balances
 *     are derived (never stored — the balance route says how, verbatim).
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control), '@/backend/lib/db' (featureFlag rows + the transactions route's
 * ledger reads + idempotencyRecord for the REAL withIdempotency), and
 * '@/backend/modules/wallet/service' (the service seams). route-kit,
 * rate-limit, flags, respond/schemas, modules/wallet/http (jsonOk +
 * withIdempotency) and the provider registry stay REAL — the provider-rail
 * introspection therefore serves the actual five rails. NEXT_FLAGS_OFF +
 * invalidateFlagCache() control the flag state; DARAJA_* env keys are wiped
 * so getProvider('mpesa') deterministically fail-closes to the simulated rail.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

// ---------------------------------------------------------------- db stub

type EntryRow = { id: string; txnId: string; accountId: string; side: 'debit' | 'credit'; amount: number; memo: string | null }
type TxnRow = { id: string; ref: string; description: string; occurredAt: Date; status: string; postedBy: string; postedRole: string; entries: EntryRow[] }
type AccountRow = { id: string; code: string; ownerType: string; ownerId: string }
type DbState = {
  flagRows: Array<{ key: string; enabled: boolean; description: string }>
  accounts: AccountRow[]
  txnRows: TxnRow[]
  idemRows: Array<Record<string, unknown>>
  lastTxnQuery: { where?: unknown; orderBy?: unknown; take?: number } | null
}

vi.mock('@/backend/lib/db', () => {
  const state: DbState = {
    flagRows: [
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
      { key: 'ai_voice', enabled: true, description: 'AI voice' },
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
    ],
    accounts: [],
    txnRows: [],
    idemRows: [],
    lastTxnQuery: null,
  }
  // Prisma `include: { entries: { include: { account: true } } }` shape.
  const withAccounts = (t: TxnRow) => ({
    ...t,
    entries: t.entries.map((e) => ({ ...e, account: state.accounts.find((a) => a.id === e.accountId) ?? null })),
  })
  const db = {
    __state: state,
    featureFlag: {
      async upsert() { /* rows exist; lazy creation is a no-op here */ },
      async findMany({ where }: { where?: { key?: { in?: string[] } } }) {
        const keys = where?.key?.in
        return state.flagRows.filter((r) => !keys || keys.includes(r.key)).map((r) => ({ ...r }))
      },
      async update() { throw new Error('not used here') },
    },
    ledgerAccount: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        structuredClone(state.accounts.find((a) => a.id === where.id) ?? null)),
    },
    ledgerTransaction: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = state.txnRows.find((t) => t.id === where.id)
        return row ? structuredClone(withAccounts(row)) : null
      }),
      findMany: vi.fn(
        async (args: { where?: Record<string, any>; orderBy?: unknown; take?: number }) => {
          state.lastTxnQuery = args
          const where = args?.where ?? {}
          const accountId = where.entries?.some?.accountId as string
          let rows = state.txnRows.filter((t) => t.entries.some((e) => e.accountId === accountId))
          // The route's keyset boundary: OR [{occurredAt: {lt}}, {occurredAt, id: {lt}}]
          if (Array.isArray(where.OR)) {
            const ltAt = where.OR[0].occurredAt.lt as Date
            const eqAt = where.OR[1].occurredAt as Date
            const idLt = where.OR[1].id.lt as string
            rows = rows.filter(
              (t) => t.occurredAt < ltAt || (t.occurredAt.getTime() === eqAt.getTime() && t.id < idLt),
            )
          }
          const sorted = [...rows].sort((a, b) =>
            b.occurredAt.valueOf() - a.occurredAt.valueOf() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
          )
          return sorted.slice(0, args?.take ?? 100).map((t) => structuredClone(withAccounts(t)))
        },
      ),
    },
    ledgerEntry: {
      findFirst: vi.fn(async ({ where }: { where: { txnId: string; accountId: string } }) => {
        const touches = state.txnRows
          .find((t) => t.id === where.txnId)
          ?.entries.some((e) => e.accountId === where.accountId)
        return touches ? { id: 'le-found' } : null
      }),
    },
    idempotencyRecord: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        (state.idemRows.find((r) => r.key === where.key) as Record<string, unknown> | undefined) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.idemRows.push({ ...data })
        return { ...data }
      }),
    },
  }
  return { db }
})

// Full fake guard (the flags-gating idiom — mirrors guard.ts 1:1).
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const FINANCE_ROLES = ['finance', 'admin']
  const PAYMENT_ROLES = ['finance', 'admin', 'client']
  const KNOWN_ROLES = ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs']
  const OWNER_ROLES = ['contractor', 'admin', 'supervisor', 'procurement', 'qs', 'finance']
  const getSessionFromReq = vi.fn(async () => h.session)
  return {
    getSessionFromReq,
    unauthorized: () => NextResponse.json({ error: 'Sign in required' }, { status: 401 }),
    forbidden: (role?: string) =>
      NextResponse.json({ error: role ? `Not permitted for role "${role}"` : 'Not permitted' }, { status: 403 }),
    withGuard:
      (handler: (req: NextRequest, session: unknown, ctx: unknown) => unknown, opts?: { roles?: readonly string[] }) =>
      async (req: NextRequest, ctx: unknown) => {
        const session = await getSessionFromReq(req)
        if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
        if (opts?.roles && !opts.roles.includes(session.user.role)) {
          return NextResponse.json({ error: `Not permitted for role "${session.user.role}"` }, { status: 403 })
        }
        return handler(req, session, ctx)
      },
    safeErrorMessage: (e: unknown, fallback: string) =>
      e instanceof Error && !e.message.includes('\n') ? e.message : fallback,
    isInternalError: (e: unknown) => e instanceof Error && e.message.includes('\n'),
    FINANCE_ROLES,
    PAYMENT_ROLES,
    KNOWN_ROLES,
    OWNER_ROLES,
  }
})

// The wallet service seams (aggregations/ledger writes — pinned by the
// module's own tests; here they are controlled per test).
const svc = vi.hoisted(() => ({
  listWallets: vi.fn(),
  createWallet: vi.fn(),
  walletWithBalance: vi.fn(),
  depositWallet: vi.fn(),
  withdrawWallet: vi.fn(),
  transferWallet: vi.fn(),
}))
vi.mock('@/backend/modules/wallet/service', () => svc)

// modules/wallet/http (jsonOk + withIdempotency) stays REAL — its replay
// semantics are pinned here over the db stub (flags-gating mocks them out).

import { db } from '@/backend/lib/db'
import { GET as walletsGet, POST as walletsCreate } from '@/app/api/v1/wallets/route'
import { GET as walletDetailGet } from '@/app/api/v1/wallets/[id]/route'
import { GET as walletBalanceGet } from '@/app/api/v1/wallets/[id]/balance/route'
import { GET as walletTxnsGet } from '@/app/api/v1/wallets/[id]/transactions/route'
import { POST as walletDepositPost } from '@/app/api/v1/wallets/[id]/deposit/route'
import { POST as walletWithdrawPost } from '@/app/api/v1/wallets/[id]/withdraw/route'
import { POST as walletTransferPost } from '@/app/api/v1/wallets/[id]/transfer/route'
import { PROVIDER_METHODS } from '@/backend/modules/wallet/providers'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'

const dbStub = () =>
  db as unknown as {
    __state: DbState
    idempotencyRecord: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
    ledgerAccount: { findUnique: ReturnType<typeof vi.fn> }
  }
const state = () => dbStub().__state

function sessionFor(role: string, projectId: string | null = null) {
  h.session = { user: { id: `u-${role}`, email: `${role}@test.dev`, name: role, role, projectId } }
}

function getReq(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: { 'content-type': 'application/json' } })
}

function jsonReq(url: string, method: 'GET' | 'POST', body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>
}

// ---------------------------------------------------------------- fixtures

/** listWallets rows — the service's exact summary shape (spec §38). */
const WALLETS = [
  { id: 'w-1', code: 'W-0001', label: 'Riverside main', ownerType: 'project', ownerId: 'p-1', currency: 'KES', status: 'active', ledgerAccountCode: 'WALLET:W-0001', balance: 1_450, createdAt: '2026-01-05T09:00:00.000Z' },
  { id: 'w-2', code: 'W-0002', label: 'Westlands float', ownerType: 'project', ownerId: 'p-2', currency: 'KES', status: 'active', ledgerAccountCode: 'WALLET:W-0002', balance: 0, createdAt: '2026-01-06T09:00:00.000Z' },
  { id: 'w-3', code: 'W-0003', label: 'Organization float', ownerType: 'organization', ownerId: 'org-1', currency: 'KES', status: 'active', ledgerAccountCode: 'WALLET:W-0003', balance: 500, createdAt: '2026-01-07T09:00:00.000Z' },
  { id: 'w-4', code: 'W-0004', label: 'Karioke supplier', ownerType: 'supplier', ownerId: 'sup-9', currency: 'KES', status: 'active', ledgerAccountCode: 'WALLET:W-0004', balance: 25, createdAt: '2026-01-08T09:00:00.000Z' },
  { id: 'w-5', code: 'W-0005', label: 'Nyali main', ownerType: 'project', ownerId: 'p-3', currency: 'KES', status: 'active', ledgerAccountCode: 'WALLET:W-0005', balance: 80, createdAt: '2026-01-09T09:00:00.000Z' },
  { id: 'w-6', code: 'W-0006', label: 'User wallet', ownerType: 'user', ownerId: 'usr-2', currency: 'KES', status: 'active', ledgerAccountCode: 'WALLET:W-0006', balance: 12, createdAt: '2026-01-10T09:00:00.000Z' },
]

/** walletWithBalance's wallet row — owner of p-1, backed by account la-1. */
const WALLET = {
  id: 'w-1', code: 'W-0001', label: 'Riverside main', ownerType: 'project', ownerId: 'p-1',
  currency: 'KES', status: 'active', ledgerAccountId: 'la-1',
}

const ACCOUNTS: AccountRow[] = [
  { id: 'la-1', code: 'WALLET:W-0001', ownerType: 'wallet', ownerId: 'w-1' },
  { id: 'la-2', code: 'WALLET:W-0002', ownerType: 'wallet', ownerId: 'w-2' },
  { id: 'la-mpesa', code: 'CASH:MPESA', ownerType: 'cash', ownerId: '' },
  { id: 'la-bank', code: 'CASH:BANK', ownerType: 'cash', ownerId: '' },
  { id: 'la-wages', code: 'WAGES:LABOR', ownerType: 'expense', ownerId: '' },
]

type Leg = [accountId: string, side: 'debit' | 'credit', amount: number, memo: string | null]
const TX = (id: string, ref: string, description: string, occurredAt: string, legs: Leg[]): TxnRow => ({
  id, ref, description, occurredAt: new Date(occurredAt), status: 'posted', postedBy: 'Finance', postedRole: 'finance',
  entries: legs.map(([accountId, side, amount, memo], i) => ({ id: `le-${id}-${i}`, txnId: id, accountId, side, amount, memo })),
})

/**
 * Ledger fixtures for W-0001's account (la-1): lt-1, lt-3, lt-4, lt-5 touch
 * it; lt-2 belongs to the OTHER wallet (la-2) — the foreign-cursor case.
 * lt-3 and lt-4 share occurredAt so the id DESC tiebreak is exercised.
 */
const TXN_ROWS: TxnRow[] = [
  TX('lt-1', 'LT-0001', 'Wallet W-0001 deposit', '2026-01-10T10:00:00Z', [
    ['la-mpesa', 'debit', 500, 'M-Pesa top-up'],
    ['la-1', 'credit', 500, null],
  ]),
  TX('lt-2', 'LT-0002', 'Wallet W-0002 deposit', '2026-01-11T10:00:00Z', [
    ['la-mpesa', 'debit', 90, null],
    ['la-2', 'credit', 90, null],
  ]),
  TX('lt-3', 'LT-0003', 'Wallet W-0001 withdrawal', '2026-01-12T10:00:00Z', [
    ['la-1', 'debit', 300, 'Fuel'],
    ['la-mpesa', 'credit', 300, null],
  ]),
  TX('lt-4', 'LT-0004', 'Wages paid from W-0001', '2026-01-12T10:00:00Z', [
    ['la-1', 'debit', 200, 'Wages'],
    ['la-wages', 'credit', 200, null],
  ]),
  TX('lt-5', 'LT-0005', 'Wallet W-0001 bank deposit', '2026-01-14T10:00:00Z', [
    ['la-bank', 'debit', 750, 'Bank transfer in'],
    ['la-1', 'credit', 750, null],
  ]),
]

/** Expected W-0001 page order: occurredAt DESC, id DESC (lt-4 wins the tie). */
const W1_ORDER = ['lt-5', 'lt-4', 'lt-3', 'lt-1']

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  for (const k of Object.keys(process.env)) if (k.startsWith('DARAJA_')) delete process.env[k]
  invalidateFlagCache()
  const s = state()
  s.accounts = ACCOUNTS.map((a) => ({ ...a }))
  s.txnRows = TXN_ROWS.map((t) => ({
    ...t, occurredAt: new Date(t.occurredAt), entries: t.entries.map((e) => ({ ...e })),
  }))
  s.idemRows = []
  s.lastTxnQuery = null
  // Service defaults (per-test overrides make each case self-describing).
  svc.listWallets.mockResolvedValue(WALLETS.map((w) => ({ ...w })))
  svc.createWallet.mockResolvedValue({ id: 'w-7', code: 'W-0007', ledgerAccount: 'WALLET:W-0007', balance: 0 })
  svc.walletWithBalance.mockImplementation(async (projectId: string, idOrCode: string) => {
    if (idOrCode !== 'w-1' && idOrCode !== 'W-0001') throw new Error('Wallet not found')
    if (projectId === 'p-2') throw new Error('Wallet belongs to a different project')
    return { wallet: { ...WALLET }, balance: 1_450 }
  })
  svc.depositWallet.mockResolvedValue({ walletCode: 'W-0001', ledgerRef: 'LT-0006', balance: 2_450 })
  svc.withdrawWallet.mockResolvedValue({ ledgerRef: 'LT-0007', balance: 1_050 })
  svc.transferWallet.mockResolvedValue({ ledgerRef: 'LT-0008', balance: 1_200 })
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

// ---------------------------------------------------------------- list: roles + envelope

describe('GET /api/v1/wallets — FINANCE_ROLES scoping + envelope', () => {
  it('finance → 200: items are the service rows verbatim, pagination top-level', async () => {
    sessionFor('finance')
    const res = await walletsGet(getReq('http://localhost/api/v1/wallets'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(Object.keys(body).sort()).toEqual(['data', 'hasMore', 'nextCursor', 'ok'])
    expect(body.ok).toBe(true)
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
    expect(body.data).toEqual(WALLETS)
    expect((body.data as Array<Record<string, unknown>>)[0]).toMatchObject({ code: 'W-0001', balance: 1_450 })
  })

  it.each(['contractor', 'client', 'supervisor', 'procurement', 'qs'])(
    '%s (non-finance role) → 403 "Not permitted for role", nothing invoked',
    async (role) => {
      sessionFor(role)
      const res = await walletsGet(getReq('http://localhost/api/v1/wallets'))
      expect(res.status).toBe(403)
      expect(await bodyOf(res)).toEqual({ error: `Not permitted for role "${role}"` })
      expect(svc.listWallets).not.toHaveBeenCalled()
    },
  )

  it('anonymous → 401 { error: "Sign in required" }', async () => {
    const res = await walletsGet(getReq('http://localhost/api/v1/wallets'))
    expect(res.status).toBe(401)
    expect(await bodyOf(res)).toEqual({ error: 'Sign in required' })
  })

  it('?projectId=p-1 is passed to listWallets verbatim (project filter)', async () => {
    sessionFor('finance')
    const res = await walletsGet(getReq('http://localhost/api/v1/wallets?projectId=p-1'))
    expect(res.status).toBe(200)
    expect(svc.listWallets).toHaveBeenCalledWith('p-1')
  })

  it('no ?projectId → listWallets called with undefined (the unscoped finance read)', async () => {
    sessionFor('finance')
    await walletsGet(getReq('http://localhost/api/v1/wallets'))
    expect(svc.listWallets).toHaveBeenCalledWith(undefined)
  })
})

// ---------------------------------------------------------------- list: cursor pagination

describe('GET /api/v1/wallets — bounded cursor pagination (route-layer pageOf)', () => {
  it('limit=2 walks all 6 wallets in 3 stable pages, no overlap, ordered', async () => {
    sessionFor('finance')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const url = `http://localhost/api/v1/wallets?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await bodyOf(await walletsGet(getReq(url)))
      seen.push(...(body.data as Array<{ id: string }>).map((w) => w.id))
      pages++
      expect(body.hasMore).toBe(pages < 3)
      cursor = (body.nextCursor as string | null) ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual(['w-1', 'w-2', 'w-3', 'w-4', 'w-5', 'w-6'])
    expect(new Set(seen).size).toBe(6)
  })

  it('the page token round-trips: nextCursor of page 1 opens page 2 exactly', async () => {
    sessionFor('finance')
    const page1 = await bodyOf(await walletsGet(getReq('http://localhost/api/v1/wallets?limit=2')))
    expect(page1.nextCursor).toBe('w-2')
    const page2 = await bodyOf(
      await walletsGet(getReq(`http://localhost/api/v1/wallets?limit=2&cursor=${page1.nextCursor}`)),
    )
    expect((page2.data as Array<{ id: string }>).map((w) => w.id)).toEqual(['w-3', 'w-4'])
  })

  it('a cursor AT the end → empty page, hasMore false, nextCursor null (not 400)', async () => {
    sessionFor('finance')
    const body = await bodyOf(await walletsGet(getReq('http://localhost/api/v1/wallets?limit=2&cursor=w-6')))
    expect(body.data).toEqual([])
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('a cursor outside the list → 400 naming the wallet noun', async () => {
    sessionFor('finance')
    const res = await walletsGet(getReq('http://localhost/api/v1/wallets?cursor=w-x'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/Unknown cursor — it must be the id of a wallet in this list/)
    expect(body.field).toBe('cursor')
  })
})

// ---------------------------------------------------------------- list: provider rails

describe('GET /api/v1/wallets?providers=1 — payment-rail introspection', () => {
  it('serves the REAL registry: every PROVIDER_METHODS rail with its honest note', async () => {
    sessionFor('finance')
    const body = await bodyOf(await walletsGet(getReq('http://localhost/api/v1/wallets?providers=1')))
    expect(body.ok).toBe(true)
    const rails = body.data as Array<Record<string, string>>
    expect(rails.map((r) => r.method)).toEqual([...PROVIDER_METHODS])
    for (const rail of rails) {
      expect(rail.provider).toBe(rail.method)
      expect(rail.label.length).toBeGreaterThan(0)
      expect(rail.integrationNote.length).toBeGreaterThan(0)
    }
    expect(body.nextCursor).toBeUndefined() // static surface: no pagination keys
    expect(body.hasMore).toBeUndefined()
    expect(svc.listWallets).not.toHaveBeenCalled()
  })

  it('the simulated default is honest: no licensed-provider claim', async () => {
    sessionFor('finance')
    const rails = (await bodyOf(await walletsGet(getReq('http://localhost/api/v1/wallets?providers=1'))))
      .data as Array<Record<string, string>>
    const mpesa = rails.find((r) => r.method === 'mpesa')!
    expect(mpesa.integrationNote).toMatch(/Simulated rail — no licensed provider is integrated/)
    const walletRail = rails.find((r) => r.method === 'wallet')!
    expect(walletRail.label).toMatch(/Escrow wallet/)
    expect(walletRail.integrationNote).toMatch(/Internal ledger movement/)
  })

  it('pagination does not apply to the static rail surface (documented)', async () => {
    sessionFor('finance')
    const body = await bodyOf(await walletsGet(getReq('http://localhost/api/v1/wallets?providers=1&limit=1')))
    expect((body.data as unknown[]).length).toBe(PROVIDER_METHODS.length)
  })
})

// ---------------------------------------------------------------- list: query validation

describe('GET /api/v1/wallets — query validation (zod strictObject)', () => {
  it('unknown query keys are rejected by name (typo protection)', async () => {
    sessionFor('finance')
    const res = await walletsGet(getReq('http://localhost/api/v1/wallets?walletId=w-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "walletId"' })
  })

  it('limit/cursor bounds are honest: 0, 201, non-integer, empty cursor, long cursor', async () => {
    sessionFor('finance')
    for (const [qs, message, field] of [
      ['limit=0', 'limit must be between 1 and 200', 'limit'],
      ['limit=201', 'limit must be between 1 and 200', 'limit'],
      ['limit=1.5', 'limit must be an integer', 'limit'],
      ['limit=abc', 'limit must be a number', 'limit'],
      ['cursor=', 'cursor must not be empty', 'cursor'],
      [`cursor=${'x'.repeat(41)}`, 'cursor must be at most 40 characters', 'cursor'],
    ] as Array<[string, string, string]>) {
      const res = await walletsGet(getReq(`http://localhost/api/v1/wallets?${qs}`))
      expect(res.status, qs).toBe(400)
      const body = await bodyOf(res)
      expect((body.error as string).startsWith(message), qs).toBe(true)
      expect(body.field, qs).toBe(field)
    }
  })

  it('providers must be exactly "1"; projectId must be non-empty ≤40', async () => {
    sessionFor('finance')
    const providers = await walletsGet(getReq('http://localhost/api/v1/wallets?providers=2'))
    expect(providers.status).toBe(400)
    expect((await bodyOf(providers)).field).toBe('providers')

    const emptyProject = await walletsGet(getReq('http://localhost/api/v1/wallets?projectId='))
    expect(emptyProject.status).toBe(400)
    expect((await bodyOf(emptyProject)).field).toBe('projectId')

    const longProject = await walletsGet(getReq(`http://localhost/api/v1/wallets?projectId=${'p'.repeat(41)}`))
    expect(longProject.status).toBe(400)
    expect((await bodyOf(longProject)).field).toBe('projectId')
  })
})

// ---------------------------------------------------------------- create

describe('POST /api/v1/wallets — create', () => {
  it('finance + body.projectId → createWallet(projectId, parsed body) with ownerType defaulted', async () => {
    sessionFor('finance')
    const res = await walletsCreate(
      jsonReq('http://localhost/api/v1/wallets', 'POST', { label: 'Site float', projectId: 'p-1' }),
    )
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: true, data: { id: 'w-7', code: 'W-0007', ledgerAccount: 'WALLET:W-0007', balance: 0 } })
    expect(svc.createWallet).toHaveBeenCalledWith('p-1', { label: 'Site float', ownerType: 'project', projectId: 'p-1' })
  })

  it('a project-bound session supplies the project (no body projectId needed)', async () => {
    sessionFor('finance', 'p-9')
    await walletsCreate(jsonReq('http://localhost/api/v1/wallets', 'POST', { label: 'Float' }))
    expect(svc.createWallet).toHaveBeenCalledWith('p-9', { label: 'Float', ownerType: 'project' })
  })

  it('project wallet with NO project anywhere → 400 { field: "projectId" }, createWallet never runs', async () => {
    sessionFor('finance') // no pinned project
    const res = await walletsCreate(jsonReq('http://localhost/api/v1/wallets', 'POST', { ownerType: 'project' }))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({
      error: 'projectId required for project wallets (body or a project-bound session)',
      field: 'projectId',
    })
    expect(svc.createWallet).not.toHaveBeenCalled()
  })

  it('organization wallet → platform scope: createWallet("platform"), idem record projectId null', async () => {
    sessionFor('finance')
    const res = await walletsCreate(
      jsonReq('http://localhost/api/v1/wallets', 'POST', { ownerType: 'organization', ownerId: 'org-1' }, { 'idempotency-key': 'create-1' }),
    )
    expect(res.status).toBe(200)
    expect(svc.createWallet).toHaveBeenCalledWith('platform', { ownerType: 'organization', ownerId: 'org-1' })
    const record = state().idemRows.find((r) => r.key === 'create-1')
    expect(record).toMatchObject({ scope: 'v1.wallet.create', projectId: null })
  })

  it('non-finance role → 403 before the body is even parsed', async () => {
    sessionFor('contractor')
    const res = await walletsCreate(jsonReq('http://localhost/api/v1/wallets', 'POST', { projectId: 'p-1' }))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for role "contractor"' })
    expect(svc.createWallet).not.toHaveBeenCalled()
  })

  it('body validation: unknown field, bad ownerType, empty label, non-KES currency', async () => {
    sessionFor('finance')
    for (const [body, message] of [
      [{ projectId: 'p-1', nam: 'x' }, 'Unknown field(s): "nam"'],
      [{ ownerType: 'team' }, 'ownerType must be one of project, organization, supplier, user'],
      [{ label: '  ' }, 'label must not be empty'],
      [{ projectId: 'p-1', currency: 'USD' }, 'currency must be "KES"'],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await walletsCreate(jsonReq('http://localhost/api/v1/wallets', 'POST', body))
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(((await bodyOf(res)).error as string).startsWith(message), JSON.stringify(body)).toBe(true)
      expect(svc.createWallet).not.toHaveBeenCalled()
    }
  })

  it('empty body → parsed as {} → the project-wallet rule answers (not a parse error)', async () => {
    sessionFor('finance')
    const res = await walletsCreate(jsonReq('http://localhost/api/v1/wallets', 'POST'))
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).field).toBe('projectId')
  })

  it('unparseable JSON → 400 "Invalid JSON body"; array body → 400 "Body must be a JSON object"', async () => {
    sessionFor('finance')
    const bad = await walletsCreate(
      new NextRequest('http://localhost/api/v1/wallets', { method: 'POST', body: '{oops', headers: { 'content-type': 'application/json' } }),
    )
    expect(bad.status).toBe(400)
    expect((await bodyOf(bad)).error).toBe('Invalid JSON body')
    const array = await walletsCreate(
      new NextRequest('http://localhost/api/v1/wallets', { method: 'POST', body: '[]', headers: { 'content-type': 'application/json' } }),
    )
    expect(array.status).toBe(400)
    expect((await bodyOf(array)).error).toBe('Body must be a JSON object')
  })
})

// ---------------------------------------------------------------- detail

describe('GET /api/v1/wallets/:id — detail', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/wallets/${id}${qs}`)

  it('200 — the wallet fields + the ledger-derived balance, field-for-field', async () => {
    sessionFor('finance')
    const res = await walletDetailGet(req('w-1'), ctx('w-1'))
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({
      ok: true,
      data: {
        id: 'w-1', code: 'W-0001', label: 'Riverside main', ownerType: 'project', ownerId: 'p-1',
        currency: 'KES', status: 'active', ledgerAccountId: 'la-1', balance: 1_450,
      },
    })
  })

  it('the wallet CODE is a first-class lookup path (W-0001 resolves)', async () => {
    sessionFor('finance')
    const res = await walletDetailGet(req('W-0001'), ctx('W-0001'))
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).data).toMatchObject({ id: 'w-1', code: 'W-0001' })
  })

  it('unknown wallet → 404 { error: "Wallet not found" } (mapServiceError not-found family)', async () => {
    sessionFor('finance')
    const res = await walletDetailGet(req('w-x'), ctx('w-x'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Wallet not found' })
  })

  it('a wallet of ANOTHER project (scoped ?projectId) → 404 "belongs to a different project"', async () => {
    sessionFor('finance')
    const res = await walletDetailGet(req('w-1', '?projectId=p-2'), ctx('w-1'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Wallet belongs to a different project' })
  })

  it('a malformed :id → 400 field "id", walletWithBalance never invoked', async () => {
    sessionFor('finance')
    for (const bad of ['w', 'w#1', 'x'.repeat(41)]) {
      const res = await walletDetailGet(req(bad), ctx(bad))
      expect(res.status, bad).toBe(400)
      const body = await bodyOf(res)
      expect(body.field).toBe('id')
      expect((body.error as string).startsWith('wallet reference must be 2-40 characters')).toBe(true)
    }
    expect(svc.walletWithBalance).not.toHaveBeenCalled()
  })

  it('the detail query accepts ONLY projectId (no pagination keys) — strictObject', async () => {
    sessionFor('finance')
    const res = await walletDetailGet(req('w-1', '?limit=5'), ctx('w-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "limit"' })
  })

  it('anonymous → 401', async () => {
    const res = await walletDetailGet(req('w-1'), ctx('w-1'))
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------- balance

describe('GET /api/v1/wallets/:id/balance — derived balance', () => {
  const req = (id: string) => getReq(`http://localhost/api/v1/wallets/${id}/balance`)

  it('200 — the balance plus its verbatim derivation sentence', async () => {
    sessionFor('finance')
    const res = await walletBalanceGet(req('w-1'), ctx('w-1'))
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({
      ok: true,
      data: {
        wallet: 'W-0001',
        currency: 'KES',
        balance: 1_450,
        derivation: 'ledger entries (debits − credits on the backing liability account)',
      },
    })
  })

  it('unknown wallet → 404 (same not-found family as the detail route)', async () => {
    sessionFor('finance')
    const res = await walletBalanceGet(req('w-x'), ctx('w-x'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Wallet not found' })
  })
})

// ---------------------------------------------------------------- transactions

describe('GET /api/v1/wallets/:id/transactions — keyset pagination (the unbounded list)', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/wallets/${id}/transactions${qs}`)

  it('200 — page shape: wallet block + balance + transactions, nextCursor/hasMore INSIDE data', async () => {
    sessionFor('finance')
    const res = await walletTxnsGet(req('w-1'), ctx('w-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(Object.keys(body).sort()).toEqual(['data', 'ok'])
    expect(Object.keys(body.data as object).sort()).toEqual(['balance', 'hasMore', 'nextCursor', 'transactions', 'wallet'])
    expect((body.data as Record<string, unknown>).wallet).toEqual({
      code: 'W-0001', label: 'Riverside main', ledgerAccount: 'WALLET:W-0001',
    })
    expect((body.data as Record<string, unknown>).balance).toBe(1_450)
  })

  it('deterministic order occurredAt DESC + id DESC (the shared-timestamp tiebreak)', async () => {
    sessionFor('finance')
    const body = await bodyOf(await walletTxnsGet(req('w-1'), ctx('w-1')))
    const items = (body.data as { transactions: Array<{ id: string }> }).transactions
    expect(items.map((t) => t.id)).toEqual(W1_ORDER)
  })

  it('the route asks the db for the keyset order verbatim, take = limit + 1', async () => {
    sessionFor('finance')
    await walletTxnsGet(req('w-1', '?limit=2'), ctx('w-1'))
    const q = state().lastTxnQuery
    expect(q).not.toBeNull()
    expect(q!.orderBy).toEqual([{ occurredAt: 'desc' }, { id: 'desc' }])
    expect(q!.take).toBe(3)
    expect((q!.where as Record<string, any>).entries).toEqual({ some: { accountId: 'la-1' } })
  })

  it('one mapped transaction, field-for-field: legs + Σ debit total', async () => {
    sessionFor('finance')
    const body = await bodyOf(await walletTxnsGet(req('w-1'), ctx('w-1')))
    const first = (body.data as { transactions: Array<Record<string, unknown>> }).transactions[0]
    expect(first).toEqual({
      id: 'lt-5',
      ref: 'LT-0005',
      description: 'Wallet W-0001 bank deposit',
      occurredAt: '2026-01-14T10:00:00.000Z',
      status: 'posted',
      postedBy: 'Finance',
      postedRole: 'finance',
      entries: [
        { accountCode: 'CASH:BANK', side: 'debit', amount: 750, memo: 'Bank transfer in' },
        { accountCode: 'WALLET:W-0001', side: 'credit', amount: 750, memo: null },
      ],
      total: 750,
    })
  })

  it('limit=2 pages walk all 4 W-0001 txns with no overlap; last page ends the walk', async () => {
    sessionFor('finance')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const url = `http://localhost/api/v1/wallets/w-1/transactions?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await bodyOf(await walletTxnsGet(getReq(url), ctx('w-1')))
      const data = body.data as { transactions: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean }
      seen.push(...data.transactions.map((t) => t.id))
      pages++
      expect(data.hasMore).toBe(pages < 2)
      cursor = data.nextCursor ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(2)
    expect(seen).toEqual(W1_ORDER)
    expect(new Set(seen).size).toBe(4)
  })

  it('pages are STABLE under inserts at the head (keyset, not offset)', async () => {
    sessionFor('finance')
    const page1 = await bodyOf(await walletTxnsGet(req('w-1', '?limit=2'), ctx('w-1')))
    const token = (page1.data as { nextCursor: string }).nextCursor
    // A brand-new head txn arrives between the two fetches.
    state().txnRows.push(
      TX('lt-6', 'LT-0006', 'Wallet W-0001 deposit', '2026-01-20T10:00:00Z', [
        ['la-mpesa', 'debit', 60, null],
        ['la-1', 'credit', 60, null],
      ]),
    )
    const page2 = await bodyOf(await walletTxnsGet(req('w-1', `?limit=2&cursor=${token}`), ctx('w-1')))
    expect((page2.data as { transactions: Array<{ id: string }> }).transactions.map((t) => t.id)).toEqual(['lt-3', 'lt-1'])
  })

  it("a cursor of ANOTHER wallet's txn → 400 (foreign cursor)", async () => {
    sessionFor('finance')
    const res = await walletTxnsGet(req('w-1', '?cursor=lt-2'), ctx('w-1'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/Unknown cursor — it must be the id of a transaction in this wallet ledger/)
    expect(body.field).toBe('cursor')
  })

  it('a cursor that exists nowhere → 400 (stale cursor)', async () => {
    sessionFor('finance')
    const res = await walletTxnsGet(req('w-1', '?cursor=lt-x'), ctx('w-1'))
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).field).toBe('cursor')
  })

  it('a wallet WITHOUT a backing ledger account → honest empty page (shape kept)', async () => {
    sessionFor('finance')
    svc.walletWithBalance.mockResolvedValueOnce({
      wallet: { ...WALLET, ledgerAccountId: null },
      balance: 0,
    })
    const res = await walletTxnsGet(req('w-1'), ctx('w-1'))
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({
      ok: true,
      data: { wallet: { code: 'W-0001', label: 'Riverside main' }, balance: 0, transactions: [], nextCursor: null, hasMore: false },
    })
  })

  it('query validation: unknown key + limit/cursor bounds', async () => {
    sessionFor('finance')
    const unknown = await walletTxnsGet(req('w-1', '?status=posted'), ctx('w-1'))
    expect(unknown.status).toBe(400)
    expect(await bodyOf(unknown)).toEqual({ error: 'Unknown field(s): "status"' })

    for (const qs of ['limit=0', 'limit=abc', 'cursor=']) {
      const res = await walletTxnsGet(req('w-1', `?${qs}`), ctx('w-1'))
      expect(res.status, qs).toBe(400)
      expect((await bodyOf(res)).field).toBe(qs.startsWith('limit') ? 'limit' : 'cursor')
    }
  })

  it('unknown wallet → 404; malformed :id → 400 field "id"; anonymous → 401', async () => {
    sessionFor('finance')
    expect((await walletTxnsGet(req('w-x'), ctx('w-x'))).status).toBe(404)
    expect((await walletTxnsGet(req('w'), ctx('w'))).status).toBe(400)
    h.session = null
    expect((await walletTxnsGet(req('w-1'), ctx('w-1'))).status).toBe(401)
  })
})

// ---------------------------------------------------------------- deposit

describe('POST /api/v1/wallets/:id/deposit — credit from a cash rail', () => {
  const url = 'http://localhost/api/v1/wallets/w-1/deposit'

  it('finance + valid body → 200 envelope, service receives the wallet-owning project', async () => {
    sessionFor('finance')
    const res = await walletDepositPost(jsonReq(url, 'POST', { amount: 1_000, source: 'mpesa', reference: 'MFI-9' }), ctx('w-1'))
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: true, data: { walletCode: 'W-0001', ledgerRef: 'LT-0006', balance: 2_450 } })
    // The wallet resolves UNscoped (finance session, no body projectId) …
    expect(svc.walletWithBalance).toHaveBeenCalledWith('', 'w-1')
    // … but the deposit posts into the wallet's OWNING project's ledger scope.
    expect(svc.depositWallet).toHaveBeenCalledWith('p-1', {
      walletId: 'w-1', amount: 1_000, source: 'mpesa', reference: 'MFI-9', idempotencyKey: undefined, by: 'finance',
    })
  })

  it('body.projectId scopes the wallet resolution (walletWithBalance gets it verbatim)', async () => {
    sessionFor('finance')
    await walletDepositPost(jsonReq(url, 'POST', { amount: 500, projectId: 'p-1' }), ctx('w-1'))
    expect(svc.walletWithBalance).toHaveBeenCalledWith('p-1', 'w-1')
  })

  it('unknown wallet → 404 (the B5-APIV1 audit fix — was 400)', async () => {
    sessionFor('finance')
    const res = await walletDepositPost(jsonReq('http://localhost/api/v1/wallets/w-x/deposit', 'POST', { amount: 10 }), ctx('w-x'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Wallet not found' })
    expect(svc.depositWallet).not.toHaveBeenCalled()
  })

  it('body validation: amount rules, source enum, unknown field — all before the service', async () => {
    sessionFor('finance')
    for (const [body, message, field] of [
      [{ source: 'mpesa' }, 'amount must be a number', 'amount'],
      [{ amount: 0 }, 'amount must be positive', 'amount'],
      [{ amount: -5 }, 'amount must be positive', 'amount'],
      [{ amount: 1.005 }, 'amount supports at most 2 decimal places', 'amount'],
      [{ amount: 1_000_000_001 }, 'amount must be at most 1000000000', 'amount'],
      [{ amount: 10, source: 'paypal' }, 'source must be "mpesa" or "bank"', 'source'],
      [{ amount: 10, amt: 10 }, 'Unknown field(s): "amt"', undefined],
    ] as Array<[Record<string, unknown>, string, string | undefined]>) {
      const res = await walletDepositPost(jsonReq(url, 'POST', body), ctx('w-1'))
      expect(res.status, JSON.stringify(body)).toBe(400)
      const parsed = await bodyOf(res)
      expect((parsed.error as string).startsWith(message), JSON.stringify(body)).toBe(true)
      if (field !== undefined) expect(parsed.field, JSON.stringify(body)).toBe(field)
      expect(svc.depositWallet).not.toHaveBeenCalled()
    }
  })

  it('an invalid body never reaches the idempotency record (retries stay possible)', async () => {
    sessionFor('finance')
    await walletDepositPost(jsonReq(url, 'POST', { amount: 0 }, { 'idempotency-key': 'dep-bad' }), ctx('w-1'))
    expect(state().idemRows).toEqual([])
    expect(dbStub().idempotencyRecord.create).not.toHaveBeenCalled()
  })

  it('Idempotency-Key: first run records, the repeat REPLAYS without re-running the service', async () => {
    sessionFor('finance')
    const first = await bodyOf(
      await walletDepositPost(jsonReq(url, 'POST', { amount: 1_000 }, { 'idempotency-key': 'dep-1' }), ctx('w-1')),
    )
    expect(first).toEqual({ ok: true, data: { walletCode: 'W-0001', ledgerRef: 'LT-0006', balance: 2_450 } })
    expect(state().idemRows).toEqual([
      {
        key: 'dep-1', scope: 'v1.wallet.deposit', projectId: 'p-1',
        responseBody: JSON.stringify({ walletCode: 'W-0001', ledgerRef: 'LT-0006', balance: 2_450 }),
      },
    ])
    svc.depositWallet.mockClear()
    const replay = await bodyOf(
      await walletDepositPost(jsonReq(url, 'POST', { amount: 999 }, { 'idempotency-key': 'dep-1' }), ctx('w-1')),
    )
    expect(svc.depositWallet).not.toHaveBeenCalled()
    expect(replay).toEqual({
      ok: true,
      data: { walletCode: 'W-0001', ledgerRef: 'LT-0006', balance: 2_450 },
      replayed: true,
      scope: 'v1.wallet.deposit',
    })
  })

  it('the x-idempotency-key spelling dedupes too (both spellings, one wallet)', async () => {
    sessionFor('finance')
    await walletDepositPost(jsonReq(url, 'POST', { amount: 100 }, { 'idempotency-key': 'dep-2' }), ctx('w-1'))
    svc.depositWallet.mockClear()
    const replay = await bodyOf(
      await walletDepositPost(jsonReq(url, 'POST', { amount: 100 }, { 'x-idempotency-key': 'dep-2' }), ctx('w-1')),
    )
    expect(svc.depositWallet).not.toHaveBeenCalled()
    expect(replay.replayed).toBe(true)
  })

  it('failures are NEVER recorded — the same key retries for real', async () => {
    sessionFor('finance')
    svc.depositWallet.mockRejectedValueOnce(new Error('Deposit rail down'))
    const failed = await walletDepositPost(
      jsonReq(url, 'POST', { amount: 100 }, { 'idempotency-key': 'dep-3' }), ctx('w-1'),
    )
    expect(failed.status).toBe(400)
    expect(await bodyOf(failed)).toEqual({ error: 'Deposit rail down' })
    expect(state().idemRows).toEqual([])
    const retried = await walletDepositPost(
      jsonReq(url, 'POST', { amount: 100 }, { 'idempotency-key': 'dep-3' }), ctx('w-1'),
    )
    expect(retried.status).toBe(200)
    expect(svc.depositWallet).toHaveBeenCalledTimes(2)
  })

  it('a non-Error service failure → 500 fallback + server log (mapServiceError)', async () => {
    sessionFor('finance')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      svc.depositWallet.mockRejectedValueOnce('boom')
      const res = await walletDepositPost(jsonReq(url, 'POST', { amount: 100 }), ctx('w-1'))
      expect(res.status).toBe(500)
      expect(await bodyOf(res)).toEqual({ error: 'Deposit failed' })
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------- withdraw

describe('POST /api/v1/wallets/:id/withdraw — debit into a cash rail', () => {
  const url = 'http://localhost/api/v1/wallets/w-1/withdraw'

  it('finance + valid body → 200, service args verbatim (destination + note)', async () => {
    sessionFor('finance')
    const res = await walletWithdrawPost(jsonReq(url, 'POST', { amount: 400, destination: 'bank', note: 'Fuel advance' }), ctx('w-1'))
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: true, data: { ledgerRef: 'LT-0007', balance: 1_050 } })
    expect(svc.withdrawWallet).toHaveBeenCalledWith('p-1', {
      walletId: 'w-1', amount: 400, destination: 'bank', note: 'Fuel advance', by: 'finance',
    })
  })

  it('insufficient funds → honest 400 with the service message passed through', async () => {
    sessionFor('finance')
    svc.withdrawWallet.mockRejectedValueOnce(new Error('Insufficient wallet balance: 900 < 1000'))
    const res = await walletWithdrawPost(jsonReq(url, 'POST', { amount: 1_000 }), ctx('w-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Insufficient wallet balance: 900 < 1000' })
  })

  it('body validation: destination enum + amount bounds, before the service', async () => {
    sessionFor('finance')
    for (const [body, message] of [
      [{ amount: 10, destination: 'paypal' }, 'destination must be "mpesa" or "bank"'],
      [{ amount: 0 }, 'amount must be positive'],
      [{ amount: 10, tip: 1 }, 'Unknown field(s): "tip"'],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await walletWithdrawPost(jsonReq(url, 'POST', body), ctx('w-1'))
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(((await bodyOf(res)).error as string).startsWith(message)).toBe(true)
      expect(svc.withdrawWallet).not.toHaveBeenCalled()
    }
  })

  it('malformed :id → 400 field "id"; unknown wallet → 404; anonymous → 401', async () => {
    sessionFor('finance')
    expect((await walletWithdrawPost(jsonReq('http://localhost/api/v1/wallets/w/withdraw', 'POST', { amount: 10 }), ctx('w'))).status).toBe(400)
    expect((await walletWithdrawPost(jsonReq('http://localhost/api/v1/wallets/w-x/withdraw', 'POST', { amount: 10 }), ctx('w-x'))).status).toBe(404)
    h.session = null
    expect((await walletWithdrawPost(jsonReq(url, 'POST', { amount: 10 }), ctx('w-1'))).status).toBe(401)
  })
})

// ---------------------------------------------------------------- transfer

describe('POST /api/v1/wallets/:id/transfer — wallet→wallet', () => {
  const url = 'http://localhost/api/v1/wallets/w-1/transfer'

  it('finance + valid body → 200, service args verbatim (URL wallet is the SOURCE)', async () => {
    sessionFor('finance')
    const res = await walletTransferPost(jsonReq(url, 'POST', { toWalletId: 'w-2', amount: 250, note: 'Roofing advance' }), ctx('w-1'))
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: true, data: { ledgerRef: 'LT-0008', balance: 1_200 } })
    expect(svc.transferWallet).toHaveBeenCalledWith('p-1', {
      fromWalletId: 'w-1', toWalletId: 'w-2', amount: 250, note: 'Roofing advance', by: 'finance',
    })
  })

  it('toWalletId == URL id → 422, transferWallet never runs', async () => {
    sessionFor('finance')
    const res = await walletTransferPost(jsonReq(url, 'POST', { toWalletId: 'w-1', amount: 10 }), ctx('w-1'))
    expect(res.status).toBe(422)
    expect(await bodyOf(res)).toEqual({ error: 'Cannot transfer to the same wallet', field: 'toWalletId' })
    expect(svc.transferWallet).not.toHaveBeenCalled()
  })

  it('id in URL, CODE in the body → still the same wallet → 422', async () => {
    sessionFor('finance')
    const res = await walletTransferPost(jsonReq(url, 'POST', { toWalletId: 'W-0001', amount: 10 }), ctx('w-1'))
    expect(res.status).toBe(422)
    expect(await bodyOf(res)).toEqual({ error: 'Cannot transfer to the same wallet', field: 'toWalletId' })
  })

  it('the 422 guard fires BEFORE the idempotency record (a key leaves no trace)', async () => {
    sessionFor('finance')
    const res = await walletTransferPost(
      jsonReq(url, 'POST', { toWalletId: 'w-1', amount: 10 }, { 'idempotency-key': 'xf-1' }), ctx('w-1'),
    )
    expect(res.status).toBe(422)
    expect(state().idemRows).toEqual([])
  })

  it('body validation: toWalletId shape, amount rules, note bound', async () => {
    sessionFor('finance')
    for (const [body, message, field] of [
      [{ amount: 10 }, 'wallet reference must be a string', 'toWalletId'],
      [{ toWalletId: 'w', amount: 10 }, 'wallet reference must be 2-40 characters', 'toWalletId'],
      [{ toWalletId: 'w-2', amount: 0 }, 'amount must be positive', 'amount'],
      [{ toWalletId: 'w-2', amount: 10, note: 'n'.repeat(501) }, 'note must be at most 500 characters', 'note'],
      [{ toWalletId: 'w-2', amount: 10, frm: 'w-1' }, 'Unknown field(s): "frm"', undefined],
    ] as Array<[Record<string, unknown>, string, string | undefined]>) {
      const res = await walletTransferPost(jsonReq(url, 'POST', body), ctx('w-1'))
      expect(res.status, JSON.stringify(body)).toBe(400)
      const parsed = await bodyOf(res)
      expect((parsed.error as string).startsWith(message), JSON.stringify(body)).toBe(true)
      if (field !== undefined) expect(parsed.field, JSON.stringify(body)).toBe(field)
      expect(svc.transferWallet).not.toHaveBeenCalled()
    }
  })
})

// ---------------------------------------------------------------- flag gate

describe('wallet flag gates the whole v1 wallet family (uniform rule)', () => {
  const off = () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    invalidateFlagCache()
  }

  it('OFF + finance on detail/balance/transactions → 403 uniform shape, walletWithBalance never runs', async () => {
    off()
    sessionFor('finance')
    for (const handler of [walletDetailGet, walletBalanceGet, walletTxnsGet]) {
      const res = await handler(getReq('http://localhost/api/v1/wallets/w-1'), ctx('w-1'))
      expect(res.status, handler.name).toBe(403)
      expect(await bodyOf(res)).toEqual({
        error: 'Feature disabled by feature flag (wallet) — an admin can re-enable it from the flags popover in the header',
      })
    }
    expect(svc.walletWithBalance).not.toHaveBeenCalled()
    expect(dbStub().ledgerAccount.findUnique).not.toHaveBeenCalled()
  })

  it('OFF + finance on transfer/withdraw → 403 before resolution, idempotency, and any ledger write', async () => {
    off()
    sessionFor('finance')
    const transfer = await walletTransferPost(
      jsonReq('http://localhost/api/v1/wallets/w-1/transfer', 'POST', { toWalletId: 'w-2', amount: 10 }),
      ctx('w-1'),
    )
    expect(transfer.status).toBe(403)
    const withdraw = await walletWithdrawPost(
      jsonReq('http://localhost/api/v1/wallets/w-1/withdraw', 'POST', { amount: 10 }),
      ctx('w-1'),
    )
    expect(withdraw.status).toBe(403)
    expect(svc.walletWithBalance).not.toHaveBeenCalled()
    expect(svc.transferWallet).not.toHaveBeenCalled()
    expect(svc.withdrawWallet).not.toHaveBeenCalled()
    expect(dbStub().idempotencyRecord.findUnique).not.toHaveBeenCalled()
  })

  it('OFF + finance on create → 403, createWallet never runs', async () => {
    off()
    sessionFor('finance')
    const res = await walletsCreate(jsonReq('http://localhost/api/v1/wallets', 'POST', { projectId: 'p-1' }))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({
      error: 'Feature disabled by feature flag (wallet) — an admin can re-enable it from the flags popover in the header',
    })
    expect(svc.createWallet).not.toHaveBeenCalled()
  })

  it('OFF + admin → 200 (bypass so the flag can be exercised/toggled)', async () => {
    off()
    sessionFor('admin')
    const res = await walletDetailGet(getReq('http://localhost/api/v1/wallets/w-1'), ctx('w-1'))
    expect(res.status).toBe(200)
  })

  it('GETs gate BEFORE query validation (flag first); POSTs validate the body first (route-kit order)', async () => {
    off()
    sessionFor('finance')
    // GET + unknown query key → the flag's 403, not the query's 400.
    const get = await walletsGet(getReq('http://localhost/api/v1/wallets?wat=1'))
    expect(get.status).toBe(403)
    // POST + invalid body → the body's 400, not the flag's 403 (body parses
    // before the handler's gate — honest route-kit pipeline order).
    const post = await walletDepositPost(jsonReq('http://localhost/api/v1/wallets/w-1/deposit', 'POST', { amount: 0 }), ctx('w-1'))
    expect(post.status).toBe(400)
    expect((await bodyOf(post)).field).toBe('amount')
  })

  it('flag ON + finance → normal 200s everywhere (the gate is additive, not a rewrite)', async () => {
    sessionFor('finance')
    expect((await walletsGet(getReq('http://localhost/api/v1/wallets'))).status).toBe(200)
    expect((await walletDetailGet(getReq('http://localhost/api/v1/wallets/w-1'), ctx('w-1'))).status).toBe(200)
    expect((await walletBalanceGet(getReq('http://localhost/api/v1/wallets/w-1/balance'), ctx('w-1'))).status).toBe(200)
    expect((await walletTxnsGet(getReq('http://localhost/api/v1/wallets/w-1/transactions'), ctx('w-1'))).status).toBe(200)
  })
})
