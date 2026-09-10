/**
 * BE-2 + BE-7 (issue #103) — session-role gates + real actor attribution for
 * the money-action family, plus BE-8 (issue #105) for GET /api/projects.
 *
 * THE BUG (BE-2): the site-team branch of /api/actions (and the offline
 * /api/sync applier) stamped actor identity but applied NO per-action role
 * allowlist — supervisor/qs/procurement sessions could dispatch
 * wallet.deposit/withdraw/transfer, transaction.reverse, ledger.post,
 * escrow.topup, wages.pay, payment.pay, contradicting guard.ts
 * FINANCE_ROLES/PAYMENT_ROLES already enforced on the v1 REST surface.
 *
 * THE FIX under test: requireMoneyActor (src/backend/modules/wallet/service.ts)
 * — a SERVICE-layer gate mirroring the invoices module's requireClientRole, so
 * BOTH dispatch routes (and any future caller) inherit it. The refusal is a
 * thrown single-line domain error: /api/actions renders the standard
 * { ok:false, error } action refusal, /api/sync the same PER-ITEM refusal
 * (batch semantics — other outbox items still process), exactly like the
 * flag-family gate messages (lib/action-flag-gate.ts). BE-7: the ledger
 * postings now carry the REAL session actor (postedBy/postedRole) instead of
 * the hardcoded 'finance'/'Site Manager' stamps.
 *
 * Pinned here:
 *   · every site-team role × every money action → honest refusal naming the
 *     role, ZERO ledger rows, ZERO audit rows, ZERO idempotency rows, and the
 *     gate fires BEFORE any wallet/request lookup (fail-closed, no reads);
 *   · finance session → wallet.deposit + withdraw succeed and the ledger rows
 *     record postedBy 'Fatuma Kep' / postedRole 'finance' (the REAL actor);
 *   · client session → payment.pay succeeds (PAYMENT_ROLES includes client)
 *     and stamps the client actor; supervisor payment.pay → refused;
 *   · admin session → succeeds (the documented superuser bypass);
 *   · escrow.topup (actions/money.ts seam): finance posts with the real
 *     actor, site team refused;
 *   · wages.pay (lib/mjengo.ts seam): finance stamps the real actor — never
 *     the hardcoded 'Site Manager' — and site team is refused; a SESSIONLESS
 *     caller (internal job/script path) keeps the legacy fallback identity;
 *   · /api/sync: a supervisor outbox item is denied per-item while the rest
 *     of the batch still processes (no idempotency row for the denied item,
 *     no money moved); a finance outbox item applies with the real actor;
 *   · BE-8: GET /api/projects answers the standard 429 'Too many requests'
 *     shape on the 61st request in the window (60/min per principal, the
 *     /api/project publicRoute bucket posture) without touching the db;
 *   · BE-8: getProjectsList take-caps every per-table scan
 *     (500/500/500/200/500) while the project roster itself stays uncapped.
 *
 * Mocks (the supplier-role / sync-flag-gate / search-rate-limit idioms):
 * '@/backend/lib/db' (in-memory stub with write-tracking), '@/backend/lib/guard'
 * (full fake — session control for route-kit's withGuard/publicRoute),
 * '@/backend/modules/wallet/session' (currentActor control — the service gate
 * resolves identity from the request cookie, so THIS is the seam it reads),
 * '@/backend/lib/mjengo' (applyAction + getProjectsList stay REAL via
 * importOriginal; only the heavy getProjectPayload read seam is stubbed),
 * '@/backend/modules/wallet/providers' + notify (no network). route-kit,
 * rate-limit, action-flag-gate, the audit AsyncLocalStorage, the ledger
 * engine and every route under test stay REAL. Unique principal IPs keep the
 * in-process rate limiter out of the way (except in the BE-8 describe).
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves (route layer) + the actor the mocked
// wallet/session currentActor resolves (service layer). In production both
// come from the SAME request cookie; the tests keep them consistent.
const h = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string; role: string; projectId: string | null; supplierId: string | null }
  },
  actor: { role: null as string | null, name: null as string | null },
}))

// ---------------------------------------------------------------- db stub

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>
  const d = (iso: string) => new Date(iso)

  const P1 = {
    id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', clientType: 'diaspora', location: 'Karen',
    status: 'active', budget: 2_000_000, shareToken: 'tok-1',
    startDate: d('2026-01-05T09:00:00Z'), targetDate: d('2026-05-01T09:00:00Z'), createdAt: d('2026-01-04T09:00:00Z'),
  }
  const WALLET = {
    id: 'w-1', code: 'W-0001', label: 'Site float', ownerType: 'project', ownerId: 'p-1',
    currency: 'KES', status: 'active', ledgerAccountId: 'la-wallet',
  }
  // Pre-created wallet backing account (createWallet's chart-of-accounts step).
  const LA_WALLET = {
    id: 'la-wallet', code: 'WALLET:W-0001', name: 'Wallet W-0001 — Site float', kind: 'liability',
    normalSide: 'credit', ownerType: 'wallet', ownerId: 'w-1', projectId: 'p-1',
  }
  const PR1 = {
    id: 'pr-1', requestCode: 'PR-2026-000123', projectId: 'p-1', description: 'Cement delivery',
    payee: 'Karioke Hardware', amount: 1200, method: 'mpesa', status: 'approved',
    relatedEntityType: null, relatedEntityId: null, requestedByRole: 'supervisor', requestedByName: 'Wanjiru',
    decidedBy: 'Amina Njeri', decidedAt: d('2026-03-09T10:00:00Z'), decisionNote: null,
    paidAt: null, paidTxnId: null, createdAt: d('2026-03-08T10:00:00Z'),
  }
  const WKR1 = {
    id: 'wkr-1', projectId: 'p-1', name: 'Otieno Odhiambo', role: 'fundi', phone: '+254700111222',
    dailyRate: 700, active: true, createdAt: d('2026-01-05T09:00:00Z'),
  }
  const ATT1 = {
    id: 'att-1', projectId: 'p-1', workerId: 'wkr-1', date: '2026-03-10', status: 'present', wage: 700,
    verification: 'verified', exceptionReason: null, paid: false, version: 1, createdAt: d('2026-03-10T17:00:00Z'),
  }
  const ALERT1 = {
    id: 'al-1', projectId: 'p-1', kind: 'budget', title: 'Budget 80% consumed', body: 'Phase 2 nearing budget',
    acknowledged: false, createdAt: d('2026-03-09T09:00:00Z'),
  }
  // A pre-ledger single-entry row — drives the legacy compensating branch of
  // transaction.reverse.
  const TXN_LEGACY = {
    id: 't-legacy', projectId: 'p-1', type: 'expense', amount: 400, method: 'mpesa', reference: 'MPESA-LEGACY1',
    costCode: 'materials', phaseId: null, ledgerTxnId: null, note: 'Old single-entry row', date: d('2026-03-01T12:00:00Z'),
  }

  const state = {
    flagRows: [
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
      { key: 'ai', enabled: true, description: 'AI' },
    ],
    seq: 0,
    accounts: new Map<string, Row>(),
    txns: new Map<string, Row>(),
    entries: new Map<string, Row>(),
    idemRows: [] as Row[],
    audits: [] as Row[],
    paymentRequests: new Map<string, Row>(),
    escrowWallets: new Map<string, Row>(),
    transactionsRows: new Map<string, Row>(),
    attendanceRows: [] as Row[],
    alerts: [] as Row[],
    /** Counters + arg recorders — the zero-read and take-cap pins. */
    calls: {
      walletAccountFindFirst: 0,
      paymentRequestFindFirst: 0,
      transactionFindFirst: 0,
      projectFindMany: [] as Row[],
      phaseFindMany: [] as Row[],
      transactionFindMany: [] as Row[],
      workerFindMany: [] as Row[],
      alertFindMany: [] as Row[],
      sitePhotoFindMany: [] as Row[],
    },
    reset() {
      state.seq = 0
      state.accounts.clear()
      state.txns.clear()
      state.entries.clear()
      state.idemRows = []
      state.audits = []
      state.paymentRequests = new Map([[PR1.id, { ...PR1 }]])
      state.escrowWallets = new Map()
      state.transactionsRows = new Map([[TXN_LEGACY.id, { ...TXN_LEGACY }]])
      state.attendanceRows = [{ ...ATT1 }]
      state.alerts = [{ ...ALERT1 }]
      state.calls = {
        walletAccountFindFirst: 0,
        paymentRequestFindFirst: 0,
        transactionFindFirst: 0,
        projectFindMany: [],
        phaseFindMany: [],
        transactionFindMany: [],
        workerFindMany: [],
        alertFindMany: [],
        sitePhotoFindMany: [],
      }
    },
  }
  state.reset()

  /** Flat equality + { in } / { not } — enough for the where clauses used here. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Row
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
        if ('not' in c) {
          if (row[key] === c.not) return false
          continue
        }
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  const nid = (p: string) => `${p}_${++state.seq}`
  const entriesFor = (txnId: string) =>
    [...state.entries.values()]
      .filter((e) => e.txnId === txnId)
      .map((e) => ({ ...e, account: state.accounts.get(e.accountId as string) ?? null }))
  const entriesForAccount = (accountId: string) => [...state.entries.values()].filter((e) => e.accountId === accountId)

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
    project: {
      async findUnique({ where }: { where: Row }) {
        return where.id === 'p-1' ? { ...P1 } : null
      },
      async findFirst() { return { ...P1 } },
      async findMany(args: Row = {}) {
        state.calls.projectFindMany.push({ ...args })
        return [{ ...P1 }]
      },
    },
    phase: {
      async findMany(args: Row = {}) {
        state.calls.phaseFindMany.push({ ...args })
        return []
      },
    },
    transaction: {
      async findMany(args: Row = {}) {
        state.calls.transactionFindMany.push({ ...args })
        return [...state.transactionsRows.values()].map((t) => ({ ...t }))
      },
      async findFirst({ where }: { where: Row }) {
        state.calls.transactionFindFirst++
        const row = [...state.transactionsRows.values()].find((t) => matches(t, where))
        return row ? { ...row } : null
      },
      async create({ data }: { data: Row }) {
        const row = { id: nid('t'), ...data }
        state.transactionsRows.set(row.id as string, row)
        return { ...row }
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.transactionsRows.get(where.id)
        if (!row) throw new Error(`stub: transaction ${where.id} not found`)
        Object.assign(row, data)
        return { ...row }
      },
    },
    worker: {
      async findMany(args: Row = {}) {
        state.calls.workerFindMany.push({ ...args })
        const where = (args.where ?? {}) as Row
        return [WKR1].filter((w) => matches(w as Row, where)).map((w) => ({ ...w }))
      },
    },
    alert: {
      async findMany(args: Row = {}) {
        state.calls.alertFindMany.push({ ...args })
        return state.alerts.map((a) => ({ ...a }))
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.alerts.find((a) => a.id === where.id)
        if (!row) throw new Error(`stub: alert ${where.id} not found`)
        Object.assign(row, data)
        return { ...row }
      },
    },
    sitePhoto: {
      async findMany(args: Row = {}) {
        state.calls.sitePhotoFindMany.push({ ...args })
        return []
      },
    },
    attendance: {
      async findMany({ where }: { where: Row }) {
        return state.attendanceRows.filter((a) => matches(a, where)).map((a) => ({ ...a }))
      },
      async updateMany({ where, data }: { where: Row; data: Row }) {
        const rows = state.attendanceRows.filter((a) => matches(a, where))
        for (const row of rows) Object.assign(row, data)
        return { count: rows.length }
      },
    },
    walletAccount: {
      async findFirst({ where }: { where?: { OR?: Array<{ id?: string; code?: string }> } }) {
        state.calls.walletAccountFindFirst++
        for (const cond of where?.OR ?? []) {
          if (cond.id === 'w-1' || cond.code === 'W-0001') return { ...WALLET }
        }
        return null
      },
    },
    ledgerAccount: {
      async findUnique({ where }: { where: { code?: string; id?: string } }) {
        if (where.code === 'WALLET:W-0001') return { ...LA_WALLET, entries: entriesForAccount('la-wallet') }
        const byCode = where.code ? [...state.accounts.values()].find((a) => a.code === where.code) : undefined
        const row = byCode ?? (where.id ? state.accounts.get(where.id) : undefined)
        return row ? { ...row, entries: entriesForAccount(row.id as string) } : null
      },
      async create({ data }: { data: Row }) {
        const a: Row = { id: nid('acct'), ...data }
        state.accounts.set(a.id as string, a)
        return { ...a }
      },
    },
    ledgerTransaction: {
      async findUnique({ where }: { where: { id?: string; idempotencyKey?: string } }) {
        let t: Row | undefined
        if (where.id) t = state.txns.get(where.id)
        else if (where.idempotencyKey) {
          t = [...state.txns.values()].find((x) => x.idempotencyKey === where.idempotencyKey)
        }
        return t ? { ...t, entries: entriesFor(t.id as string) } : null
      },
      async create({ data }: { data: Row & { entries?: { create: Row[] } } }) {
        const { entries, ...rest } = data
        const t: Row = { id: nid('txn'), status: 'posted', reversalRef: null, ...rest }
        const created = (entries?.create ?? []).map((l) => {
          const e: Row = { id: nid('entry'), txnId: t.id, ...l }
          state.entries.set(e.id as string, e)
          return { ...e, account: state.accounts.get(e.accountId as string) ?? null }
        })
        state.txns.set(t.id as string, t)
        return { ...t, entries: created }
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const t = state.txns.get(where.id)
        if (!t) throw new Error(`stub: txn ${where.id} not found`)
        Object.assign(t, data)
        return { ...t, entries: entriesFor(where.id) }
      },
    },
    ledgerEntry: {
      async findMany({ where }: { where: { accountId: string } }) {
        return entriesForAccount(where.accountId).map((e) => ({ ...e }))
      },
    },
    escrowWallet: {
      async findUnique({ where }: { where: { projectId: string } }) {
        const row = state.escrowWallets.get(where.projectId)
        return row ? { ...row } : null
      },
      async upsert({ where, create, update }: { where: { projectId: string }; create: Row; update: Row }) {
        const existing = state.escrowWallets.get(where.projectId)
        if (!existing) {
          const row = { id: nid('ew'), ...create }
          state.escrowWallets.set(where.projectId, row)
          return { ...row }
        }
        // Prisma's { increment } data shape.
        const delta = (update.balance as { increment?: number })?.increment
        existing.balance = delta ? (existing.balance as number) + delta : (update.balance as number)
        return { ...existing }
      },
    },
    paymentRequest: {
      async findFirst({ where }: { where: Row }) {
        state.calls.paymentRequestFindFirst++
        const row = [...state.paymentRequests.values()].find((p) => matches(p, where))
        return row ? { ...row } : null
      },
      async findUnique({ where }: { where: { id: string } }) {
        const row = state.paymentRequests.get(where.id)
        return row ? { ...row } : null
      },
      async update({ where, data }: { where: { id: string }; data: Row }) {
        const row = state.paymentRequests.get(where.id)
        if (!row) throw new Error(`stub: paymentRequest ${where.id} not found`)
        Object.assign(row, data)
        return { ...row }
      },
    },
    idempotencyRecord: {
      async findUnique({ where }: { where: { key: string } }) {
        return state.idemRows.find((r) => r.key === where.key) ?? null
      },
      async create({ data }: { data: Row }) {
        const row = { id: `idem_${state.idemRows.length + 1}`, ...data }
        state.idemRows.push(row)
        return { ...row }
      },
    },
    // Conflict/stale-version pre-checks — no rows, so they pass through and
    // the role gate is the only refusal in play.
    milestone: { async findFirst() { return null } },
    variationOrder: { async findFirst() { return null } },
    invoice: { async findFirst() { return null } },
    task: { async findFirst() { return null } },
    notification: { async create({ data }: { data: Row }) { return { id: nid('n'), ...data } } },
    auditEvent: {
      async create({ data }: { data: Row }) {
        state.audits.push({ ...data })
        return { id: `audit-${state.audits.length}`, ...data }
      },
    },
    async $transaction(fn: (tx: unknown) => unknown) {
      return fn(db)
    },
  }
  return { db }
})

// ---------------------------------------------------------------- guard fake

// Full fake guard (the supplier-role idiom — mirrors guard.ts 1:1 so the
// mocked getSessionFromReq IS the one route-kit's withGuard consults; the
// real module's contract is pinned in guard.test.ts).
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const FINANCE_ROLES = ['finance', 'admin']
  const PAYMENT_ROLES = ['finance', 'admin', 'client']
  const KNOWN_ROLES = ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs', 'supplier']
  const OWNER_ROLES = ['contractor', 'admin', 'supervisor', 'procurement', 'qs', 'finance']
  const getSessionFromReq = vi.fn(async () => h.session)
  return {
    getSessionFromReq,
    unauthorized: () => NextResponse.json({ error: 'Sign in required' }, { status: 401 }),
    forbidden: (role?: string) =>
      NextResponse.json(
        { error: role ? `Not permitted for role "${role}"` : 'Not permitted' },
        { status: 403 },
      ),
    withGuard:
      (handler: (req: NextRequest, session: unknown, ctx: unknown) => unknown, opts?: { roles?: readonly string[] }) =>
      async (req: NextRequest, ctx: unknown) => {
        const session = await getSessionFromReq(req)
        if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
        if (opts?.roles && !opts.roles.includes((session as { user: { role: string } }).user.role)) {
          return NextResponse.json(
            { error: `Not permitted for role "${(session as { user: { role: string } }).user.role}"` },
            { status: 403 },
          )
        }
        return handler(req, session, ctx)
      },
    safeErrorMessage: (e: unknown, fallback: string) =>
      e instanceof Error && !e.message.includes('\n') ? e.message : fallback,
    isInternalError: (e: unknown) => e instanceof Error && e.message.includes('\n'),
    sessionSupplierId: () => null,
    FINANCE_ROLES,
    PAYMENT_ROLES,
    KNOWN_ROLES,
    OWNER_ROLES,
  }
})

// ------------------------------------------- service-layer actor seam (F3)

// The money gates resolve identity from the REQUEST COOKIE via
// modules/wallet/session currentActor — never from the payload. That is the
// seam this mock controls; everything else in the module stays real.
vi.mock('@/backend/modules/wallet/session', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  return {
    ...orig,
    currentActor: vi.fn(async () => ({ role: h.actor.role, name: h.actor.name })),
  }
})

// ---------------------------------------------------------------- seams

// applyAction + getProjectsList stay REAL (importOriginal) — every dispatch
// in this file runs the exact production path, gates and ledger posting
// included. Only the heavy project-payload read seam is stubbed.
vi.mock('@/backend/lib/mjengo', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  return {
    ...orig,
    getProjectPayload: vi.fn(async () => null),
  }
})

vi.mock('@/backend/modules/wallet/providers', () => ({
  PROVIDER_METHODS: ['mpesa', 'bank', 'card', 'cash', 'wallet'] as string[],
  getProvider: vi.fn((method: string) => ({
    label: `Simulated ${method}`,
    integrationNote: 'simulated rail (honestly labelled)',
    initiatePayment: async () => ({ status: 'succeeded', providerRef: 'PRV-TEST-1', detail: 'accepted' }),
  })),
}))

vi.mock('@/backend/modules/notify/service', () => ({ notify: vi.fn() }))

import { db } from '@/backend/lib/db'
import { getProjectsList } from '@/backend/lib/mjengo'
import { MONEY_FINANCE_ROLES, MONEY_PAYMENT_ROLES } from '@/backend/modules/wallet/service'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'
import { POST as actionsPost } from '@/app/api/actions/route'
import { POST as syncPost } from '@/app/api/sync/route'
import { GET as projectsGet } from '@/app/api/projects/route'

// ---------------------------------------------------------------- helpers

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    txns: Map<string, Record<string, unknown>>
    entries: Map<string, Record<string, unknown>>
    idemRows: Array<Record<string, unknown>>
    audits: Array<Record<string, unknown>>
    escrowWallets: Map<string, Record<string, unknown>>
    paymentRequests: Map<string, Record<string, unknown>>
    transactionsRows: Map<string, Record<string, unknown>>
    attendanceRows: Array<Record<string, unknown>>
    calls: {
      walletAccountFindFirst: number
      paymentRequestFindFirst: number
      transactionFindFirst: number
      projectFindMany: Array<Record<string, unknown>>
      phaseFindMany: Array<Record<string, unknown>>
      transactionFindMany: Array<Record<string, unknown>>
      workerFindMany: Array<Record<string, unknown>>
      alertFindMany: Array<Record<string, unknown>>
      sitePhotoFindMany: Array<Record<string, unknown>>
    }
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

/** Set BOTH the route-layer session and the service-layer actor (same cookie in production). */
function sessionFor(role: string, opts: { name?: string; projectId?: string | null } = {}) {
  const seq = Math.floor(Math.random() * 1e9)
  const name = opts.name ?? `${role}-${seq}`
  h.session = {
    user: { id: `u-${role}-${seq}`, email: `${role}.${seq}@test.dev`, name, role, projectId: opts.projectId ?? null, supplierId: null },
  }
  h.actor = { role, name }
  return name
}

/** The sessionless caller (share-link path / internal job — no cookie). */
function sessionless() {
  h.session = null
  h.actor = { role: null, name: null }
}

let reqSeq = 0
/** Unique x-forwarded-for per request → a fresh rate-limit principal every time. */
function jsonReq(url: string, method: 'GET' | 'POST', body?: unknown, headers?: Record<string, string>): NextRequest {
  reqSeq++
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.8.0.${reqSeq % 250}`, ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function actionReq(type: string, payload: unknown = {}, opts: { projectId?: string; headers?: Record<string, string> } = {}) {
  return jsonReq('http://localhost/api/actions', 'POST', { type, payload, projectId: opts.projectId }, opts.headers)
}

interface Queued {
  id: string
  type: string
  payload?: Record<string, unknown>
  projectId?: string
}

function syncReq(actions: Queued[]): NextRequest {
  return jsonReq('http://localhost/api/sync', 'POST', { actions })
}

async function flush(actions: Queued[]): Promise<Record<string, any>> {
  const res = await syncPost(syncReq(actions), undefined)
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, any>
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

const idemKeys = () => state.idemRows.map((r) => String(r.key))
const ledgerRows = () => [...state.txns.values()]

beforeEach(() => {
  vi.clearAllMocks()
  sessionless()
  state.reset()
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

// ---------------------------------------------------------------- gate table

describe('the money-role allowlists (BE-2)', () => {
  it('mirror guard.ts doctrine: finance+admin; payment execution adds the client', () => {
    expect(MONEY_FINANCE_ROLES).toEqual(['finance', 'admin'])
    expect(MONEY_PAYMENT_ROLES).toEqual(['finance', 'admin', 'client'])
  })
})

// ------------------------------------------- BE-2: /api/actions refusals

describe('POST /api/actions — every site-team role is refused for every money action', () => {
  const MONEY_ACTION_CASES: Array<[string, Record<string, unknown>, RegExp]> = [
    ['wallet.deposit', { walletId: 'w-1', amount: 500 }, /Only finance or admin may deposit into wallets/],
    ['wallet.withdraw', { walletId: 'w-1', amount: 500 }, /Only finance or admin may withdraw from wallets/],
    ['wallet.transfer', { fromWalletId: 'w-1', toWalletId: 'w-1', amount: 100 }, /Only finance or admin may transfer between wallets/],
    ['transaction.reverse', { id: 't-legacy', reason: 'oops' }, /Only finance or admin may reverse transactions/],
    ['ledger.post', { description: 'journal', lines: [{ accountCode: 'CASH_MPESA', side: 'debit', amount: 10 }, { accountCode: 'CASH_BANK', side: 'credit', amount: 10 }] }, /Only finance or admin may post manual journal entries/],
    ['escrow.topup', { amount: 5000 }, /Only finance or admin may top up escrow/],
    ['wages.pay', { date: '2026-03-10' }, /Only finance or admin may run payroll/],
    ['payment.pay', { id: 'pr-1' }, /Only finance or admin or client may execute payment requests/],
  ]
  const SITE_TEAM_ROLES = ['supervisor', 'qs', 'procurement', 'contractor']

  it.each(SITE_TEAM_ROLES)('a %s session gets the honest per-action refusal, and nothing is touched', async (role) => {
    sessionFor(role, { name: 'Wanjiru' })
    for (const [type, payload, message] of MONEY_ACTION_CASES) {
      const res = await actionsPost(actionReq(type, payload, { projectId: 'p-1' }), undefined)
      const json = await bodyOf(res)
      expect(res.status, `${role} → ${type} should be refused`).toBe(400)
      expect(json.ok, `${role} → ${type}`).toBe(false)
      expect(String(json.error), `${role} → ${type}`).toMatch(message)
      expect(String(json.error), `${role} → ${type}`).toContain(`signed in as "${role}" (Wanjiru)`)
    }
    // Nothing moved, nothing was recorded, and the gate fired BEFORE any
    // wallet / payment-request / transaction lookup.
    expect(ledgerRows()).toEqual([])
    expect([...state.entries.values()]).toEqual([])
    expect(state.audits).toEqual([])
    expect(state.idemRows).toEqual([])
    expect(state.calls.walletAccountFindFirst).toBe(0)
    expect(state.calls.paymentRequestFindFirst).toBe(0)
    expect(state.calls.transactionFindFirst).toBe(0)
  })
})

// ------------------------------------------- BE-2 + BE-7: the money paths

describe('POST /api/actions — finance/admin/client succeed and the ledger records the REAL actor (BE-7)', () => {
  it('finance session → deposit + withdraw succeed; ledger rows carry postedBy "Fatuma Kep" / postedRole "finance"', async () => {
    sessionFor('finance', { name: 'Fatuma Kep' })

    const dep = await actionsPost(actionReq('wallet.deposit', { walletId: 'w-1', amount: 5000, reference: 'DEP-1' }, { projectId: 'p-1' }), undefined)
    expect(dep.status).toBe(200)
    expect(await bodyOf(dep)).toMatchObject({ ok: true, result: { walletCode: 'W-0001' } })

    const wd = await actionsPost(actionReq('wallet.withdraw', { walletId: 'w-1', amount: 500, note: 'site materials float' }, { projectId: 'p-1' }), undefined)
    expect(wd.status).toBe(200)
    expect(await bodyOf(wd)).toMatchObject({ ok: true, result: { walletCode: 'W-0001', balance: 4500 } })

    expect(ledgerRows()).toHaveLength(2)
    const depositRow = ledgerRows().find((r) => String(r.description).includes('deposit'))
    const withdrawRow = ledgerRows().find((r) => String(r.description).includes('withdrawal'))
    expect(depositRow!.postedBy).toBe('Fatuma Kep') // was 'Finance' (hardcoded)
    expect(depositRow!.postedRole).toBe('finance') // was 'finance' regardless of actor
    expect(withdrawRow!.postedBy).toBe('Fatuma Kep')
    expect(withdrawRow!.postedRole).toBe('finance')
    // The audit trail names the SAME real person the ledger now does (BE-7).
    expect(state.audits.some((a) => a.actor === 'Fatuma Kep' && a.role === 'finance')).toBe(true)
  })

  it('a supervisor WITH an Idempotency-Key still gets nothing recorded for the denied item', async () => {
    sessionFor('supervisor', { name: 'Wanjiru' })
    const res = await actionsPost(
      actionReq('wallet.withdraw', { walletId: 'w-1', amount: 500 }, { projectId: 'p-1', headers: { 'idempotency-key': 'deny-1' } }),
      undefined,
    )
    expect(res.status).toBe(400)
    expect(idemKeys()).toEqual([]) // the record is written only AFTER a successful apply
    expect(ledgerRows()).toEqual([])
  })

  it('client session → payment.pay succeeds (PAYMENT_ROLES includes the client) and stamps the client actor', async () => {
    sessionFor('client', { name: 'Amina Njeri', projectId: 'p-1' })
    const res = await actionsPost(actionReq('payment.pay', { id: 'pr-1' }), undefined)
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ ok: true, result: { id: 'pr-1', status: 'paid' } })

    expect(ledgerRows()).toHaveLength(1)
    const posted = ledgerRows()[0]
    expect(posted.postedBy).toBe('Amina Njeri')
    expect(posted.postedRole).toBe('client')
    expect((state.paymentRequests.get('pr-1') as { status: string }).status).toBe('paid')
  })

  it('admin session → succeeds (the documented superuser bypass)', async () => {
    sessionFor('admin', { name: 'Kamau Mwangi' })
    const res = await actionsPost(actionReq('wallet.deposit', { walletId: 'w-1', amount: 1000, reference: 'DEP-ADM' }, { projectId: 'p-1' }), undefined)
    expect(res.status).toBe(200)
    expect(ledgerRows()).toHaveLength(1)
    expect(ledgerRows()[0].postedBy).toBe('Kamau Mwangi')
    expect(ledgerRows()[0].postedRole).toBe('admin')
  })

  it('finance session → escrow.topup posts CASH→ESCROW with the real actor (actions/money.ts seam)', async () => {
    sessionFor('finance', { name: 'Fatuma Kep' })
    const res = await actionsPost(actionReq('escrow.topup', { amount: 25000, method: 'mpesa', reference: 'TOP-1' }, { projectId: 'p-1' }), undefined)
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ ok: true, result: { balance: 25000, reference: 'TOP-1' } })

    expect(ledgerRows()).toHaveLength(1)
    expect(ledgerRows()[0].postedBy).toBe('Fatuma Kep')
    expect(ledgerRows()[0].postedRole).toBe('finance')
    expect(String(ledgerRows()[0].description)).toContain('Escrow top-up (TOP-1)')
    expect((state.escrowWallets.get('p-1') as { balance: number }).balance).toBe(25000)
  })

  it('finance session → wages.pay stamps the real session actor — never the hardcoded "Site Manager"', async () => {
    sessionFor('finance', { name: 'Fatuma Kep' })
    const res = await actionsPost(actionReq('wages.pay', { date: '2026-03-10' }, { projectId: 'p-1' }), undefined)
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ ok: true, result: { paid: 1, amount: 700 } })

    expect(ledgerRows()).toHaveLength(1)
    const posted = ledgerRows()[0]
    expect(posted.postedBy).toBe('Fatuma Kep') // was 'Site Manager' (hardcoded)
    expect(posted.postedRole).toBe('finance') // was 'contractor' (hardcoded)
    expect(String(posted.description)).toContain('Wages 2026-03-10 — 1 fundi(s)')
    expect((state.attendanceRows[0] as { paid: boolean }).paid).toBe(true)
  })

  it('a sessionless caller (internal job / script path) keeps the legacy wages fallback identity', async () => {
    sessionless()
    // applyAction DIRECTLY — the internal-caller path (no route, no cookie).
    const { applyAction } = await import('@/backend/lib/mjengo')
    const result = await applyAction('wages.pay', { date: '2026-03-10' }, 'p-1')
    expect(result).toMatchObject({ paid: 1, amount: 700 })
    expect(ledgerRows()).toHaveLength(1)
    expect(ledgerRows()[0].postedBy).toBe('Site Manager') // documented fallback
    expect(ledgerRows()[0].postedRole).toBe('contractor')
  })

  it('finance session → transaction.reverse posts the compensating entry with the real actor (legacy row)', async () => {
    sessionFor('finance', { name: 'Fatuma Kep' })
    const res = await actionsPost(actionReq('transaction.reverse', { id: 't-legacy', reason: 'wrong amount' }, { projectId: 'p-1' }), undefined)
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ ok: true, result: { reversalTransactionId: expect.any(String) } })

    expect(ledgerRows()).toHaveLength(1)
    expect(ledgerRows()[0].postedBy).toBe('Fatuma Kep')
    expect(ledgerRows()[0].postedRole).toBe('finance')
    expect(String(ledgerRows()[0].description)).toContain('REVERSAL of legacy transaction')
    // The compensating legacy row is negative and linked to the ledger txn.
    const compensating = [...state.transactionsRows.values()].find((t) => t.ledgerTxnId === ledgerRows()[0].id)
    expect(compensating).toMatchObject({ type: 'reversal', amount: -400 })
  })
})

// ------------------------------------------- BE-2: the /api/sync applier

describe('POST /api/sync — the SAME service gate holds per outbox item (batch semantics)', () => {
  it('supervisor outbox: wallet.withdraw denied per-item; the rest of the batch still processes; nothing recorded for the denied item', async () => {
    sessionFor('supervisor', { name: 'Wanjiru' })
    const json = await flush([
      { id: 'ack-1', type: 'alert.ack', payload: { id: 'al-1' }, projectId: 'p-1' },
      { id: 'wd-1', type: 'wallet.withdraw', payload: { walletId: 'w-1', amount: 100 }, projectId: 'p-1' },
    ])
    expect(json.ok).toBe(true)
    expect(json.synced).toBe(1)
    expect(json.failed).toBe(1)
    expect(json.results).toMatchObject([
      { id: 'ack-1', ok: true },
      { id: 'wd-1', ok: false, error: expect.stringMatching(/Only finance or admin may withdraw from wallets — signed in as "supervisor"/) },
    ])
    expect('conflict' in json.results[1]).toBe(false) // a refusal, not a §41 conflict
    // The alert item recorded its idem key; the denied item recorded NOTHING.
    expect(idemKeys()).toContain('sync:p-1:ack-1')
    expect(idemKeys()).not.toContain('sync:p-1:wd-1')
    expect(ledgerRows()).toEqual([]) // no money moved
    // Only the alert's success audit exists — the denied item logged nothing.
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0].kind).toBe('alert')
    expect(String(state.audits[0].summary)).not.toContain('withdrawal')
  })

  it('finance outbox: wallet.withdraw applies through the applier and records the real actor', async () => {
    const name = sessionFor('finance', { name: 'Fatuma Kep' })
    // Fund the wallet first so the withdrawal has balance (finance deposit).
    const dep = await actionsPost(actionReq('wallet.deposit', { walletId: 'w-1', amount: 2000, reference: 'DEP-SYNC' }, { projectId: 'p-1' }), undefined)
    expect(dep.status).toBe(200)

    const json = await flush([
      { id: 'wd-2', type: 'wallet.withdraw', payload: { walletId: 'w-1', amount: 200, note: 'offline flush' }, projectId: 'p-1' },
    ])
    expect(json.results).toMatchObject([{ id: 'wd-2', ok: true }])
    expect(idemKeys()).toContain('sync:p-1:wd-2')

    const withdrawRow = ledgerRows().find((r) => String(r.description).includes('withdrawal'))
    expect(withdrawRow!.postedBy).toBe(name)
    expect(withdrawRow!.postedRole).toBe('finance')
  })
})

// ------------------------------------------- BE-8: /api/projects throttle

describe('GET /api/projects — the standard rate limiter (BE-8, 60/min per principal)', () => {
  const T0 = new Date('2026-01-05T09:00:00Z')

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
    sessionFor('contractor')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function projectsReq(ip: string): NextRequest {
    return new NextRequest('http://localhost/api/projects', { headers: { 'x-forwarded-for': ip } })
  }

  it('requests 1..60 pass; request 61 → honest 429 + Retry-After, and the db is NOT touched for the denied request', async () => {
    for (let i = 1; i <= 60; i++) {
      const res = await projectsGet(projectsReq('10.9.0.7'), undefined)
      expect(res.status, `request ${i} should pass`).toBe(200)
      const body = (await res.json()) as { ok?: boolean }
      expect(body.ok).toBe(true)
    }
    const readsBefore = state.calls.projectFindMany.length
    const blocked = await projectsGet(projectsReq('10.9.0.7'), undefined)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
    const body = (await blocked.json()) as { error?: string; retryAfterSec?: number }
    expect(body.error).toBe('Too many requests')
    expect(typeof body.retryAfterSec).toBe('number')
    expect(state.calls.projectFindMany.length).toBe(readsBefore) // no roster build for a denied request
  })

  it('a DIFFERENT principal has a fresh bucket (the denial is per-principal, not global)', async () => {
    sessionFor('supervisor')
    for (let i = 1; i <= 60; i++) {
      const res = await projectsGet(projectsReq('10.9.1.8'), undefined)
      expect(res.status).toBe(200)
    }
    // 10.9.0.7 exhausted its own bucket above? No — different describe run;
    // this file's buckets are per (bucket, principal) and 10.9.1.8 is fresh:
    const blocked = await projectsGet(projectsReq('10.9.1.8'), undefined)
    expect(blocked.status).toBe(429)
    const fresh = await projectsGet(projectsReq('10.9.1.9'), undefined)
    expect(fresh.status).toBe(200)
  })
})

// ------------------------------------------- BE-8: getProjectsList take caps

describe('getProjectsList — every per-table scan is take-capped (BE-8)', () => {
  it('phases 500 / transactions 500 / workers 500 / alerts 200 / photos 500; the project roster itself stays uncapped', async () => {
    const list = await getProjectsList()
    expect(list.map((p) => p.id)).toEqual(['p-1'])

    const solo = (calls: Array<Record<string, unknown>>, table: string) => {
      expect(calls, `${table} should be scanned exactly once`).toHaveLength(1)
      return calls[0]
    }
    expect(solo(state.calls.phaseFindMany, 'phases').take).toBe(500)
    expect(solo(state.calls.transactionFindMany, 'transactions').take).toBe(500)
    expect(solo(state.calls.workerFindMany, 'workers').take).toBe(500)
    expect(solo(state.calls.alertFindMany, 'alerts').take).toBe(200)
    expect(solo(state.calls.sitePhotoFindMany, 'photos').take).toBe(500)
    // The roster IS the list this function exists to return — uncapped.
    expect(solo(state.calls.projectFindMany, 'projects').take).toBeUndefined()
  })
})
