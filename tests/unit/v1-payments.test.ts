/**
 * /api/v1 — the PAYMENTS resource contract (issue #69, test wave 2):
 *   POST /api/v1/payments — pay an APPROVED PaymentRequest.
 *
 * Pinned invariants:
 *   · ROLE SCOPING — PAYMENT_ROLES = finance/admin/CLIENT (the one v1 money
 *     route a client may call); every other signed-in role → 403
 *     'Not permitted for role "x"'. Anonymous → 401 'Sign in required'.
 *   · RESOLVE-FIRST / PIN-SECOND — the request is resolved BEFORE the client
 *     tenant pin: an unknown id answers 404 even for a client who would be
 *     pinned out anyway; a client pinned to a FOREIGN project (or with no
 *     pinned project) answers 403 'Not permitted for this project' AFTER a
 *     successful resolve, and the payment service NEVER runs in either case.
 *   · WALLET FLAG GATE — the uniform rule, BEFORE the request is resolved or
 *     money moves: flag OFF + non-admin (client is the interesting role —
 *     PAYMENT_ROLES lets it past the role gate) → 403 'Feature disabled by
 *     feature flag (wallet) — …'; the request lookup AND the idempotency
 *     replay are both skipped (a pre-seeded Idempotency-Key never gets
 *     consulted while the flag is off).
 *   · RESOLUTION — the body accepts `paymentRequestId` OR the legacy `id`
 *     alias, each as the cuid OR the human requestCode (PR-2026-000001);
 *     `paymentRequestId` wins when both are present.
 *   · BODY VALIDATION — zod strictObject: unknown keys listed by name, the
 *     required-key refine ('paymentRequestId (or id) required', no field),
 *     honest bounds (method enum, reference ≤ 200, ids ≤ 40); unparseable
 *     JSON → 400 'Invalid JSON body', array body → 'Body must be a JSON
 *     object' (route-kit's schema-mode contract).
 *   · IDEMPOTENCY (real modules/wallet/http.ts over the db stub) — the first
 *     keyed run records { scope: 'v1.payment.pay', projectId: the REQUEST's
 *     project }; a repeat replays the stored body with { replayed: true,
 *     scope } and never re-runs the payment service.
 *   · ENVELOPE — success is { ok: true, data } (jsonOk); every error is the
 *     one { error, field? } contract.
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control), '@/backend/lib/db' (featureFlag rows + paymentRequest.findFirst +
 * idempotencyRecord for the REAL withIdempotency), and
 * '@/backend/modules/wallet/service' (payPaymentRequest). route-kit,
 * rate-limit, flags, respond/schemas and modules/wallet/http stay REAL.
 * NEXT_FLAGS_OFF + invalidateFlagCache() control the flag state.
 *
 * Complements tests/unit/flags-gating.test.ts (which pins the flag gate for
 * finance/admin sessions on this route) and tests/unit/v1-wallets.test.ts
 * (the rest of the v1 wallet family).
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

type PaymentRequestRow = { id: string; requestCode: string; projectId: string; status: string; amount: number; payee: string }
type DbState = {
  flagRows: Array<{ key: string; enabled: boolean; description: string }>
  requestRows: PaymentRequestRow[]
  idemRows: Array<Record<string, unknown>>
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
    requestRows: [],
    idemRows: [],
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
    paymentRequest: {
      findFirst: vi.fn(async ({ where }: { where: { OR: Array<Record<string, string>> } }) => {
        const id = where.OR.find((c) => c.id !== undefined)?.id
        const code = where.OR.find((c) => c.requestCode !== undefined)?.requestCode
        const row = state.requestRows.find((r) => r.id === id || r.requestCode === code)
        return row ? { ...row } : null
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

const svc = vi.hoisted(() => ({ payPaymentRequest: vi.fn() }))
vi.mock('@/backend/modules/wallet/service', () => svc)

// modules/wallet/http (withIdempotency) stays REAL — pinned over the db stub.

import { db } from '@/backend/lib/db'
import { POST as paymentsPost } from '@/app/api/v1/payments/route'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'

const dbStub = () =>
  db as unknown as {
    __state: DbState
    paymentRequest: { findFirst: ReturnType<typeof vi.fn> }
    idempotencyRecord: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
  }
const state = () => dbStub().__state

function sessionFor(role: string, projectId: string | null = null) {
  h.session = { user: { id: `u-${role}`, email: `${role}@test.dev`, name: role, role, projectId } }
}

function payReq(body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/v1/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>
}

// ---------------------------------------------------------------- fixtures

/** Two approved requests on two projects — pr-2 drives the foreign-project pins. */
const REQUESTS: PaymentRequestRow[] = [
  { id: 'pr-1', requestCode: 'PR-2026-000001', projectId: 'p-1', status: 'approved', amount: 150_000, payee: 'Karioke Hardware' },
  { id: 'pr-2', requestCode: 'PR-2026-000002', projectId: 'p-2', status: 'approved', amount: 45_000, payee: 'Fundi Juma' },
]

const PAY_RESULT = {
  id: 'pr-1',
  status: 'paid',
  transactionId: 't-88',
  ledgerRef: 'LT-0088',
  balance: 2_450,
  providerNote: 'Simulated rail — no licensed provider is integrated (workflow + ledger only)',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  state().requestRows = REQUESTS.map((r) => ({ ...r }))
  state().idemRows = []
  svc.payPaymentRequest.mockResolvedValue({ ...PAY_RESULT })
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

// ---------------------------------------------------------------- roles + envelope

describe('POST /api/v1/payments — PAYMENT_ROLES scoping + envelope', () => {
  it.each(['contractor', 'supervisor', 'qs'])(
    '%s (not a payment role) → 403 "Not permitted for role", nothing resolved',
    async (role) => {
      sessionFor(role)
      const res = await paymentsPost(payReq({ paymentRequestId: 'pr-1' }))
      expect(res.status).toBe(403)
      expect(await bodyOf(res)).toEqual({ error: `Not permitted for role "${role}"` })
      expect(dbStub().paymentRequest.findFirst).not.toHaveBeenCalled()
      expect(svc.payPaymentRequest).not.toHaveBeenCalled()
    },
  )

  it('anonymous → 401 { error: "Sign in required" }', async () => {
    const res = await paymentsPost(payReq({ paymentRequestId: 'pr-1' }))
    expect(res.status).toBe(401)
    expect(await bodyOf(res)).toEqual({ error: 'Sign in required' })
  })

  it('finance → 200 { ok, data } and the service args verbatim (paidBy/paidByRole)', async () => {
    sessionFor('finance')
    const res = await paymentsPost(
      payReq({ paymentRequestId: 'pr-1', method: 'mpesa', reference: 'MP-77', costCode: 'RF-01' }),
    )
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: true, data: PAY_RESULT })
    expect(svc.payPaymentRequest).toHaveBeenCalledWith('p-1', {
      id: 'pr-1',
      method: 'mpesa',
      reference: 'MP-77',
      costCode: 'RF-01',
      paidBy: 'finance',
      paidByRole: 'finance',
    })
  })

  it('client on their OWN project → 200 with paidByRole "client" (clients may pay)', async () => {
    sessionFor('client', 'p-1')
    const res = await paymentsPost(payReq({ paymentRequestId: 'pr-1' }))
    expect(res.status).toBe(200)
    expect(svc.payPaymentRequest).toHaveBeenCalledWith('p-1', expect.objectContaining({ paidByRole: 'client' }))
  })
})

// ---------------------------------------------------------------- resolve-first, pin-second

describe('POST /api/v1/payments — resolve-first / client pin-second', () => {
  it('unknown request → 404 { error: "Payment request not found" } (no field), service never runs', async () => {
    sessionFor('finance')
    const res = await paymentsPost(payReq({ paymentRequestId: 'pr-x' }))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Payment request not found' })
    expect(svc.payPaymentRequest).not.toHaveBeenCalled()
  })

  it('resolve happens BEFORE the client pin: a client + unknown id → 404 (not 403)', async () => {
    sessionFor('client', 'p-2') // would be pinned out of p-1 — but the request does not exist
    const res = await paymentsPost(payReq({ paymentRequestId: 'pr-x' }))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Payment request not found' })
    expect(svc.payPaymentRequest).not.toHaveBeenCalled()
  })

  it('client pinned to a FOREIGN project → 403 "Not permitted for this project", no money moves', async () => {
    sessionFor('client', 'p-2')
    const res = await paymentsPost(payReq({ paymentRequestId: 'pr-1' })) // pr-1 is p-1's
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this project' })
    expect(svc.payPaymentRequest).not.toHaveBeenCalled()
  })

  it('client with NO pinned project → 403 (fail closed)', async () => {
    sessionFor('client', null)
    const res = await paymentsPost(payReq({ paymentRequestId: 'pr-1' }))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this project' })
    expect(svc.payPaymentRequest).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- resolution

describe('POST /api/v1/payments — request resolution', () => {
  it('the human requestCode resolves (PR-2026-000001) via paymentRequestId', async () => {
    sessionFor('finance')
    const res = await paymentsPost(payReq({ paymentRequestId: 'PR-2026-000001' }))
    expect(res.status).toBe(200)
    expect(svc.payPaymentRequest).toHaveBeenCalledWith('p-1', expect.objectContaining({ id: 'pr-1' }))
  })

  it('the legacy `id` body alias works with the cuid AND the requestCode', async () => {
    sessionFor('finance')
    expect((await paymentsPost(payReq({ id: 'pr-2' }))).status).toBe(200)
    expect(svc.payPaymentRequest).toHaveBeenLastCalledWith('p-2', expect.objectContaining({ id: 'pr-2' }))
    expect((await paymentsPost(payReq({ id: 'PR-2026-000001' }))).status).toBe(200)
    expect(svc.payPaymentRequest).toHaveBeenLastCalledWith('p-1', expect.objectContaining({ id: 'pr-1' }))
  })

  it('paymentRequestId wins when both body keys are present', async () => {
    sessionFor('finance')
    const res = await paymentsPost(payReq({ paymentRequestId: 'pr-1', id: 'PR-2026-000002' }))
    expect(res.status).toBe(200)
    expect(svc.payPaymentRequest).toHaveBeenCalledWith('p-1', expect.objectContaining({ id: 'pr-1' }))
  })
})

// ---------------------------------------------------------------- body validation

describe('POST /api/v1/payments — body validation (zod strictObject)', () => {
  it('the honest 400s: required key, empty string, bounds, enum, unknown field', async () => {
    sessionFor('finance')
    for (const [body, message, field] of [
      [{}, 'paymentRequestId (or id) required', undefined],
      [{ paymentRequestId: '' }, 'paymentRequestId must not be empty', 'paymentRequestId'],
      [{ paymentRequestId: 'x'.repeat(41) }, 'paymentRequestId must be at most 40 characters', 'paymentRequestId'],
      [{ paymentRequestId: 'pr-1', method: 'paypal' }, 'method must be one of mpesa, bank, card, wallet, cash', 'method'],
      [{ paymentRequestId: 'pr-1', reference: 'r'.repeat(201) }, 'reference must be at most 200 characters', 'reference'],
      [{ paymentRequestId: 'pr-1', walletId: 'w-1' }, 'Unknown field(s): "walletId"', undefined],
    ] as Array<[Record<string, unknown>, string, string | undefined]>) {
      const res = await paymentsPost(payReq(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
      const parsed = await bodyOf(res)
      expect((parsed.error as string).startsWith(message), JSON.stringify(body)).toBe(true)
      if (field !== undefined) expect(parsed.field, JSON.stringify(body)).toBe(field)
      expect(svc.payPaymentRequest, JSON.stringify(body)).not.toHaveBeenCalled()
    }
  })

  it('unparseable JSON → 400 "Invalid JSON body"; array body → "Body must be a JSON object"', async () => {
    sessionFor('finance')
    const bad = await paymentsPost(
      new NextRequest('http://localhost/api/v1/payments', { method: 'POST', body: '{oops', headers: { 'content-type': 'application/json' } }),
    )
    expect(bad.status).toBe(400)
    expect((await bodyOf(bad)).error).toBe('Invalid JSON body')
    const array = await paymentsPost(
      new NextRequest('http://localhost/api/v1/payments', { method: 'POST', body: '[]', headers: { 'content-type': 'application/json' } }),
    )
    expect(array.status).toBe(400)
    expect((await bodyOf(array)).error).toBe('Body must be a JSON object')
  })
})

// ---------------------------------------------------------------- idempotency

describe('POST /api/v1/payments — Idempotency-Key (real withIdempotency)', () => {
  it("first keyed run records under the REQUEST's project; the repeat replays, service runs once", async () => {
    sessionFor('finance')
    const first = await paymentsPost(payReq({ paymentRequestId: 'pr-1' }, { 'idempotency-key': 'pay-1' }))
    expect(first.status).toBe(200)
    expect(state().idemRows).toEqual([
      { key: 'pay-1', scope: 'v1.payment.pay', projectId: 'p-1', responseBody: JSON.stringify(PAY_RESULT) },
    ])
    const replay = await paymentsPost(payReq({ paymentRequestId: 'pr-2' }, { 'idempotency-key': 'pay-1' }))
    expect(replay.status).toBe(200)
    expect(await bodyOf(replay)).toEqual({ ok: true, data: PAY_RESULT, replayed: true, scope: 'v1.payment.pay' })
    expect(svc.payPaymentRequest).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------- flag gate

describe('POST /api/v1/payments — wallet flag gate (uniform rule)', () => {
  it('flag OFF + client → 403 uniform shape BEFORE the request is resolved', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    invalidateFlagCache()
    sessionFor('client', 'p-1')
    const res = await paymentsPost(payReq({ paymentRequestId: 'pr-1' }))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({
      error: 'Feature disabled by feature flag (wallet) — an admin can re-enable it from the flags popover in the header',
    })
    expect(dbStub().paymentRequest.findFirst).not.toHaveBeenCalled()
    expect(svc.payPaymentRequest).not.toHaveBeenCalled()
  })

  it('flag OFF beats an EXISTING idempotency record (gate fires before the replay)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    invalidateFlagCache()
    state().idemRows.push({ key: 'pay-locked', scope: 'v1.payment.pay', projectId: 'p-1', responseBody: '{"paid":true}' })
    sessionFor('client', 'p-1')
    const res = await paymentsPost(payReq({ paymentRequestId: 'pr-1' }, { 'idempotency-key': 'pay-locked' }))
    expect(res.status).toBe(403)
    expect(dbStub().idempotencyRecord.findUnique).not.toHaveBeenCalled()
    expect(svc.payPaymentRequest).not.toHaveBeenCalled()
  })
})
