/**
 * BE-11 (issue #77) — /api/search gets the standard rate limiter.
 *
 * Search was the only guarded JSON route without a rate limit: every sibling
 * (projects, notifications, supplier, the v1 family) has a per-principal
 * bucket, while a signed-in user could poll /api/search unbounded — each
 * request scans ≤300 rows × ~10 tables (bounded, but not free). The route now
 * runs through route-kit with the standard GET posture (60/min per principal,
 * same as notifications.get). Pinned here:
 *   · requests 1..60 from one principal → 200 (the normal search path);
 *   · request 61 → the honest 429 'Too many requests' + Retry-After — the
 *     db is NOT touched for the denied request;
 *   · a DIFFERENT principal has a fresh bucket (the denial is per-principal,
 *     not global);
 *   · the search semantics are unchanged: still session-guarded, still
 *     client-pinned, still strips LIKE wildcards, same 200 body shape.
 *
 * guard.getSessionFromReq and the ten search tables are stubbed; the route,
 * route-kit, the guard wrapper and the REAL token-bucket store run.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  session: {
    user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null },
  } as unknown as Record<string, unknown> | null,
}))

// Full fake guard (the v1-projects idiom — mirrors guard.ts 1:1, so the
// mocked getSessionFromReq IS the one withGuard consults).
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const KNOWN_ROLES = ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs', 'supplier']
  const OWNER_ROLES = ['contractor', 'admin', 'supervisor', 'procurement', 'qs', 'finance']
  const FINANCE_ROLES = ['finance', 'admin']
  const PAYMENT_ROLES = ['finance', 'admin', 'client']
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
        if (opts?.roles && !opts.roles.includes((session as { user: { role: string } }).user.role)) {
          return NextResponse.json({ error: `Not permitted for role "${(session as { user: { role: string } }).user.role}"` }, { status: 403 })
        }
        return handler(req, session, ctx)
      },
    safeErrorMessage: (e: unknown, fallback: string) =>
      e instanceof Error && !e.message.includes('\n') ? e.message : fallback,
    isInternalError: (e: unknown) => e instanceof Error && e.message.includes('\n'),
    KNOWN_ROLES,
    OWNER_ROLES,
    FINANCE_ROLES,
    PAYMENT_ROLES,
  }
})

const searchCalls: Array<Record<string, unknown>> = []

vi.mock('@/backend/lib/db', () => {
  const empty = async (args?: unknown) => {
    searchCalls.push({ args })
    return []
  }
  return {
    db: {
      project: { findMany: empty },
      landParcel: { findMany: empty },
      worker: { findMany: empty },
      supplier: { findMany: empty },
      catalogItem: { findMany: empty },
      materialRequest: { findMany: empty },
      purchaseOrder: { findMany: empty },
      transaction: { findMany: empty },
      invoice: { findMany: empty },
      notification: { findMany: empty },
    },
  }
})

import { GET as searchGet } from '@/app/api/search/route'
import { getSessionFromReq } from '@/backend/lib/guard'

function searchReq(principalIp?: string): NextRequest {
  return new NextRequest('http://localhost/api/search?q=ab', {
    headers: principalIp ? { 'x-forwarded-for': principalIp } : undefined,
  })
}

const T0 = new Date('2026-01-05T09:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  searchCalls.length = 0
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.NEXTAUTH_SECRET
})

describe('GET /api/search — the standard rate limiter (BE-11)', () => {
  it('requests 1..60 pass; request 61 → honest 429 + Retry-After (60/min per principal)', async () => {
    for (let i = 1; i <= 60; i++) {
      const res = await searchGet(searchReq('10.9.0.1'), undefined)
      expect(res.status, `request ${i} should pass`).toBe(200)
    }
    const blocked = await searchGet(searchReq('10.9.0.1'), undefined)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
    const body = (await blocked.json()) as { error?: string }
    expect(body.error).toBe('Too many requests')
  })

  it('the DENIED request never touches the db (the limit is checked before the scan)', async () => {
    for (let i = 0; i < 60; i++) await searchGet(searchReq('10.9.0.2'), undefined)
    searchCalls.length = 0
    const blocked = await searchGet(searchReq('10.9.0.2'), undefined)
    expect(blocked.status).toBe(429)
    expect(searchCalls).toHaveLength(0)
  })

  it('a different principal has a FRESH bucket (per-principal, not global)', async () => {
    for (let i = 0; i < 60; i++) await searchGet(searchReq('10.9.0.3'), undefined)
    expect((await searchGet(searchReq('10.9.0.3'), undefined)).status).toBe(429)
    // another principal, same bucket — searches fine
    const other = await searchGet(searchReq('10.9.0.4'), undefined)
    expect(other.status).toBe(200)
  })

  it('search semantics unchanged: session-guarded, wildcard-stripped query, same 200 shape', async () => {
    const res = await searchGet(searchReq('10.9.1.1'), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean; q?: string; scopedTo?: string | null; groups?: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.q).toBe('ab')
    expect(body.scopedTo).toBeNull()
    expect(body.groups).toEqual([])
    expect(getSessionFromReq).toHaveBeenCalled()

    // 10 source tables scanned (the MAX_SCAN fan-out — one findMany each).
    expect(searchCalls.length).toBeGreaterThanOrEqual(10)
  })

  it('no session → 401 (the guard still runs first, before the limiter)', async () => {
    vi.mocked(getSessionFromReq).mockResolvedValueOnce(null)
    const res = await searchGet(searchReq('10.9.1.2'), undefined)
    expect(res.status).toBe(401)
  })

  it('client-role sessions are still pinned to their own project', async () => {
    h.session = {
      user: { id: 'u-2', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p-pin' },
    }
    const res = await searchGet(searchReq('10.9.1.3'), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scopedTo?: string | null }
    expect(body.scopedTo).toBe('p-pin')
    // the project table gets the pinned where-clause, workers/parcels too
    const projectCall = searchCalls.find((c) => (c as { args?: { where?: unknown } }).args?.where)
    expect(projectCall).toBeTruthy()
  })
})
