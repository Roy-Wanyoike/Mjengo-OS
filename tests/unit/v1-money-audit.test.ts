/**
 * DB-4 — v1 money mutations write audit events.
 *
 * The /api/actions dispatcher audits every applyAction mutation, but the v1
 * money routes (wallet deposit / withdraw / transfer, payments POST) called
 * the wallet service directly and left NO AuditEvent — payments.ts itself
 * admitted "the caller can audit" while no caller did. These tests pin the
 * fix:
 *  · every SUCCESSFUL v1 money mutation writes exactly ONE AuditEvent through
 *    the same writer as applyAction (lib/audit.ts logAudit) with the guard
 *    session as actor, entity-scoped before/after snapshots and a meta.type
 *    matching the actions-trail kind ('wallet.deposit', …);
 *  · a FAILED mutation writes nothing (the audit line only runs after the
 *    service succeeds);
 *  · an idempotent REPLAY serves the stored response without re-running the
 *    callback — no second audit row;
 *  · role-gated rejections (403) never reach the service or the audit trail.
 *
 * Mocks mirror tests/unit/v1-wallets.test.ts: full fake guard (session
 * control), '@/backend/lib/db' (featureFlag rows, idempotencyRecord for the
 * REAL withIdempotency, auditEvent capture, paymentRequest lookup), and the
 * wallet service seams. route-kit, rate-limit, flags, respond/schemas and
 * modules/wallet/http stay REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

type AuditRow = Record<string, unknown>
type IdemRow = Record<string, unknown>
type RequestRow = {
  id: string
  requestCode: string
  projectId: string
  description: string
  amount: number
  payee: string
  method: string
  status: string
}

vi.mock('@/backend/lib/db', () => {
  const state = {
    flagRows: [
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
    ],
    auditRows: [] as AuditRow[],
    idemRows: [] as IdemRow[],
    requestRows: [] as RequestRow[],
    reset() {
      state.auditRows = []
      state.idemRows = []
      state.requestRows = [REQUEST]
    },
  }
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
    idempotencyRecord: {
      async findUnique({ where }: { where: { key: string } }) {
        return (state.idemRows.find((r) => r.key === where.key) as IdemRow | undefined) ?? null
      },
      async create({ data }: { data: Record<string, unknown> }) {
        state.idemRows.push({ ...data })
        return { ...data }
      },
    },
    // logAudit is the ONLY writer in production — the stub captures its rows.
    auditEvent: {
      async create({ data }: { data: Record<string, unknown> }) {
        state.auditRows.push({ ...data })
        return { ...data }
      },
    },
    // The payments route resolves the request before money moves.
    paymentRequest: {
      async findFirst({ where }: { where: { OR: Array<{ id?: string; requestCode?: string }> } }) {
        const id = where.OR[0].id ?? where.OR[1].requestCode
        return state.requestRows.find((r) => r.id === id || r.requestCode === id) ?? null
      },
    },
  }
  return { db }
})

// The hoisted db state needs the fixture before the factory body runs.
const REQUEST: RequestRow = {
  id: 'pr-1',
  requestCode: 'PR-2026-000001',
  projectId: 'p-1',
  description: 'Cement batch 2',
  amount: 12_000,
  payee: 'Bamburi Supplies',
  method: 'mpesa',
  status: 'approved',
}

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

// The wallet service seams (money writes — pinned by the module's own tests).
const svc = vi.hoisted(() => ({
  walletWithBalance: vi.fn(),
  depositWallet: vi.fn(),
  withdrawWallet: vi.fn(),
  transferWallet: vi.fn(),
  payPaymentRequest: vi.fn(),
}))
vi.mock('@/backend/modules/wallet/service', () => svc)

// modules/wallet/http (withIdempotency) stays REAL — replay semantics are
// part of what these tests pin (a replay must NOT re-audit).

import { db } from '@/backend/lib/db'
import { POST as walletDepositPost } from '@/app/api/v1/wallets/[id]/deposit/route'
import { POST as walletWithdrawPost } from '@/app/api/v1/wallets/[id]/withdraw/route'
import { POST as walletTransferPost } from '@/app/api/v1/wallets/[id]/transfer/route'
import { POST as paymentsPost } from '@/app/api/v1/payments/route'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'

const state = () => (db as unknown as { __state: ReturnType<typeof getState> }).__state
function getState() {
  return undefined as unknown as {
    auditRows: AuditRow[]
    idemRows: IdemRow[]
    reset: () => void
  }
}

const WALLET = {
  id: 'w-1', code: 'W-0001', label: 'Riverside main', ownerType: 'project', ownerId: 'p-1',
  currency: 'KES', status: 'active', ledgerAccountId: 'la-1',
}

function sessionFor(role: string, projectId: string | null = null) {
  h.session = { user: { id: `u-${role}`, email: `${role}@test.dev`, name: role, role, projectId } }
}

function jsonReq(url: string, body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>
}

beforeEach(() => {
  state().reset()
  sessionFor('finance')
  vi.clearAllMocks()
  svc.walletWithBalance.mockImplementation(async () => ({ wallet: { ...WALLET }, balance: 1_450 }))
  svc.depositWallet.mockResolvedValue({ walletCode: 'W-0001', ledgerRef: 'LT-0006', balance: 2_450 })
  svc.withdrawWallet.mockResolvedValue({ walletCode: 'W-0001', ledgerRef: 'LT-0007', balance: 450 })
  svc.transferWallet.mockResolvedValue({ from: 'W-0001', to: 'W-0002', ledgerRef: 'LT-0008' })
  svc.payPaymentRequest.mockResolvedValue({
    id: 'pr-1', status: 'paid', transactionId: 'txn-9', ledgerRef: 'LT-0009', balance: 0, providerNote: 'simulated rail',
  })
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

describe('POST /api/v1/wallets/:id/deposit — audit trail (DB-4)', () => {
  const url = 'http://localhost/api/v1/wallets/w-1/deposit'

  it('successful deposit writes exactly one wallet AuditEvent with actor, before/after and ledger ref', async () => {
    const res = await walletDepositPost(jsonReq(url, { amount: 1_000, source: 'mpesa', reference: 'MFI-9' }), ctx('w-1'))
    expect(res.status).toBe(200)

    const rows = state().auditRows
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.projectId).toBe('p-1') // the wallet's OWNING project
    expect(row.kind).toBe('wallet')
    expect(row.actor).toBe('finance')
    expect(row.role).toBe('finance')
    expect(row.summary).toBe('Wallet deposit KSh 1000 (ledger LT-0006)')
    expect(row.entity).toBe('WalletAccount')
    expect(row.entityId).toBe('w-1')
    expect(JSON.parse(row.before as string)).toEqual({ balance: 1_450 })
    expect(JSON.parse(row.after as string)).toEqual({ balance: 2_450 })
    const meta = JSON.parse(row.meta as string)
    expect(meta).toMatchObject({
      type: 'wallet.deposit', amount: 1_000, source: 'mpesa', reference: 'MFI-9', ledgerRef: 'LT-0006', walletCode: 'W-0001',
    })
  })

  it('a failed deposit writes NO audit event', async () => {
    svc.depositWallet.mockRejectedValueOnce(new Error('Deposit rail down'))
    const res = await walletDepositPost(jsonReq(url, { amount: 1_000 }), ctx('w-1'))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(state().auditRows).toHaveLength(0)
  })

  it('an idempotent replay serves the stored response and does NOT re-audit', async () => {
    const first = await walletDepositPost(jsonReq(url, { amount: 1_000 }, { 'idempotency-key': 'audit-dep-1' }), ctx('w-1'))
    expect(first.status).toBe(200)
    expect(state().auditRows).toHaveLength(1)

    const replay = await walletDepositPost(jsonReq(url, { amount: 1_000 }, { 'idempotency-key': 'audit-dep-1' }), ctx('w-1'))
    expect(replay.status).toBe(200)
    expect((await bodyOf(replay)).replayed).toBe(true)
    expect(svc.depositWallet).toHaveBeenCalledTimes(1)
    expect(state().auditRows).toHaveLength(1) // still exactly one trail row
  })

  it('role-gated rejection (403) never reaches the service or the audit trail', async () => {
    sessionFor('contractor')
    const res = await walletDepositPost(jsonReq(url, { amount: 1_000 }), ctx('w-1'))
    expect(res.status).toBe(403)
    expect(svc.depositWallet).not.toHaveBeenCalled()
    expect(state().auditRows).toHaveLength(0)
  })
})

describe('POST /api/v1/wallets/:id/withdraw — audit trail (DB-4)', () => {
  const url = 'http://localhost/api/v1/wallets/w-1/withdraw'

  it('successful withdrawal writes one wallet AuditEvent with before/after balances', async () => {
    const res = await walletWithdrawPost(jsonReq(url, { amount: 1_000, destination: 'bank', note: 'Fuel' }), ctx('w-1'))
    expect(res.status).toBe(200)

    const rows = state().auditRows
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('wallet')
    expect(row.summary).toBe('Wallet withdrawal KSh 1000')
    expect(JSON.parse(row.before as string)).toEqual({ balance: 1_450 })
    expect(JSON.parse(row.after as string)).toEqual({ balance: 450 })
    expect(JSON.parse(row.meta as string)).toMatchObject({
      type: 'wallet.withdraw', amount: 1_000, destination: 'bank', note: 'Fuel', ledgerRef: 'LT-0007',
    })
  })

  it('a failed withdrawal writes NO audit event', async () => {
    svc.withdrawWallet.mockRejectedValueOnce(new Error('Insufficient wallet balance: 1450 < 5000'))
    const res = await walletWithdrawPost(jsonReq(url, { amount: 5_000 }), ctx('w-1'))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(state().auditRows).toHaveLength(0)
  })
})

describe('POST /api/v1/wallets/:id/transfer — audit trail (DB-4)', () => {
  const url = 'http://localhost/api/v1/wallets/w-1/transfer'

  it('successful transfer writes one wallet AuditEvent scoped to the SOURCE wallet', async () => {
    const res = await walletTransferPost(jsonReq(url, { toWalletId: 'w-2', amount: 800, note: 'float move' }), ctx('w-1'))
    expect(res.status).toBe(200)

    const rows = state().auditRows
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('wallet')
    expect(row.summary).toBe('Wallet transfer KSh 800 W-0001 → W-0002')
    expect(row.entity).toBe('WalletAccount')
    expect(row.entityId).toBe('w-1') // the URL resource = the source wallet
    expect(JSON.parse(row.after as string)).toEqual({ from: 'W-0001', to: 'W-0002', amount: 800 })
    expect(JSON.parse(row.meta as string)).toMatchObject({
      type: 'wallet.transfer', amount: 800, fromWalletId: 'w-1', toWalletId: 'w-2', ledgerRef: 'LT-0008',
    })
  })

  it('same-wallet 422 writes NO audit event (nothing moved)', async () => {
    const res = await walletTransferPost(jsonReq(url, { toWalletId: 'w-1', amount: 10 }), ctx('w-1'))
    expect(res.status).toBe(422)
    expect(svc.transferWallet).not.toHaveBeenCalled()
    expect(state().auditRows).toHaveLength(0)
  })
})

describe('POST /api/v1/payments — audit trail (DB-4)', () => {
  const url = 'http://localhost/api/v1/payments'

  it('successful payment writes one payment AuditEvent with status before/after', async () => {
    const res = await paymentsPost(jsonReq(url, { paymentRequestId: 'PR-2026-000001', method: 'bank', costCode: 'phase-2' }))
    expect(res.status).toBe(200)

    const rows = state().auditRows
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.projectId).toBe('p-1')
    expect(row.kind).toBe('payment')
    expect(row.actor).toBe('finance')
    expect(row.summary).toBe('Payment recorded (ledger LT-0009)')
    expect(row.entity).toBe('PaymentRequest')
    expect(row.entityId).toBe('pr-1')
    expect(JSON.parse(row.before as string)).toEqual({ status: 'approved' })
    expect(JSON.parse(row.after as string)).toEqual({ status: 'paid' })
    const meta = JSON.parse(row.meta as string)
    expect(meta).toMatchObject({
      type: 'payment.pay', requestCode: 'PR-2026-000001', amount: 12_000, payee: 'Bamburi Supplies',
      method: 'bank', ledgerRef: 'LT-0009', transactionId: 'txn-9',
    })
  })

  it('a failed payment writes NO audit event', async () => {
    svc.payPaymentRequest.mockRejectedValueOnce(new Error('Payment request must be approved before payment'))
    const res = await paymentsPost(jsonReq(url, { paymentRequestId: 'PR-2026-000001' }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(state().auditRows).toHaveLength(0)
  })

  it('an idempotent replay does NOT re-audit', async () => {
    const first = await paymentsPost(jsonReq(url, { paymentRequestId: 'PR-2026-000001' }, { 'idempotency-key': 'audit-pay-1' }))
    expect(first.status).toBe(200)
    const replay = await paymentsPost(jsonReq(url, { paymentRequestId: 'PR-2026-000001' }, { 'idempotency-key': 'audit-pay-1' }))
    expect(replay.status).toBe(200)
    expect((await bodyOf(replay)).replayed).toBe(true)
    expect(svc.payPaymentRequest).toHaveBeenCalledTimes(1)
    expect(state().auditRows).toHaveLength(1)
  })
})
