/**
 * W3-1 (security issue "S1" + "S2") — the offline sync drain enforces the
 * feature-flag family gate, and POST /api/share validates its body.
 *
 * S1 — the bug being closed: requireFlagOn() was only called by
 * /api/actions, so the /api/sync applier loop applied outbox items of the
 * WALLET/LAND/SUPPLY action families with NO gate — a contractor session
 * could flush payment.decide/pay, wallet/land/supply family items while the
 * wallet/land_verification/marketplace flags were OFF. The fix routes BOTH
 * endpoints through ONE shared gate definition (src/backend/lib/
 * action-flag-gate.ts). Pinned here per acceptance criterion:
 *   · contractor + wallet OFF + [payment.pay] → per-item ok:false with the
 *     flag-disabled error; ZERO ledger rows; ZERO IdempotencyRecord rows;
 *   · wallet ON → applies exactly as today (apply + idem + fingerprint rows);
 *   · admin + flag OFF → the item applies (documented bypass);
 *   · one LAND_ACTIONS and one SUPPLY_ACTIONS family case each;
 *   · non-flagged families (milestone.*, attendance.*, task.*) unaffected
 *     while every family flag is off (the honest boundary);
 *   · batch semantics — a denied item does not stop the rest of the outbox;
 *   · gate BEFORE the §57 idempotency replay (same placement rule as
 *     /api/actions: no ok-echo for an item the feature now refuses);
 *   · client-role sessions are gated too (payment.decide is client-allowed
 *     but still a WALLET_ACTIONS type).
 *
 * S2 — POST /api/share was the only public mutating route without zod or a
 * size cap. Pinned: 64 KB raw-body cap (declared Content-Length precheck +
 * actual byte count, mirroring the Daraja webhook), malformed JSON → 400,
 * schema failures → the shared { error, field? } shape, unknown fields
 * rejected, and a valid milestone.decide still works end-to-end.
 *
 * Mocks (the flags-gating idioms): '@/backend/lib/db' (in-memory stub with
 * flag rows + write-tracking idempotency/ledger tables), '@/backend/lib/guard'
 * (full fake — session control for route-kit's withGuard/publicRoute; the
 * real guard's contract is pinned in guard.test.ts), '@/backend/lib/mjengo'
 * (applyAction spy). route-kit, rate-limit, flags and action-flag-gate stay
 * REAL — the gate under test is the production one. NEXT_FLAGS_OFF is the
 * off-switch; invalidateFlagCache() resets the 30s flag cache between cases.
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
  const state = {
    flagRows: [
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
      { key: 'ai_voice', enabled: true, description: 'AI voice' },
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
    ],
    flagReads: 0,
    idemRows: [] as Array<Record<string, unknown>>,
    ledgerTxns: [] as Array<Record<string, unknown>>,
    ledgerEntries: [] as Array<Record<string, unknown>>,
    reset() {
      state.idemRows = []
      state.ledgerTxns = []
      state.ledgerEntries = []
      state.flagReads = 0
    },
  }
  const nullFirst = async () => null
  const db = {
    __state: state,
    featureFlag: {
      async upsert() { /* rows exist; lazy creation is a no-op here */ },
      async findMany({ where }: { where?: { key?: { in?: string[] } } }) {
        state.flagReads++
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
    // Conflict/stale-version pre-check lookups — no rows, so pre-checks pass
    // through and the flag gate is the only thing under test.
    milestone: { findFirst: nullFirst },
    variationOrder: { findFirst: nullFirst },
    invoice: { findFirst: nullFirst },
    paymentRequest: { findFirst: nullFirst },
    task: { findFirst: nullFirst },
    attendance: { findFirst: nullFirst },
    idempotencyRecord: {
      async findUnique({ where }: { where: { key: string } }) {
        return state.idemRows.find((r) => r.key === where.key) ?? null
      },
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: `idem_${state.idemRows.length + 1}`, ...data }
        state.idemRows.push(row)
        return { ...row }
      },
    },
    // Ledger tables: nothing writes them while applyAction is mocked — the
    // arrays exist so a misplaced gate (or a regression) that ever posted
    // money while a flag is off would be VISIBLE in these assertions.
    ledgerTransaction: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: `lt_${state.ledgerTxns.length + 1}`, ...data }
        state.ledgerTxns.push(row)
        return { ...row }
      },
    },
    ledgerEntry: {
      async create({ data }: { data: Record<string, unknown> }) {
        state.ledgerEntries.push({ ...data })
        return { ...data }
      },
    },
  }
  return { db }
})

// Full fake guard: controls the session for route-kit's withGuard (sync) and
// publicRoute (share). The contract mirrors guard.ts 1:1 — the real module's
// invariants are pinned in guard.test.ts.
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const KNOWN_ROLES = ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs']
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
    KNOWN_ROLES,
  }
})

vi.mock('@/backend/lib/mjengo', () => ({
  applyAction: vi.fn(async () => ({ ok: true, applied: true })),
  getProjectPayload: vi.fn(async () => null),
  getProjectsList: vi.fn(async () => []),
}))

import { db } from '@/backend/lib/db'
import { invalidateFlagCache, requireFlagOn } from '@/backend/modules/intel/flags'
import { FLAGGED_ACTION_FAMILIES, actionFlagGate, actionFlagGateMessage } from '@/backend/lib/action-flag-gate'
import { WALLET_ACTIONS } from '@/backend/actions/wallet'
import { LAND_ACTIONS } from '@/backend/actions/land'
import { SUPPLY_ACTIONS } from '@/backend/actions/supply'
import { AI_ACTIONS } from '@/backend/actions/ai'
import { POST as syncPost } from '@/app/api/sync/route'
import { POST as sharePost } from '@/app/api/share/route'
import { applyAction } from '@/backend/lib/mjengo'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    flagReads: number
    idemRows: Array<Record<string, unknown>>
    ledgerTxns: Array<Record<string, unknown>>
    ledgerEntries: Array<Record<string, unknown>>
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

function sessionFor(role: string, projectId: string | null = null) {
  h.session = {
    user: { id: `u-${role}`, email: `${role}@test.dev`, name: role, role, projectId },
  }
}

interface Queued {
  id: string
  type: string
  payload?: Record<string, unknown>
  projectId?: string
  force?: boolean
}

function syncReq(actions: Queued[]): NextRequest {
  return new NextRequest('http://localhost/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actions }),
  })
}

async function flush(actions: Queued[]): Promise<Record<string, any>> {
  const res = await syncPost(syncReq(actions), undefined)
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, any>
}

function shareReq(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

const idemKeys = () => state.idemRows.map((r) => String(r.key))

beforeEach(() => {
  vi.clearAllMocks()
  state.reset()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

// ---------------------------------------------------- the ONE shared gate table

describe('lib/action-flag-gate — the ONE definition both routes enforce', () => {
  it('FLAGGED_ACTION_FAMILIES maps exactly the four families to their flags', () => {
    expect(FLAGGED_ACTION_FAMILIES).toEqual([
      { actions: WALLET_ACTIONS, flag: 'wallet' },
      { actions: LAND_ACTIONS, flag: 'land_verification' },
      { actions: SUPPLY_ACTIONS, flag: 'marketplace' },
      // W6-1: the user-facing AI analysis actions — ai.drawReview today —
      // behind the DEFAULT-OFF `ai` flag (same enforcement, both routes).
      { actions: AI_ACTIONS, flag: 'ai' },
    ])
    // Spot checks that the family lists are the live module ones, not copies:
    expect(WALLET_ACTIONS).toContain('payment.pay')
    expect(LAND_ACTIONS).toContain('parcel.create')
    expect(SUPPLY_ACTIONS).toContain('supplier.upsert')
    expect(AI_ACTIONS).toContain('ai.drawReview')
  })

  it('a NON-flagged action short-circuits to allowed WITHOUT reading the flag table', async () => {
    sessionFor('contractor')
    process.env.NEXT_FLAGS_OFF = 'wallet,marketplace,land_verification'
    const readsBefore = state.flagReads
    await expect(actionFlagGate('milestone.decide', h.session)).resolves.toBeNull()
    await expect(actionFlagGateMessage('task.update', h.session)).resolves.toBeNull()
    expect(state.flagReads).toBe(readsBefore) // no db flag read for non-flagged types
  })

  it('actionFlagGate: flag off + contractor → the uniform 403; admin → null (bypass)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('contractor')
    const denied = await actionFlagGate('payment.pay', h.session)
    expect(denied).not.toBeNull()
    expect(denied!.status).toBe(403)
    expect((await bodyOf(denied!)).error).toMatch(/Feature disabled by feature flag \(wallet\)/)

    sessionFor('admin')
    await expect(actionFlagGate('payment.pay', h.session)).resolves.toBeNull()
  })

  it('actionFlagGateMessage returns the SAME copy the 403 response carries (zero drift)', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('contractor')
    const message = await actionFlagGateMessage('supplier.upsert', h.session)
    const denied = await requireFlagOn('marketplace', h.session)
    expect(message).not.toBeNull()
    expect(message).toBe((await bodyOf(denied!)).error)
  })
})

// ------------------------------------------------- S1: /api/sync wallet family

describe('POST /api/sync — the wallet flag gates WALLET_ACTIONS per item (S1)', () => {
  const payItem: Queued = { id: 'pay-1', type: 'payment.pay', payload: { id: 'pr-1', method: 'mpesa' }, projectId: 'p-1' }

  it('contractor + wallet OFF → per-item ok:false with the flag-disabled error; ZERO ledger rows, ZERO idempotency rows', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('contractor')
    const json = await flush([payItem])
    expect(json.ok).toBe(true)
    expect(json.synced).toBe(0)
    expect(json.failed).toBe(1)
    expect(json.conflicts).toBe(0)
    expect(json.results[0]).toEqual({
      id: 'pay-1',
      ok: false,
      error: expect.stringMatching(/Feature disabled by feature flag \(wallet\).*admin can re-enable/),
    })
    expect('conflict' in json.results[0]).toBe(false) // plain per-item failure, not a §41 conflict
    expect(applyAction).not.toHaveBeenCalled()
    expect(idemKeys()).toEqual([]) // no sync:<project>:<item> key, no fingerprint key — nothing was applied
    expect(state.ledgerTxns).toEqual([]) // zero ledger rows
    expect(state.ledgerEntries).toEqual([])
  })

  it('wallet ON → applies exactly as today: applyAction once, idem + fingerprint rows recorded', async () => {
    sessionFor('contractor')
    const json = await flush([payItem])
    expect(json.results[0]).toMatchObject({ id: 'pay-1', ok: true })
    expect(json.synced).toBe(1)
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(applyAction).toHaveBeenCalledWith(
      'payment.pay',
      expect.objectContaining({ id: 'pr-1', __actor: 'contractor', __role: 'contractor' }),
      'p-1',
    )
    expect(idemKeys()).toContain('sync:p-1:pay-1')
    expect(idemKeys().some((k) => k.startsWith('syncfp:'))).toBe(true) // payment.pay is fingerprint-deduped
  })

  it('admin + wallet OFF → the item applies (documented bypass, same as /api/actions)', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('admin')
    const json = await flush([payItem])
    expect(json.results[0]).toMatchObject({ id: 'pay-1', ok: true })
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(applyAction).toHaveBeenCalledWith(
      'payment.pay',
      expect.objectContaining({ __actor: 'admin', __role: 'admin' }),
      'p-1',
    )
    expect(idemKeys()).toContain('sync:p-1:pay-1')
  })

  it('client-role session + wallet OFF → payment.decide (client-ALLOWLISTED but a WALLET_ACTIONS type) is denied per-item', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('client', 'p-1')
    const json = await flush([{ id: 'dec-1', type: 'payment.decide', payload: { id: 'pr-1', decision: 'approve' } }])
    expect(json.results[0]).toMatchObject({
      id: 'dec-1',
      ok: false,
      error: expect.stringMatching(/Feature disabled by feature flag \(wallet\)/),
    })
    expect(applyAction).not.toHaveBeenCalled()
    expect(idemKeys()).toEqual([])
  })

  it('batch semantics: a denied item does not stop the rest of the outbox', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet'
    sessionFor('contractor')
    const json = await flush([
      { id: 'm-1', type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve' }, projectId: 'p-1' },
      payItem,
      { id: 't-1', type: 'task.update', payload: { id: 'task-1', progress: 50 }, projectId: 'p-1' },
    ])
    expect(json.results).toMatchObject([
      { id: 'm-1', ok: true },
      { id: 'pay-1', ok: false, error: expect.stringMatching(/Feature disabled by feature flag \(wallet\)/) },
      { id: 't-1', ok: true },
    ])
    expect(json.synced).toBe(2)
    expect(json.failed).toBe(1)
    expect(applyAction).toHaveBeenCalledTimes(2) // milestone + task only
    expect(idemKeys()).toContain('sync:p-1:m-1')
    expect(idemKeys()).toContain('sync:p-1:t-1')
    expect(idemKeys()).not.toContain('sync:p-1:pay-1')
  })

  it('gate BEFORE the §57 replay: an already-applied item re-flushed while the flag is OFF is denied, not ok-echoed', async () => {
    sessionFor('contractor')
    await flush([payItem]) // applied + recorded while the flag is on
    expect(idemKeys()).toContain('sync:p-1:pay-1')

    process.env.NEXT_FLAGS_OFF = 'wallet'
    invalidateFlagCache()
    const json = await flush([payItem])
    expect(json.results[0]).toMatchObject({
      id: 'pay-1',
      ok: false,
      error: expect.stringMatching(/Feature disabled by feature flag \(wallet\)/),
    })
    expect(applyAction).toHaveBeenCalledTimes(1) // only the first (pre-toggle) apply
    expect(idemKeys().filter((k) => k === 'sync:p-1:pay-1')).toHaveLength(1) // no second record either
  })
})

// --------------------------------------- S1: /api/sync land + marketplace families

describe('POST /api/sync — land_verification and marketplace gate their families per item (S1)', () => {
  it('land_verification OFF + [parcel.create] → per-item denial naming land_verification, nothing written', async () => {
    process.env.NEXT_FLAGS_OFF = 'land_verification'
    sessionFor('contractor')
    const json = await flush([
      { id: 'par-1', type: 'parcel.create', payload: { plotNumber: 'LR/1234', county: 'Kiambu' }, projectId: 'p-1' },
    ])
    expect(json.results[0]).toEqual({
      id: 'par-1',
      ok: false,
      error: expect.stringMatching(/Feature disabled by feature flag \(land_verification\)/),
    })
    expect(applyAction).not.toHaveBeenCalled()
    expect(idemKeys()).toEqual([])
  })

  it('land_verification ON + [parcel.create] → the item applies (the gate never over-blocks)', async () => {
    sessionFor('contractor')
    const json = await flush([
      { id: 'par-1', type: 'parcel.create', payload: { plotNumber: 'LR/1234', county: 'Kiambu' }, projectId: 'p-1' },
    ])
    expect(json.results[0]).toMatchObject({ id: 'par-1', ok: true })
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(idemKeys()).toContain('sync:p-1:par-1')
  })

  it('marketplace OFF + [supplier.upsert] → per-item denial naming marketplace, nothing written', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('contractor')
    const json = await flush([
      { id: 'sup-1', type: 'supplier.upsert', payload: { businessName: 'Karioke' }, projectId: 'p-1' },
    ])
    expect(json.results[0]).toEqual({
      id: 'sup-1',
      ok: false,
      error: expect.stringMatching(/Feature disabled by feature flag \(marketplace\)/),
    })
    expect(applyAction).not.toHaveBeenCalled()
    expect(idemKeys()).toEqual([])
  })

  it('marketplace ON + [supplier.upsert] → the item applies (the gate never over-blocks)', async () => {
    sessionFor('contractor')
    const json = await flush([
      { id: 'sup-1', type: 'supplier.upsert', payload: { businessName: 'Karioke' }, projectId: 'p-1' },
    ])
    expect(json.results[0]).toMatchObject({ id: 'sup-1', ok: true })
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(idemKeys()).toContain('sync:p-1:sup-1')
  })
})

// ------------------------------------------ S1 boundary: non-flagged families

describe('POST /api/sync — non-flagged families are unaffected while every family flag is OFF', () => {
  it('milestone.decide + attendance.setStatus + task.update all apply with wallet/marketplace/land_verification off', async () => {
    process.env.NEXT_FLAGS_OFF = 'wallet,marketplace,land_verification'
    sessionFor('contractor')
    const json = await flush([
      { id: 'm-1', type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve' }, projectId: 'p-1' },
      { id: 'a-1', type: 'attendance.setStatus', payload: { workerId: 'w-1', status: 'present' }, projectId: 'p-1' },
      { id: 't-1', type: 'task.update', payload: { id: 'task-1', progress: 50 }, projectId: 'p-1' },
    ])
    expect(json.results).toMatchObject([
      { id: 'm-1', ok: true },
      { id: 'a-1', ok: true },
      { id: 't-1', ok: true },
    ])
    expect(json.failed).toBe(0)
    expect(applyAction).toHaveBeenCalledTimes(3)
    expect(idemKeys()).toContain('sync:p-1:m-1')
    expect(idemKeys()).toContain('sync:p-1:a-1')
    expect(idemKeys()).toContain('sync:p-1:t-1')
  })
})

// ------------------------------------------------- S2: POST /api/share validation

describe('POST /api/share — zod strictObject + 64 KB raw-body cap (S2)', () => {
  it('actual body > 64 KB → 400 honest size error, the token lookup never runs', async () => {
    const res = await sharePost(
      shareReq({ token: 'tok-1', type: 'comment.add', payload: { text: 'x'.repeat(70_000) } }),
      undefined,
    )
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).error).toMatch(/Request body too large.*64 KB/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('declared Content-Length > 64 KB → 400 from the precheck (a lying client never reaches the parser)', async () => {
    const res = await sharePost(
      shareReq({ token: 'tok-1', type: 'comment.add' }, { 'content-length': String(64 * 1024 + 1) }),
      undefined,
    )
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).error).toMatch(/Request body too large/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('malformed JSON → 400 Invalid JSON body', async () => {
    const res = await sharePost(shareReq('{"token": "tok-1", "type":'), undefined)
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Invalid JSON body' })
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('schema-invalid field → 400 with the shared { error, field } shape', async () => {
    const res = await sharePost(shareReq({ token: 123, type: 'milestone.decide' }), undefined)
    expect(res.status).toBe(400)
    const json = await bodyOf(res)
    expect(json.field).toBe('token')
    expect(String(json.error)).toMatch(/token/)
  })

  it('non-object payload → 400 with field "payload"', async () => {
    const res = await sharePost(shareReq({ token: 'tok-1', type: 'milestone.decide', payload: ['nope'] }), undefined)
    expect(res.status).toBe(400)
    const json = await bodyOf(res)
    expect(json.field).toBe('payload')
  })

  it('unknown top-level field → 400 Unknown field(s) (strictObject typo protection)', async () => {
    const res = await sharePost(
      shareReq({ token: 'tok-1', type: 'milestone.decide', payload: {}, extra: 'typo' }),
      undefined,
    )
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).error).toMatch(/Unknown field\(s\): "extra"/)
  })

  it('valid milestone.decide → 200, actor stamped from the link (the pre-W3-1 behavior)', async () => {
    const res = await sharePost(
      shareReq({ token: 'tok-1', type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve' } }),
      undefined,
    )
    expect(res.status).toBe(200)
    const json = await bodyOf(res)
    expect(json.ok).toBe(true)
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(applyAction).toHaveBeenCalledWith(
      'milestone.decide',
      expect.objectContaining({ id: 'ms-1', decision: 'approve', __actor: 'Mama Njeri', __role: 'client' }),
      'p-1',
    )
  })

  it('a non-allowlisted type still answers the 403 (policy stays OUT of the zod 400s)', async () => {
    const res = await sharePost(shareReq({ token: 'tok-1', type: 'payment.pay', payload: { id: 'pr-1' } }), undefined)
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toBe('Not permitted from a client link')
    expect(applyAction).not.toHaveBeenCalled()
  })
})
