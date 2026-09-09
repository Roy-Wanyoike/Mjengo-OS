/**
 * BE-5 (issue #76) — raw-body caps on the two central mutation routes.
 *
 * /api/actions (1 MB) and /api/sync (2 MB) were the only JSON routes with NO
 * raw-body size cap (upload 12MB / share 64KB / whatsapp+daraja 64KB /
 * push 1MB all cap; route-kit maxBytes applies the SAME pattern). Pinned
 * here per acceptance criterion:
 *   · declared Content-Length over the cap → 413 from the precheck (a lying
 *     client never reaches the parser, zero bytes buffered beyond it);
 *   · an ACTUAL oversized body (valid or lying header) → 413 after the read,
 *     BEFORE JSON.parse — an oversized body is rejected even when its bytes
 *     are not valid JSON at all (the parse is never attempted);
 *   · the 413 body is the route-kit family message naming the cap;
 *   · nothing downstream runs on a 413 (applyAction NOT called — no
 *     idempotency read, no action dispatch);
 *   · small bodies still flow: a contractor POST /api/actions dispatches and
 *     a contractor POST /api/sync flushes exactly as before (regression:
 *     the cap must not change any status code or body shape under it).
 *
 * Mocks (the sync-flag-gate.test.ts idioms): '@/backend/lib/db' (flags +
 * project + idempotency stubs, conflict pre-checks miss), '@/backend/lib/guard'
 * (session control for route-kit's withGuard/publicRoute), '@/backend/lib/
 * mjengo' (applyAction spy). route-kit, rate-limit and action-flag-gate stay
 * REAL — the cap under test is the production pipeline's. Unique per-request
 * client IPs keep the token buckets cold.
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
    idemRows: [] as Array<Record<string, unknown>>,
    reset() {
      state.idemRows = []
    },
  }
  const nullFirst = async () => null
  const db = {
    __state: state,
    featureFlag: {
      async findMany({ where }: { where?: { key?: { in?: string[] } } }) {
        const keys = where?.key?.in
        return state.flagRows
          .filter((r) => !keys || keys.includes(r.key))
          .map((r) => ({ ...r }))
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
    // Conflict/stale-version pre-check lookups — no rows, so pre-checks pass.
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
  }
  return { db }
})

// Full fake guard: controls the session for route-kit's withGuard (sync) and
// publicRoute (actions). The contract mirrors guard.ts 1:1 — the real
// module's invariants are pinned in guard.test.ts.
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
  getProjectPayload: vi.fn(async () => ({ projectId: 'p-1', phases: [] })),
  getProjectsList: vi.fn(async () => [{ id: 'p-1', name: 'Riverside Villas' }]),
}))

import { POST as actionsPost } from '@/app/api/actions/route'
import { POST as syncPost } from '@/app/api/sync/route'
import { applyAction } from '@/backend/lib/mjengo'

/** Unique per-request client IP so token buckets never bleed between tests. */
let ipSeq = 0
function uniqueIp(): string {
  ipSeq += 1
  return `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`
}

function jsonReq(
  url: string,
  body: string,
  opts: { headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': uniqueIp(),
      ...(opts.headers ?? {}),
    },
    body,
  })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

function contractor() {
  h.session = {
    user: { id: 'u-1', email: 'contractor@test.dev', name: 'Bwana Kazi', role: 'contractor', projectId: null },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  contractor() // a signed-in principal for both routes by default
})

afterEach(() => {
  h.session = null
})

// ------------------------------------------------------------- /api/actions

describe('POST /api/actions — 1 MB raw-body cap (BE-5)', () => {
  it('declared Content-Length over the cap → 413 from the precheck, applyAction never runs', async () => {
    const res = await actionsPost(
      jsonReq(
        'http://localhost/api/actions',
        JSON.stringify({ type: 'task.update', payload: {} }),
        { headers: { 'content-length': String(1_048_576 + 1) } },
      ),
      undefined,
    )
    expect(res.status).toBe(413)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/Request body too large/)
    expect(body.error).toMatch(/1 MB/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('an ACTUAL oversized body → 413 BEFORE JSON.parse (garbage bytes are never parsed)', async () => {
    const res = await actionsPost(
      jsonReq('http://localhost/api/actions', 'x'.repeat(1_048_577)),
      undefined,
    )
    expect(res.status).toBe(413)
    expect((await bodyOf(res)).error).toMatch(/Request body too large/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('a small body still dispatches exactly as before (no behavior change under the cap)', async () => {
    const res = await actionsPost(
      jsonReq('http://localhost/api/actions', JSON.stringify({ type: 'task.update', payload: { id: 't-1', progress: 50 } })),
      undefined,
    )
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })
})

// ----------------------------------------------------------------- /api/sync

describe('POST /api/sync — 2 MB raw-body cap (BE-5)', () => {
  it('declared Content-Length over the cap → 413 from the precheck, applyAction never runs', async () => {
    const res = await syncPost(
      jsonReq(
        'http://localhost/api/sync',
        JSON.stringify({ actions: [{ id: 'a-1', type: 'task.update', payload: {} }] }),
        { headers: { 'content-length': String(2 * 1_048_576 + 1) } },
      ),
      undefined,
    )
    expect(res.status).toBe(413)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/Request body too large/)
    expect(body.error).toMatch(/2 MB/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('an ACTUAL oversized body → 413 BEFORE JSON.parse', async () => {
    const res = await syncPost(
      jsonReq('http://localhost/api/sync', 'y'.repeat(2 * 1_048_577)),
      undefined,
    )
    expect(res.status).toBe(413)
    expect((await bodyOf(res)).error).toMatch(/Request body too large/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('a small batch still flushes exactly as before (no behavior change under the cap)', async () => {
    const res = await syncPost(
      jsonReq(
        'http://localhost/api/sync',
        JSON.stringify({ actions: [{ id: 'a-1', type: 'task.update', payload: { id: 't-1', progress: 50 } }] }),
      ),
      undefined,
    )
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.synced).toBe(1)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })
})
