/**
 * API-9 (issue #160) — ONE jobs/run POST handler behind BOTH auth wrappers.
 *
 * src/backend/api/jobs.ts now exports the raw handleJobsRunPost(req, body);
 * the session route() export and the bearer publicRoute() wrapper in
 * src/app/api/jobs/run/route.ts both delegate to it. Pinned here from the
 * REAL implementation (jobs.ts, route.ts, route-kit and jobs-token all real;
 * guard/db/jobs-service mocked):
 *   · bearer path (JOBS_RUN_TOKEN + matching credential): unknown projectId
 *     → the honest 400 'Project not found' BEFORE any queue write; unknown
 *     type → 400 naming it; valid {type, projectId} → enqueue-then-drain and
 *     the { ok, ran, results } shape; an unparseable body is tolerated as {}
 *     (drain-only) — the historical contracts, previously only pinned on the
 *     session twin;
 *   · session path (no token env): the SAME 400s and the same success shape
 *     from the same implementation — the two wrappers cannot drift;
 *   · the route file contains no job logic beyond auth/policy wiring (that
 *     is pinned by construction: the only handler is the imported one).
 *
 * Each test uses a distinct x-forwarded-for IP — the real 10/min jobs.run
 * bucket is per-principal (route-kit + the REAL token-bucket store run).
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  session: {
    user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null },
  } as unknown as Record<string, unknown> | null,
}))

// Full fake guard (the search-rate-limit idiom — mirrors guard.ts 1:1, so the
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
          return NextResponse.json({ error: `Not permitted for role "${(session as { user: { role: string } }).user.role}` }, { status: 403 })
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

vi.mock('@/backend/lib/db', () => ({
  db: {
    // The 4b existence gate: only p-1 exists.
    project: {
      async findUnique({ where }: { where: { id: string } }) {
        return where.id === 'p-1' ? { id: 'p-1' } : null
      },
    },
  },
}))

const svc = vi.hoisted(() => ({
  enqueue: vi.fn(),
  isJobType: vi.fn((t: string) => t === 'digest.trust'),
  runDueJobs: vi.fn(),
  loadRecentJobs: vi.fn(),
}))
vi.mock('@/backend/modules/jobs/service', () => svc)

// jobs.ts (the shared handler), route.ts (both wrappers), route-kit and
// jobs-token all stay REAL — this file pins the single implementation.
import { POST as routePost } from '@/app/api/jobs/run/route'

const TOKEN = 'e'.repeat(64)

function jobsReq(ip: string, body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/jobs/run', {
    method: 'POST',
    headers: {
      'x-forwarded-for': ip,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
  h.session = {
    user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null },
  }
  svc.enqueue.mockReset()
  svc.runDueJobs.mockReset()
  svc.runDueJobs.mockResolvedValue({ ran: 1, results: [{ id: 'job-1', status: 'done' }] })
})

afterEach(() => {
  delete process.env.JOBS_RUN_TOKEN
  delete process.env.NEXTAUTH_SECRET
})

describe('bearer path — the shared handleJobsRunPost behind JOBS_RUN_TOKEN (API-9 / issue #160)', () => {
  beforeEach(() => {
    process.env.JOBS_RUN_TOKEN = TOKEN
  })

  it('an unknown projectId → honest 400 BEFORE any queue write', async () => {
    const res = await routePost(jobsReq('10.8.0.1', { type: 'digest.trust', projectId: 'nope' }, { authorization: `Bearer ${TOKEN}` }), undefined)
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Project not found' })
    expect(svc.enqueue).not.toHaveBeenCalled()
    expect(svc.runDueJobs).not.toHaveBeenCalled()
  })

  it('an unknown job type → honest 400 naming it, nothing enqueued or drained', async () => {
    const res = await routePost(jobsReq('10.8.0.2', { type: 'bogus.type' }, { authorization: `Bearer ${TOKEN}` }), undefined)
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown job type "bogus.type"' })
    expect(svc.enqueue).not.toHaveBeenCalled()
    expect(svc.runDueJobs).not.toHaveBeenCalled()
  })

  it('a valid {type, projectId} → enqueue-then-drain, { ok, ran, results } shape', async () => {
    const res = await routePost(jobsReq('10.8.0.3', { type: 'digest.trust', projectId: 'p-1' }, { authorization: `Bearer ${TOKEN}` }), undefined)
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: true, ran: 1, results: [{ id: 'job-1', status: 'done' }] })
    expect(svc.enqueue).toHaveBeenCalledTimes(1)
    expect(svc.enqueue).toHaveBeenCalledWith('digest.trust', 'p-1', {})
    expect(svc.runDueJobs).toHaveBeenCalledWith(10)
  })

  it('an unparseable body is tolerated as {} — drain-only, nothing enqueued', async () => {
    const res = await routePost(jobsReq('10.8.0.4', 'not json at all', { authorization: `Bearer ${TOKEN}` }), undefined)
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ ok: true, ran: 1 })
    expect(svc.enqueue).not.toHaveBeenCalled()
    expect(svc.runDueJobs).toHaveBeenCalledWith(10)
  })
})

describe('session path — the SAME shared handler, identical behavior (API-9 / issue #160)', () => {
  it('an unknown projectId → the same honest 400 as the bearer path', async () => {
    const res = await routePost(jobsReq('10.8.1.1', { type: 'digest.trust', projectId: 'nope' }), undefined)
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Project not found' })
    expect(svc.enqueue).not.toHaveBeenCalled()
  })

  it('a valid body → the same enqueue-then-drain success shape', async () => {
    const res = await routePost(jobsReq('10.8.1.2', { type: 'digest.trust', projectId: 'p-1' }), undefined)
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ ok: true, ran: 1 })
    expect(svc.enqueue).toHaveBeenCalledWith('digest.trust', 'p-1', {})
  })

  it('a non-owner role (client) never reaches the shared handler (the guard still runs first)', async () => {
    h.session = {
      user: { id: 'u-2', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p-1' },
    }
    const res = await routePost(jobsReq('10.8.1.3', { type: 'digest.trust' }), undefined)
    expect(res.status).toBe(403)
    expect(svc.enqueue).not.toHaveBeenCalled()
    expect(svc.runDueJobs).not.toHaveBeenCalled()
  })
})
