/**
 * Route-level invariants of the #164 health split: GET /api/health is the
 * PUBLIC liveness probe (ok/db/timestamp only) unless ONE of the three
 * detail gates passes, in which case the FULL pre-#164 diagnostics body
 * (uptimeSec, version, dbLatencyMs, job-queue counts, entity counts) is
 * returned.
 *
 * Pinned here (src/app/api/health/route.ts):
 *   · DEFAULT (no env opt-in, no machine header, no admin session):
 *     200 { ok, db: 'up', timestamp } — EXACTLY those keys, and the detail
 *     queries (jobRecord.groupBy + the three counts) NEVER run (the hot
 *     probe path pays one SELECT 1 — the issue's perf win);
 *   · DEFAULT + DB down: 503 { ok: false, db: 'down', timestamp } — the
 *     503 semantics probes rely on stay public and minimal, and the DB
 *     error text does NOT leak to the public body;
 *   · X-Health-Detail matching HEALTH_DETAIL_TOKEN (constant-time, the
 *     jobs/run helper): the full detail body, byte-for-byte the pre-#164
 *     shape; token unset or mismatching → minimal (fail closed, no
 *     default token);
 *   · HEALTH_PUBLIC_DETAIL=1|true: the demo-posture opt-in — full detail
 *     with no header;
 *   · an authenticated ADMIN session: full detail (the in-app
 *     SystemHealthCard path — overview/role-cards.tsx fetches this route
 *     with its session cookie); any other role, or a session decode that
 *     THROWS, stays minimal (a garbage cookie is "no session", never a 500
 *     — publicRoute's rule);
 *   · gated + DB down: 503 with the honest pre-#164 detail (error text,
 *     jobs/counts null — unknown, not zero).
 *
 * db and the guard's session decode are mocked (this file pins route
 * wiring, not SQLite or JWT); the constant-time compare helper
 * (lib/jobs-token.ts secretsMatch) stays REAL — its invariants are pinned
 * in jobs-token.test.ts — as does withRequestLogging (#204; vitest's
 * onConsoleLog filters the access lines).
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pkg from '../../package.json'

vi.mock('@/backend/lib/db', () => ({
  db: {
    $queryRaw: vi.fn(),
    jobRecord: { groupBy: vi.fn() },
    project: { count: vi.fn() },
    worker: { count: vi.fn() },
    notification: { count: vi.fn() },
  },
}))
vi.mock('@/backend/lib/guard', () => ({
  // The session decode is a mockable seam: null (signed out / probe), an
  // admin session, another role, or a thrown error — the four outcomes the
  // gate distinguishes.
  getSessionFromReq: vi.fn(),
}))

import { db } from '@/backend/lib/db'
import { getSessionFromReq } from '@/backend/lib/guard'
import { GET, healthDetailHeaderMatches, healthPublicDetailOptIn } from '@/app/api/health/route'

const TOKEN = 'h'.repeat(64)

function healthReq(headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/health', { method: 'GET', headers })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

/** Seed the mocked gated-path reads: one queued + one failed job, 3/5/7 counts. */
function seedDetailReads(): void {
  vi.mocked(db.jobRecord.groupBy).mockResolvedValue([
    { status: 'queued', _count: { _all: 2 } },
    { status: 'failed', _count: { _all: 1 } },
  ] as Awaited<ReturnType<typeof db.jobRecord.groupBy>>)
  vi.mocked(db.project.count).mockResolvedValue(3)
  vi.mocked(db.worker.count).mockResolvedValue(5)
  vi.mocked(db.notification.count).mockResolvedValue(7)
}

beforeEach(() => {
  vi.clearAllMocks()
  // Happy DB by default; the 503 tests override $queryRaw to reject.
  vi.mocked(db.$queryRaw).mockResolvedValue([])
  vi.mocked(db.jobRecord.groupBy).mockResolvedValue([])
  vi.mocked(db.project.count).mockResolvedValue(0)
  vi.mocked(db.worker.count).mockResolvedValue(0)
  vi.mocked(db.notification.count).mockResolvedValue(0)
  // Signed-out by default (the probe case).
  vi.mocked(getSessionFromReq).mockResolvedValue(null)
})

afterEach(() => {
  delete process.env.HEALTH_DETAIL_TOKEN
  delete process.env.HEALTH_PUBLIC_DETAIL
})

describe('GET /api/health — public liveness (the #164 split)', () => {
  it('default (no gate): 200 with EXACTLY the probe minimum — ok/db/timestamp, no counts/jobs/version/uptime/dbLatency', async () => {
    const res = await GET(healthReq())
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(Object.keys(body).sort()).toEqual(['db', 'ok', 'timestamp'])
    expect(body.ok).toBe(true)
    expect(body.db).toBe('up')
    expect(typeof body.timestamp).toBe('string')
  })

  it('default: the detail queries never run — the hot probe path pays one SELECT 1 and nothing more', async () => {
    await GET(healthReq())
    expect(db.$queryRaw).toHaveBeenCalledTimes(1)
    expect(db.jobRecord.groupBy).not.toHaveBeenCalled()
    expect(db.project.count).not.toHaveBeenCalled()
    expect(db.worker.count).not.toHaveBeenCalled()
    expect(db.notification.count).not.toHaveBeenCalled()
  })

  it('default + DB down: 503 minimal — ok:false/db:down/timestamp, and the DB error text does not leak to the public body', async () => {
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error('INTERNAL: sqlite file locked at /var/data/custom.db'))
    const res = await GET(healthReq())
    expect(res.status).toBe(503)
    const body = await bodyOf(res)
    expect(Object.keys(body).sort()).toEqual(['db', 'ok', 'timestamp'])
    expect(body).toEqual({ ok: false, db: 'down', timestamp: body.timestamp })
    expect(body.error).toBeUndefined()
  })

  it('X-Health-Detail matching HEALTH_DETAIL_TOKEN → 200 with the full pre-#164 detail body', async () => {
    process.env.HEALTH_DETAIL_TOKEN = TOKEN
    seedDetailReads()
    const res = await GET(healthReq({ 'x-health-detail': TOKEN }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(Object.keys(body).sort()).toEqual(
      ['ok', 'uptimeSec', 'version', 'timestamp', 'db', 'dbLatencyMs', 'jobs', 'counts'].sort(),
    )
    expect(body.ok).toBe(true)
    expect(body.db).toBe('up')
    expect(typeof body.uptimeSec).toBe('number')
    expect(typeof body.dbLatencyMs).toBe('number')
    expect(typeof body.timestamp).toBe('string')
    expect(body.version).toEqual({ name: pkg.name, version: pkg.version })
    expect(body.jobs).toEqual({ queued: 2, retrying: 0, failed: 1 })
    expect(body.counts).toEqual({ projects: 3, workers: 5, notifications: 7 })
  })

  it('header presented but HEALTH_DETAIL_TOKEN unset → minimal (fail closed — no default token)', async () => {
    const res = await GET(healthReq({ 'x-health-detail': TOKEN }))
    expect(res.status).toBe(200)
    expect(Object.keys(await bodyOf(res)).sort()).toEqual(['db', 'ok', 'timestamp'])
    expect(db.jobRecord.groupBy).not.toHaveBeenCalled()
  })

  it('header presented with the WRONG token → minimal', async () => {
    process.env.HEALTH_DETAIL_TOKEN = TOKEN
    const res = await GET(healthReq({ 'x-health-detail': 'd'.repeat(64) }))
    expect(res.status).toBe(200)
    expect(Object.keys(await bodyOf(res)).sort()).toEqual(['db', 'ok', 'timestamp'])
    expect(db.jobRecord.groupBy).not.toHaveBeenCalled()
  })

  it('HEALTH_PUBLIC_DETAIL=1 (no header, no session) → full detail — the explicit demo-posture opt-in', async () => {
    process.env.HEALTH_PUBLIC_DETAIL = '1'
    seedDetailReads()
    const res = await GET(healthReq())
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(Object.keys(body).sort()).toEqual(
      ['ok', 'uptimeSec', 'version', 'timestamp', 'db', 'dbLatencyMs', 'jobs', 'counts'].sort(),
    )
    expect(body.jobs).toEqual({ queued: 2, retrying: 0, failed: 1 })
    expect(body.counts).toEqual({ projects: 3, workers: 5, notifications: 7 })
  })

  it('an authenticated ADMIN session (no header, no env) → full detail — the in-app SystemHealthCard path', async () => {
    vi.mocked(getSessionFromReq).mockResolvedValue({
      user: { id: 'u-1', email: 'admin@mjengo.os', name: 'Admin', role: 'admin', projectId: null, supplierId: null },
    })
    seedDetailReads()
    const res = await GET(healthReq())
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(Object.keys(body).sort()).toEqual(
      ['ok', 'uptimeSec', 'version', 'timestamp', 'db', 'dbLatencyMs', 'jobs', 'counts'].sort(),
    )
    expect(body.jobs).toEqual({ queued: 2, retrying: 0, failed: 1 })
    expect(body.counts).toEqual({ projects: 3, workers: 5, notifications: 7 })
  })

  it('a NON-admin session (contractor) → minimal — only the admin role unlocks detail', async () => {
    vi.mocked(getSessionFromReq).mockResolvedValue({
      user: { id: 'u-2', email: 'c@mjengo.os', name: 'C', role: 'contractor', projectId: 'p-1', supplierId: null },
    })
    const res = await GET(healthReq())
    expect(res.status).toBe(200)
    expect(Object.keys(await bodyOf(res)).sort()).toEqual(['db', 'ok', 'timestamp'])
    expect(db.jobRecord.groupBy).not.toHaveBeenCalled()
  })

  it('a session decode that THROWS → minimal 200, never a 500 (a garbage cookie is "no session")', async () => {
    vi.mocked(getSessionFromReq).mockRejectedValue(new Error('jwt decode exploded'))
    const res = await GET(healthReq())
    expect(res.status).toBe(200)
    expect(Object.keys(await bodyOf(res)).sort()).toEqual(['db', 'ok', 'timestamp'])
  })

  it('gated (header + token) + DB down → 503 with the honest pre-#164 detail: error text, jobs/counts null (unknown, not zero)', async () => {
    process.env.HEALTH_DETAIL_TOKEN = TOKEN
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error('INTERNAL: sqlite file locked'))
    const res = await GET(healthReq({ 'x-health-detail': TOKEN }))
    expect(res.status).toBe(503)
    const body = await bodyOf(res)
    expect(Object.keys(body).sort()).toEqual(
      ['ok', 'uptimeSec', 'version', 'timestamp', 'db', 'error', 'jobs', 'counts'].sort(),
    )
    expect(body.ok).toBe(false)
    expect(body.db).toBe('down')
    expect(body.error).toBe('INTERNAL: sqlite file locked')
    expect(body.jobs).toBeNull()
    expect(body.counts).toBeNull()
    expect(body.version).toEqual({ name: pkg.name, version: pkg.version })
  })
})

describe('healthPublicDetailOptIn — the HEALTH_PUBLIC_DETAIL parse', () => {
  it('1 / true / TRUE / " 1 " opt in; everything else does not', () => {
    expect(healthPublicDetailOptIn('1')).toBe(true)
    expect(healthPublicDetailOptIn('true')).toBe(true)
    expect(healthPublicDetailOptIn('TRUE')).toBe(true)
    expect(healthPublicDetailOptIn(' 1 ')).toBe(true)
    expect(healthPublicDetailOptIn(undefined)).toBe(false)
    expect(healthPublicDetailOptIn('')).toBe(false)
    expect(healthPublicDetailOptIn('0')).toBe(false)
    expect(healthPublicDetailOptIn('false')).toBe(false)
    expect(healthPublicDetailOptIn('yes')).toBe(false)
    expect(healthPublicDetailOptIn('on')).toBe(false)
  })
})

describe('healthDetailHeaderMatches — the X-Health-Detail machine gate', () => {
  it('exact match → true; anything else → false (fail closed)', () => {
    expect(healthDetailHeaderMatches(TOKEN, TOKEN)).toBe(true)
    expect(healthDetailHeaderMatches('d'.repeat(64), TOKEN)).toBe(false)
    // Unset/empty configured token: the path is disabled entirely.
    expect(healthDetailHeaderMatches(TOKEN, undefined)).toBe(false)
    expect(healthDetailHeaderMatches(TOKEN, '')).toBe(false)
    // No/empty presented credential.
    expect(healthDetailHeaderMatches(null, TOKEN)).toBe(false)
    expect(healthDetailHeaderMatches('', TOKEN)).toBe(false)
    // Case matters for a secret.
    expect(healthDetailHeaderMatches(TOKEN.toUpperCase(), TOKEN)).toBe(false)
  })
})
