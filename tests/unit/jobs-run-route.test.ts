/**
 * Route-level invariants of POST /api/jobs/run auth selection
 * (src/app/api/jobs/run/route.ts — session path vs JOBS_RUN_TOKEN
 * bearer path).
 *
 * The full decision table, pinned with everything the route touches
 * except the token helper itself (kept REAL — its invariants are pinned
 * in jobs-token.test.ts):
 *   · JOBS_RUN_TOKEN unset → session path, byte-identical to the
 *     pre-token behavior (an Authorization header is simply ignored);
 *   · token set + no bearer credential → session path;
 *   · token set + matching credential → the bearer pipeline, and the
 *     session guard is never consulted;
 *   · token set + mismatching credential → 401 "Invalid jobs token"
 *     with NEITHER path invoked (fail closed — a failed machine
 *     credential never falls back to the session guard).
 *
 * src/backend/api/jobs (session POST), route-kit (publicRoute), db and
 * the jobs service are mocked — this file pins wiring, not drains.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/api/jobs', () => ({
  GET: vi.fn(),
  POST: vi.fn(async () => new Response(JSON.stringify({ ok: true, via: 'session' }), { status: 200 })),
}))
vi.mock('@/backend/lib/route-kit', () => ({
  // publicRoute(opts, handler) → route handler; the bearer pipeline is
  // represented by a fixed marker response (global Response — no TDZ).
  publicRoute: vi.fn(() => vi.fn(async () => new Response(JSON.stringify({ ok: true, via: 'bearer' }), { status: 200 }))),
  safeError: vi.fn(() => vi.fn()),
}))
vi.mock('@/backend/lib/db', () => ({ db: {} }))
vi.mock('@/backend/modules/jobs/service', () => ({
  enqueue: vi.fn(),
  isJobType: vi.fn(),
  runDueJobs: vi.fn(async () => ({ ran: 0, results: [] })),
}))

import { POST as sessionPost } from '@/backend/api/jobs'
import { POST as routePost } from '@/app/api/jobs/run/route'

const TOKEN = 'e'.repeat(64)

function jobsReq(headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/jobs/run', {
    method: 'POST',
    headers,
  })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.JOBS_RUN_TOKEN
})

describe('POST /api/jobs/run auth selection', () => {
  it('token unset, no header → the session path (historical behavior)', async () => {
    const res = await routePost(jobsReq(), undefined)
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ via: 'session' })
    expect(sessionPost).toHaveBeenCalledTimes(1)
  })

  it('token unset, Authorization presented → still the session path (byte-identical: the header is ignored)', async () => {
    const res = await routePost(jobsReq({ authorization: `Bearer ${TOKEN}` }), undefined)
    expect(await bodyOf(res)).toMatchObject({ via: 'session' })
  })

  it('token set, no Authorization header → the session path (browser/Intel-card flow)', async () => {
    process.env.JOBS_RUN_TOKEN = TOKEN
    const res = await routePost(jobsReq(), undefined)
    expect(await bodyOf(res)).toMatchObject({ via: 'session' })
    expect(sessionPost).toHaveBeenCalledTimes(1)
  })

  it('token set, matching credential → the bearer pipeline, session guard never consulted', async () => {
    process.env.JOBS_RUN_TOKEN = TOKEN
    const res = await routePost(jobsReq({ authorization: `Bearer ${TOKEN}` }), undefined)
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ via: 'bearer' })
    expect(sessionPost).not.toHaveBeenCalled()
  })

  it('token set, mismatching credential → 401, fail closed, neither path runs', async () => {
    process.env.JOBS_RUN_TOKEN = TOKEN
    const res = await routePost(jobsReq({ authorization: `Bearer ${'d'.repeat(64)}` }), undefined)
    expect(res.status).toBe(401)
    expect(await bodyOf(res)).toEqual({ error: 'Invalid jobs token' })
    expect(sessionPost).not.toHaveBeenCalled()
  })

  it('token set, non-bearer scheme (Basic) → not a machine credential → session path', async () => {
    process.env.JOBS_RUN_TOKEN = TOKEN
    const res = await routePost(jobsReq({ authorization: `Basic ${TOKEN}` }), undefined)
    expect(await bodyOf(res)).toMatchObject({ via: 'session' })
  })

  it('token set, malformed "Bearer" (no token) → treated as not presented → session path', async () => {
    process.env.JOBS_RUN_TOKEN = TOKEN
    const res = await routePost(jobsReq({ authorization: 'Bearer' }), undefined)
    expect(await bodyOf(res)).toMatchObject({ via: 'session' })
  })
})
