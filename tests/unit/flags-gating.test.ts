/**
 * Feature-flag gating invariants (task 9-a, "every flag gates its feature
 * or is honestly removed").
 *
 * The uniform ENFORCEMENT RULE under test, per flag:
 *   flag OFF  → the feature's API routes answer 403
 *               `Feature disabled by feature flag (<key>)` for NON-ADMIN
 *               sessions (admins bypass so they can toggle & test);
 *   flag ON   → the routes behave exactly as before.
 *
 * Route surfaces pinned here (the per-flag enforcement map lives in
 * src/backend/modules/intel/flags.ts):
 *   · ai_progress       → POST /api/ai/analyze-photo (the route was the gap —
 *                          only the Copilot button was gated before 9-a);
 *   · ai_voice          → POST /api/ai/voice-log (and the documented
 *                          NON-gating of /api/ai/parse-text);
 *   · wallet            → POST /api/actions WALLET_ACTIONS family (incl. the
 *                          gate-before-idempotency-replay rule and the
 *                          share-token / client-session paths) + the v1
 *                          REST family (GET /api/v1/wallets,
 *                          POST /api/v1/payments, POST deposit as the [id]
 *                          shape) — and the BOUNDARY: escrow.topup /
 *                          milestone.decide / invoice.pay keep flowing while
 *                          the flag is off (internal money paths, not the
 *                          user-facing wallet surface);
 *   · marketplace       → POST /api/actions SUPPLY_ACTIONS family (+ invoice
 *                          boundary);
 *   · land_verification → POST /api/actions LAND_ACTIONS family (+ the
 *                          professionals-module boundary);
 *   · low_data          → REMOVED: FLAG_KEYS/labels/pop rows no longer
 *                          contain it, a stale table row is inert, the env
 *                          override ignores it and setFlag rejects it.
 *
 * Mocks (the notify-channels / pii-scrub-wiring idioms): '@/backend/lib/db'
 * (in-memory stub incl. a stale low_data row), '@/backend/lib/guard' (full
 * fake — session control for BOTH direct-guard callers and route-kit's
 * withGuard; the real guard's contract is pinned in guard.test.ts),
 * '@/backend/lib/mjengo' (applyAction spy), '@/backend/lib/ai',
 * z-ai-web-dev-sdk (ASR), the wallet service/providers/http seams for the v1
 * routes. route-kit, rate-limit, audit, pii-scrub and flags itself stay
 * REAL. NEXT_FLAGS_OFF is the off-switch; invalidateFlagCache() resets the
 * 30s flag cache between cases.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

vi.mock('@/backend/lib/db', () => {
  const project = {
    id: 'p-1', name: 'Riverside Villas', location: 'Karen', client: 'Mama Njeri',
    shareToken: 'tok-1', startDate: new Date('2026-01-05T09:00:00Z'),
  }
  const paymentRequest = {
    id: 'pr-1', requestCode: 'PR-2026-000001', projectId: 'p-1', status: 'approved',
  }
  const state = {
    // 5 kept keys default-on + a STALE low_data row (pre-removal install):
    // reads filter to FLAG_KEYS so the stale row must be inert.
    flagRows: [
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
      { key: 'ai_voice', enabled: true, description: 'AI voice' },
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
      { key: 'low_data', enabled: false, description: 'Low-data mode option' },
    ],
    // A previously-recorded wallet replay (drives the gate-vs-replay pins).
    idemRows: [
      { key: 'idem-wallet-1', scope: 'payment.pay', projectId: 'p-1', responseBody: '{"ok":true}' },
    ] as Array<Record<string, unknown>>,
  }
  const db = {
    __state: state,
    featureFlag: {
      async upsert() { /* rows exist; lazy creation is a no-op here */ },
      async findMany({ where }: { where?: { key?: { in?: string[] } } }) {
        const keys = where?.key?.in
        return state.flagRows
          .filter((r) => !keys || keys.includes(r.key))
          .map((r) => ({ ...r }))
      },
      async update({ where, data }: { where: { key: string }; data: { enabled: boolean } }) {
        const row = state.flagRows.find((r) => r.key === where.key)
        if (!row) throw new Error('Record not found')
        row.enabled = data.enabled
        return { ...row }
      },
    },
    project: {
      async findUnique({ where }: { where: Record<string, string> }) {
        if (where.id !== undefined) return where.id === 'p-1' ? { ...project } : null
        if (where.shareToken !== undefined) return where.shareToken === 'tok-1' ? { ...project } : null
        return null
      },
      async findFirst() { return { ...project } },
      async findMany() { return [{ ...project }] },
    },
    phase: { async findMany() { return [] } },
    paymentRequest: {
      async findFirst({ where }: { where: { OR: Array<Record<string, string>> } }) {
        const id = where.OR.find((c) => c.id !== undefined)?.id
        const code = where.OR.find((c) => c.requestCode !== undefined)?.requestCode
        if (id === 'pr-1' || code === 'PR-2026-000001') return { ...paymentRequest }
        return null
      },
    },
    idempotencyRecord: {
      async findUnique({ where }: { where: { key: string } }) {
        return state.idemRows.find((r) => r.key === where.key) ?? null
      },
      async create({ data }: { data: Record<string, unknown> }) {
        state.idemRows.push({ ...data })
        return { ...data }
      },
    },
  }
  return { db }
})

// Full fake guard: controls the session for BOTH direct-guard callers
// (enforceAiRoutePolicy) AND route-kit's withGuard (whose real closure would
// otherwise call the unmocked getSessionFromReq). The contract mirrors
// guard.ts 1:1 — the real module's invariants are pinned in guard.test.ts.
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
      NextResponse.json(
        { error: role ? `Not permitted for role "${role}"` : 'Not permitted' },
        { status: 403 },
      ),
    withGuard:
      (handler: (req: NextRequest, session: unknown, ctx: unknown) => unknown, opts?: { roles?: readonly string[] }) =>
      async (req: NextRequest, ctx: unknown) => {
        const session = await getSessionFromReq(req)
        if (!session) return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
        if (opts?.roles && !opts.roles.includes(session.user.role)) {
          return NextResponse.json(
            { error: `Not permitted for role "${session.user.role}"` },
            { status: 403 },
          )
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

vi.mock('@/backend/lib/mjengo', () => ({
  applyAction: vi.fn(async () => ({ ok: true, applied: true })),
  getProjectPayload: vi.fn(async () => ({ project: { id: 'p-1' } })),
  getProjectsList: vi.fn(async () => [{ id: 'p-1', name: 'Riverside Villas' }]),
}))

const ai = vi.hoisted(() => ({
  visionMessage: vi.fn(),
  extractJson: vi.fn(),
  buildProjectDigest: vi.fn(),
  parseDeliveryTranscript: vi.fn(),
  asrCreate: vi.fn(),
}))

vi.mock('@/backend/lib/ai', () => ({
  visionMessage: ai.visionMessage,
  extractJson: ai.extractJson,
  buildProjectDigest: ai.buildProjectDigest,
  parseDeliveryTranscript: ai.parseDeliveryTranscript,
}))

vi.mock('z-ai-web-dev-sdk', () => ({
  default: {
    create: vi.fn(async () => ({ audio: { asr: { create: ai.asrCreate } } })),
  },
}))

const walletSvc = vi.hoisted(() => ({
  payPaymentRequest: vi.fn(),
  listWallets: vi.fn(),
  createWallet: vi.fn(),
  walletWithBalance: vi.fn(),
  depositWallet: vi.fn(),
  withdrawWallet: vi.fn(),
  transferWallet: vi.fn(),
}))

vi.mock('@/backend/modules/wallet/service', () => walletSvc)

vi.mock('@/backend/modules/wallet/http', async () => {
  const { NextResponse } = await import('next/server')
  return {
    // Passthrough with the real contract: the fn's result is wrapped as
    // { ok: true, data } (jsonOk). Idempotency replays are the real
    // module's job — these tests pin the flag gate, not §57.
    withIdempotency: vi.fn(async (_req: unknown, _scope: string, _projectId: string | null, fn: () => unknown) =>
      NextResponse.json({ ok: true, data: await fn() })),
    jsonOk: (data: unknown, extra?: Record<string, unknown>) =>
      NextResponse.json({ ok: true, data, ...(extra ?? {}) }),
  }
})

vi.mock('@/backend/modules/wallet/providers', () => ({
  PROVIDER_METHODS: [] as string[],
  getProvider: vi.fn(),
}))

import { db } from '@/backend/lib/db'
import {
  FLAG_KEYS, FLAG_LABELS, featureDisabledResponse, getFlags, invalidateFlagCache,
  requireFlagOn, setFlag,
} from '@/backend/modules/intel/flags'
import { POST as actionsPost } from '@/app/api/actions/route'
import { POST as analyzePhotoPost } from '@/app/api/ai/analyze-photo/route'
import { POST as voiceLogPost } from '@/app/api/ai/voice-log/route'
import { POST as parseTextPost } from '@/app/api/ai/parse-text/route'
import { GET as walletsGet } from '@/app/api/v1/wallets/route'
import { POST as paymentsPost } from '@/app/api/v1/payments/route'
import { POST as depositPost } from '@/app/api/v1/wallets/[id]/deposit/route'
import { applyAction } from '@/backend/lib/mjengo'

type SessionUser = NonNullable<typeof h.session>['user']

function sessionFor(role: string, projectId: string | null = null) {
  h.session = {
    user: { id: `u-${role}`, email: `${role}@test.dev`, name: role, role, projectId },
  }
}

function jsonReq(url: string, method: 'GET' | 'POST', body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function actionReq(type: string, payload: unknown = {}, extra?: { shareToken?: string; headers?: Record<string, string> }) {
  return jsonReq('http://localhost/api/actions', 'POST', { type, payload, shareToken: extra?.shareToken }, extra?.headers)
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

const ANALYSIS = {
  phaseShown: 'unknown',
  progressPct: 60,
  confidence: 0.7,
  observations: ['walls'],
  safety: [],
  materialsVisible: [],
  qualityFlags: [],
  summary: 'Ground floor walls approximately 60% complete.',
}

const PARSED = {
  transcript: 'ameleta bags ishirini ya cement',
  language: 'sw',
  supplier: 'Karioke',
  items: [],
  totalKES: 0,
  notes: null,
  confidence: 0.9,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  // Default service/SDK implementations (clearAllMocks keeps impls, but the
  // per-test overrides below make every case self-describing).
  ai.visionMessage.mockResolvedValue('{}')
  // extractJson is SYNCHRONOUS in lib/ai (returns the parsed value).
  ai.extractJson.mockReturnValue(ANALYSIS)
  ai.buildProjectDigest.mockResolvedValue({})
  ai.parseDeliveryTranscript.mockResolvedValue(PARSED)
  ai.asrCreate.mockResolvedValue({ text: 'ameleta bags ishirini ya cement' })
  walletSvc.payPaymentRequest.mockResolvedValue({ id: 'pr-1', status: 'paid' })
  walletSvc.listWallets.mockResolvedValue([{ id: 'w-1', code: 'W-0001' }])
  walletSvc.createWallet.mockResolvedValue({ id: 'w-2', code: 'W-0002' })
  walletSvc.walletWithBalance.mockResolvedValue({
    wallet: { id: 'w-1', code: 'W-0001', label: 'Main', ownerType: 'project', ownerId: 'p-1', currency: 'KES', status: 'active', ledgerAccountId: 'la-1' },
    balance: 1000,
  })
  walletSvc.depositWallet.mockResolvedValue({ ledgerRef: 'LT-1', balance: 1100 })
  walletSvc.withdrawWallet.mockResolvedValue({ ledgerRef: 'LT-2', balance: 900 })
  walletSvc.transferWallet.mockResolvedValue({ ledgerRef: 'LT-3', balance: 900 })
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

// ---------------------------------------------------------------- flags module

describe('flags registry after the low_data removal', () => {
  it('FLAG_KEYS is exactly the five kept keys — low_data is gone', () => {
    expect([...FLAG_KEYS]).toEqual([
      'ai_progress', 'ai_voice', 'wallet', 'marketplace', 'land_verification',
    ])
  })

  it('FLAG_LABELS covers every kept key and no low_data', () => {
    expect(Object.keys(FLAG_LABELS).sort()).toEqual([...FLAG_KEYS].sort())
    expect('low_data' in FLAG_LABELS).toBe(false)
  })

  it('getFlags() defaults every kept key ON — a stale low_data table row is inert', async () => {
    const flags = await getFlags()
    expect(Object.keys(flags).sort()).toEqual([...FLAG_KEYS].sort())
    for (const k of FLAG_KEYS) expect(flags[k], `${k} default on`).toBe(true)
  })

  it('NEXT_FLAGS_OFF naming the removed key is ignored (unknown keys never apply)', async () => {
    process.env.NEXT_FLAGS_OFF = 'low_data'
    const flags = await getFlags()
    for (const k of FLAG_KEYS) expect(flags[k]).toBe(true)
    expect('low_data' in flags).toBe(false)
  })

  it('NEXT_FLAGS_OFF forces exactly the named flags off', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_voice, wallet'
    const flags = await getFlags()
    expect(flags.ai_voice).toBe(false)
    expect(flags.wallet).toBe(false)
    expect(flags.ai_progress).toBe(true)
    expect(flags.marketplace).toBe(true)
    expect(flags.land_verification).toBe(true)
  })

  it('setFlag rejects the removed key (honest 400-material, no row write)', async () => {
    await expect(setFlag('low_data', true)).rejects.toThrow(/Unknown flag key/)
    const rows = (db as unknown as { __state: { flagRows: Array<{ key: string; enabled: boolean }> } }).__state.flagRows
    expect(rows.find((r) => r.key === 'low_data')?.enabled).toBe(false)
  })

  it('setFlag persists + cache-invalidates a kept flag', async () => {
    const flags = await setFlag('ai_voice', false)
    expect(flags.ai_voice).toBe(false)
    const rows = (db as unknown as { __state: { flagRows: Array<{ key: string; enabled: boolean }> } }).__state.flagRows
    expect(rows.find((r) => r.key === 'ai_voice')?.enabled).toBe(false)
    // And back on (leaves the table in the default state for later suites).
    await setFlag('ai_voice', true)
    expect(rows.find((r) => r.key === 'ai_voice')?.enabled).toBe(true)
  })
})

describe('requireFlagOn (the uniform route gate)', () => {
  it('flag on → null for any session', async () => {
    sessionFor('contractor')
    await expect(requireFlagOn('wallet', h.session)).resolves.toBeNull()
  })

  it('flag off + non-admin session → 403 Feature disabled, naming the flag', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('contractor')
    const denied = await requireFlagOn('wallet', h.session)
    expect(denied).not.toBeNull()
    expect(denied!.status).toBe(403)
    const body = await bodyOf(denied!)
    expect(body.error).toMatch(/Feature disabled by feature flag \(wallet\)/)
    expect(body.error).toMatch(/admin can re-enable/)
    expect(Object.keys(body)).toEqual(['error'])
  })

  it('flag off + ADMIN session → null (bypass: toggle & test)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('admin')
    await expect(requireFlagOn('wallet', h.session)).resolves.toBeNull()
  })

  it('flag off + null session (share-token caller) → 403 (non-admin)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    await expect(requireFlagOn('wallet', null)).resolves.not.toBeNull()
    const denied = await requireFlagOn('wallet', null)
    expect(denied!.status).toBe(403)
  })

  it('flag off + unknown role → 403 (fail closed)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    const denied = await requireFlagOn('wallet', { user: { role: 'intern' } })
    expect(denied).not.toBeNull()
    expect(denied!.status).toBe(403)
  })

  it('featureDisabledResponse body is the guard-family { error } shape', async () => {
    const res = featureDisabledResponse('ai_voice')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: expect.stringMatching(/Feature disabled by feature flag \(ai_voice\)/),
    })
  })
})

// ---------------------------------------------------------------- ai_progress

describe('ai_progress gates POST /api/ai/analyze-photo (the route, not just the button)', () => {
  const photoReq = () =>
    jsonReq('http://localhost/api/ai/analyze-photo', 'POST', {
      dataUrl: 'data:image/jpeg;base64,QUJDREVGRw==',
      projectId: 'p-1',
      apply: false,
    })

  it('off + contractor (site team) → 403, the vision model is never called', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress'
    sessionFor('contractor')
    const res = await analyzePhotoPost(photoReq(), undefined)
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/Feature disabled by feature flag \(ai_progress\)/)
    expect(ai.visionMessage).not.toHaveBeenCalled()
  })

  it('off + supervisor (also site team) → 403 — the bypass is admin-only', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress'
    sessionFor('supervisor')
    const res = await analyzePhotoPost(photoReq(), undefined)
    expect(res.status).toBe(403)
  })

  it('off + admin → 200, analysis flows (bypass so the flag can be tested)', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress'
    sessionFor('admin')
    const res = await analyzePhotoPost(photoReq(), undefined)
    expect(res.status).toBe(200)
    expect(ai.visionMessage).toHaveBeenCalledTimes(1)
    const json = await bodyOf(res)
    expect(json.ok).toBe(true)
    expect(json.analysis).toMatchObject({ progressPct: 60 })
  })

  it('on + contractor → 200 (the pre-9a behavior is unchanged)', async () => {
    sessionFor('contractor')
    const res = await analyzePhotoPost(photoReq(), undefined)
    expect(res.status).toBe(200)
    expect(ai.visionMessage).toHaveBeenCalledTimes(1)
  })

  it('off + finance (non site-team) → 403 from the ROLE allowlist, before the flag gate', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress'
    sessionFor('finance')
    const res = await analyzePhotoPost(photoReq(), undefined)
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/site-team roles/)
  })
})

// ---------------------------------------------------------------- ai_voice

describe('ai_voice gates POST /api/ai/voice-log', () => {
  const voiceReq = () =>
    jsonReq('http://localhost/api/ai/voice-log', 'POST', {
      audioBase64: 'QUJDREVGRw==',
      projectId: 'p-1',
    })

  it('off + contractor → 403, ASR is never called', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_voice'
    sessionFor('contractor')
    const res = await voiceLogPost(voiceReq(), undefined)
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/Feature disabled by feature flag \(ai_voice\)/)
    expect(ai.asrCreate).not.toHaveBeenCalled()
  })

  it('off + admin → 200, the transcript round-trips (bypass)', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_voice'
    sessionFor('admin')
    const res = await voiceLogPost(voiceReq(), undefined)
    expect(res.status).toBe(200)
    expect(ai.asrCreate).toHaveBeenCalledTimes(1)
    const json = await bodyOf(res)
    expect(json.ok).toBe(true)
    expect(json.transcript).toBe('ameleta bags ishirini ya cement')
  })

  it('on + contractor → 200 (normal behavior)', async () => {
    sessionFor('contractor')
    const res = await voiceLogPost(voiceReq(), undefined)
    expect(res.status).toBe(200)
    expect(ai.asrCreate).toHaveBeenCalledTimes(1)
  })

  it('BOUNDARY: off does NOT gate /api/ai/parse-text (the typed-note path)', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_voice'
    sessionFor('contractor')
    const res = await parseTextPost(
      jsonReq('http://localhost/api/ai/parse-text', 'POST', { text: 'bags 20 za cement', projectId: 'p-1' }),
      undefined,
    )
    expect(res.status).toBe(200)
    expect(ai.parseDeliveryTranscript).toHaveBeenCalledTimes(1)
    const json = await bodyOf(res)
    expect(json.ok).toBe(true)
  })
})

// ---------------------------------------------------------------- wallet (actions)

describe('wallet gates the WALLET_ACTIONS family on POST /api/actions', () => {
  it.each([
    'payment.request', 'payment.decide', 'payment.pay',
    'wallet.create', 'wallet.deposit', 'wallet.withdraw', 'wallet.transfer',
    'transaction.reverse', 'ledger.post',
  ])('off + contractor → 403 and applyAction never runs for %s', async (type) => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('contractor')
    const res = await actionsPost(actionReq(type), undefined)
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/Feature disabled by feature flag \(wallet\)/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('off + admin → the action applies (bypass)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('admin')
    const res = await actionsPost(actionReq('payment.request', { description: ' Cement', amount: 5000 }), undefined)
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(applyAction).toHaveBeenCalledWith('payment.request', expect.objectContaining({ __role: 'admin' }), undefined)
  })

  it('on + contractor → the action applies (normal behavior)', async () => {
    sessionFor('contractor')
    const res = await actionsPost(actionReq('payment.request'), undefined)
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
    const json = await bodyOf(res)
    expect(json.ok).toBe(true)
  })

  it('off + a stored Idempotency-Key replay → 403 BEFORE the replay (no echo while disabled)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('contractor')
    const res = await actionsPost(
      actionReq('payment.pay', { id: 'pr-1' }, { headers: { 'idempotency-key': 'idem-wallet-1' } }),
      undefined,
    )
    expect(res.status).toBe(403)
    const json = await bodyOf(res)
    expect(json.replayed).toBeUndefined()
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('on + the same replay key → the stored response IS replayed (gate placement keeps §57 intact)', async () => {
    sessionFor('contractor')
    const res = await actionsPost(
      actionReq('payment.pay', { id: 'pr-1' }, { headers: { 'idempotency-key': 'idem-wallet-1' } }),
      undefined,
    )
    expect(res.status).toBe(200)
    const json = await bodyOf(res)
    expect(json.replayed).toBe(true)
  })

  it('off + share-token caller (no session) → 403 — the share path is a non-admin', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    h.session = null
    const res = await actionsPost(actionReq('payment.pay', { id: 'pr-1' }, { shareToken: 'tok-1' }), undefined)
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/Feature disabled by feature flag \(wallet\)/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('off + client-role session → 403 (client payment.decide/pay is closed too)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('client', 'p-1')
    const res = await actionsPost(actionReq('payment.pay', { id: 'pr-1' }), undefined)
    expect(res.status).toBe(403)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it.each([
    ['escrow.topup', 'the escrow/milestone ladder (client release flow) keeps posting'],
    ['milestone.decide', 'milestone releases keep posting'],
    ['invoice.pay', 'the invoices module keeps posting'],
  ])('BOUNDARY: off does NOT gate %s — %s', async (type) => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('contractor')
    const res = await actionsPost(actionReq(type), undefined)
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------- marketplace (actions)

describe('marketplace gates the SUPPLY_ACTIONS family on POST /api/actions', () => {
  it('off + contractor → 403 and applyAction never runs (request.create)', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('contractor')
    const res = await actionsPost(actionReq('request.create', { lines: [] }), undefined)
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/Feature disabled by feature flag \(marketplace\)/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('off + contractor → 403 (supply.compare — the read-side compare too)', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('contractor')
    const res = await actionsPost(actionReq('supply.compare', { materialName: 'cement', qty: 50 }), undefined)
    expect(res.status).toBe(403)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('off + admin → the action applies (bypass)', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('admin')
    const res = await actionsPost(actionReq('order.create', { requestId: 'r-1', supplierId: 's-1' }), undefined)
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })

  it('on + contractor → the action applies (normal behavior)', async () => {
    sessionFor('contractor')
    const res = await actionsPost(actionReq('supplier.upsert', { businessName: 'Karioke' }), undefined)
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })

  it('BOUNDARY: off does NOT gate invoice.submit (the invoices module that shares the Finder tab)', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('contractor')
    const res = await actionsPost(actionReq('invoice.submit', { id: 'inv-1' }), undefined)
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------- land_verification (actions)

describe('land_verification gates the LAND_ACTIONS family on POST /api/actions', () => {
  it('off + contractor → 403 and applyAction never runs (parcel.create)', async () => {
    process.env.NEXT_FLAGS_OFF = 'land_verification'
    sessionFor('contractor')
    const res = await actionsPost(actionReq('parcel.create', { plotNumber: 'LR/1234', county: 'Kiambu' }), undefined)
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/Feature disabled by feature flag \(land_verification\)/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('off + contractor → 403 (search.request — the title-search ladder)', async () => {
    process.env.NEXT_FLAGS_OFF = 'land_verification'
    sessionFor('contractor')
    const res = await actionsPost(actionReq('search.request', { parcelId: 'par-1' }), undefined)
    expect(res.status).toBe(403)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('off + admin → the action applies (bypass)', async () => {
    process.env.NEXT_FLAGS_OFF = 'land_verification'
    sessionFor('admin')
    const res = await actionsPost(actionReq('search.request', { parcelId: 'par-1' }), undefined)
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })

  it('on + contractor → the action applies (normal behavior)', async () => {
    sessionFor('contractor')
    const res = await actionsPost(actionReq('parcelDoc.attach', { parcelId: 'par-1', kind: 'title_deed', fileName: 'deed.pdf', storageKey: 'docs/deed.pdf' }), undefined)
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })

  it('BOUNDARY: off does NOT gate professional.upsert (the professionals module that shares the Land tab)', async () => {
    process.env.NEXT_FLAGS_OFF = 'land_verification'
    sessionFor('contractor')
    const res = await actionsPost(actionReq('professional.upsert', { name: 'Eng. Mwangi' }), undefined)
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------- wallet (v1 REST)

describe('wallet gates the /api/v1 wallets + payments REST family', () => {
  it('GET /api/v1/wallets: off + finance → 403, listWallets never runs', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('finance')
    const res = await walletsGet(
      jsonReq('http://localhost/api/v1/wallets?limit=50', 'GET'),
      undefined,
    )
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/Feature disabled by feature flag \(wallet\)/)
    expect(walletSvc.listWallets).not.toHaveBeenCalled()
  })

  it('GET /api/v1/wallets: off + admin → 200 (bypass)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('admin')
    const res = await walletsGet(
      jsonReq('http://localhost/api/v1/wallets?limit=50', 'GET'),
      undefined,
    )
    expect(res.status).toBe(200)
    expect(walletSvc.listWallets).toHaveBeenCalledTimes(1)
    const json = await bodyOf(res)
    expect(json.ok).toBe(true)
    expect(Array.isArray(json.data)).toBe(true)
  })

  it('GET /api/v1/wallets: on + finance → 200 (normal behavior)', async () => {
    sessionFor('finance')
    const res = await walletsGet(
      jsonReq('http://localhost/api/v1/wallets?limit=50', 'GET'),
      undefined,
    )
    expect(res.status).toBe(200)
    expect(walletSvc.listWallets).toHaveBeenCalledTimes(1)
  })

  it('POST /api/v1/payments: off + finance → 403 BEFORE the request lookup, payPaymentRequest never runs', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('finance')
    const res = await paymentsPost(
      jsonReq('http://localhost/api/v1/payments', 'POST', { paymentRequestId: 'pr-1', method: 'mpesa' }),
      undefined,
    )
    expect(res.status).toBe(403)
    expect(walletSvc.payPaymentRequest).not.toHaveBeenCalled()
  })

  it('POST /api/v1/payments: off + admin → payment executes (bypass)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('admin')
    const res = await paymentsPost(
      jsonReq('http://localhost/api/v1/payments', 'POST', { paymentRequestId: 'pr-1', method: 'mpesa' }),
      undefined,
    )
    expect(res.status).toBe(200)
    expect(walletSvc.payPaymentRequest).toHaveBeenCalledTimes(1)
  })

  it('POST /api/v1/payments: on + finance → payment executes (normal behavior)', async () => {
    sessionFor('finance')
    const res = await paymentsPost(
      jsonReq('http://localhost/api/v1/payments', 'POST', { paymentRequestId: 'PR-2026-000001' }),
      undefined,
    )
    expect(res.status).toBe(200)
    expect(walletSvc.payPaymentRequest).toHaveBeenCalledTimes(1)
    expect(walletSvc.payPaymentRequest).toHaveBeenCalledWith('p-1', expect.objectContaining({ id: 'pr-1', paidByRole: 'finance' }))
  })

  it('POST /api/v1/wallets/:id/deposit: off + finance → 403 (the [id] dynamic-route shape)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('finance')
    const res = await depositPost(
      jsonReq('http://localhost/api/v1/wallets/w-1/deposit', 'POST', { amount: 1000, source: 'mpesa' }),
      { params: Promise.resolve({ id: 'w-1' }) },
    )
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/Feature disabled by feature flag \(wallet\)/)
    expect(walletSvc.depositWallet).not.toHaveBeenCalled()
  })

  it('POST /api/v1/wallets/:id/deposit: on + finance → deposit executes (normal behavior)', async () => {
    sessionFor('finance')
    const res = await depositPost(
      jsonReq('http://localhost/api/v1/wallets/w-1/deposit', 'POST', { amount: 1000, source: 'mpesa' }),
      { params: Promise.resolve({ id: 'w-1' }) },
    )
    expect(res.status).toBe(200)
    expect(walletSvc.depositWallet).toHaveBeenCalledTimes(1)
  })
})
