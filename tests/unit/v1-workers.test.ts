/**
 * /api/v1 Phase D (task 7-b) — the WORKFORCE read surface:
 * GET /api/v1/projects/:id/workers and GET /api/v1/workers/:id.
 *
 * Pinned invariants:
 *   · ROLE SCOPING mirrors the v1 payments precedent — resolve first, pin
 *     second: any signed-in role may read; a client-role session is pinned
 *     to its own project (foreign → 403 'Not permitted for this project',
 *     indistinguishable for probes; own → 200); unknown project/worker →
 *     404; anonymous → 401. W5-3: supplier sessions are not project readers
 *     — uniform 403 'Not permitted for this supplier account'.
 *   · NO FEATURE FLAG gates these resources — even with every flag forced
 *     off, the reads still answer 200 (none of the five flags names the
 *     workforce surface).
 *   · KEYSET PAGINATION — the list is the payload's own (name ASC, id ASC)
 *     roster order (Worker has NO createdAt column — honest absence), pages
 *     never overlap, ?active= filters BEFORE pagination, a cursor outside
 *     the (filtered) list → 400 { field }.
 *   · HONEST ABSENCES — Worker.pin (the kiosk PIN — a bearer credential) is
 *     never served; no createdAt/updatedAt are fabricated; the LIST carries
 *     the payload's rollup (todayStatus/weekEarnings) but NO total attendance
 *     count — the true counts live on the DETAIL, which reads the whole
 *     history and derives todayStatus/weekEarnings with the payload's exact
 *     logic (EAT "today", trailing 7 days — pinned with fake timers).
 *   · The OpenAPI document carries the two new paths (27 /api/v1 total) with
 *     matching operationIds + tags + the WorkerSummary/WorkerDetail schemas.
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control for route-kit's withGuard), '@/backend/lib/db' (worker.findFirst —
 * the detail route's direct read) and '@/backend/lib/mjengo'
 * (getProjectPayload — the payload's workers read). route-kit, rate-limit,
 * respond/schemas/worker-rows and the routes themselves stay REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

const d = (iso: string) => new Date(iso)

// ---------------------------------------------------------------- fixtures (hoisted for the db factory)

/**
 * Three workers of p-1 (payload shape — the route projects these verbatim;
 * todayStatus/weekEarnings are the payload's OWN derivations, EAT "today"
 * pinned by fake timers to 2026-02-14). Roster order (name ASC): Amina,
 * Baraka, Chelu.
 */
const WORKERS = [
  {
    id: 'wrk-00000001', projectId: 'p-1', name: 'Amina Njeri', role: 'Fundi wa Mawe (Mason)', phone: '+254712000001',
    dailyRate: 1500, active: true, employmentType: 'casual', skills: '["masonry","plastering"]',
    idNumber: '28491022', emergencyContactName: 'Njeri Mwangi', emergencyContactPhone: '+254722000009',
    todayStatus: {
      status: 'present', checkIn: '2026-02-14T04:30:00.000Z', checkOut: '2026-02-14T12:30:00.000Z',
      method: 'kiosk_pin', wage: 1500, paid: true, verification: 'verified', exceptionReason: null,
    },
    weekEarnings: 3750,
  },
  {
    id: 'wrk-00000002', projectId: 'p-1', name: 'Baraka Otieno', role: 'Foreman', phone: '+254712000002',
    dailyRate: 2000, active: true, employmentType: null, skills: null,
    idNumber: null, emergencyContactName: null, emergencyContactPhone: null,
    todayStatus: {
      status: null, checkIn: null, checkOut: null, method: null, wage: 0, paid: false,
      verification: null, exceptionReason: null,
    },
    weekEarnings: 0,
  },
  {
    // malformed stored skills JSON — must parse to [], never a 500
    id: 'wrk-00000003', projectId: 'p-1', name: 'Chelu Mwangi', role: 'Mtumishi (Labourer)', phone: '+254712000003',
    dailyRate: 800, active: false, employmentType: 'contract', skills: 'not-json',
    idNumber: null, emergencyContactName: null, emergencyContactPhone: null,
    todayStatus: {
      status: 'absent', checkIn: null, checkOut: null, method: 'manager', wage: 0, paid: true,
      verification: 'reported', exceptionReason: 'network',
    },
    weekEarnings: 0,
  },
]

/** The detail route's whole-history attendance rows for wrk-00000001 (date DESC). */
const W1_ATTENDANCES = [
  {
    id: 'att-00000001', workerId: 'wrk-00000001', projectId: 'p-1', date: '2026-02-14',
    status: 'present', checkIn: d('2026-02-14T04:30:00Z'), checkOut: d('2026-02-14T12:30:00Z'),
    method: 'kiosk_pin', wage: 1500, paid: true, synced: true, verification: 'verified',
    evidence: '["pin","gps"]', exceptionReason: null, exceptionNote: null, overrideLog: null,
    recordedBy: 'Kiosk (site device)', createdAt: d('2026-02-14T07:30:00Z'), version: 1,
  },
  {
    id: 'att-00000002', workerId: 'wrk-00000001', projectId: 'p-1', date: '2026-02-13',
    status: 'present', checkIn: d('2026-02-13T04:35:00Z'), checkOut: null,
    method: 'geofence', wage: 1500, paid: false, synced: true, verification: 'reported',
    evidence: '["supervisor"]', exceptionReason: null, exceptionNote: null, overrideLog: '[]',
    recordedBy: 'Joe (Foreman)', createdAt: d('2026-02-13T18:00:00Z'), version: 1,
  },
  {
    id: 'att-00000003', workerId: 'wrk-00000001', projectId: 'p-1', date: '2026-02-12',
    status: 'absent', checkIn: null, checkOut: null,
    method: 'manager', wage: 0, paid: true, synced: true, verification: 'reported',
    evidence: null, exceptionReason: null, exceptionNote: null, overrideLog: '[]',
    recordedBy: 'Joe (Foreman)', createdAt: d('2026-02-12T18:00:00Z'), version: 1,
  },
  {
    id: 'att-00000004', workerId: 'wrk-00000001', projectId: 'p-1', date: '2026-02-11',
    status: 'half_day', checkIn: d('2026-02-11T04:30:00Z'), checkOut: d('2026-02-11T09:00:00Z'),
    method: 'app', wage: 750, paid: false, synced: true, verification: 'exception',
    // malformed stored evidence JSON — must count 0, never a 500
    evidence: 'not-json', exceptionReason: 'forgot', exceptionNote: 'Left phone at home.',
    overrideLog: '[{"at":"2026-02-12T10:00:00.000Z","by":"Joe (Foreman)","from":"present","to":"half_day","reason":"Left site at noon"}]',
    recordedBy: 'Joe (Foreman)', createdAt: d('2026-02-11T18:00:00Z'), version: 2,
  },
  {
    id: 'att-00000005', workerId: 'wrk-00000001', projectId: 'p-1', date: '2026-02-10',
    status: 'excused', checkIn: null, checkOut: null,
    method: 'manager', wage: 0, paid: true, synced: true, verification: 'reported',
    evidence: '["supervisor"]', exceptionReason: 'emergency', exceptionNote: null, overrideLog: '[]',
    recordedBy: 'Joe (Foreman)', createdAt: d('2026-02-10T18:00:00Z'), version: 1,
  },
  {
    // outside the trailing-7-day window (weekEarnings must exclude it)
    id: 'att-00000006', workerId: 'wrk-00000001', projectId: 'p-1', date: '2026-01-20',
    status: 'present', checkIn: d('2026-01-20T04:30:00Z'), checkOut: d('2026-01-20T12:30:00Z'),
    method: 'ussd', wage: 1500, paid: true, synced: true, verification: 'verified',
    evidence: '["ussd"]', exceptionReason: null, exceptionNote: null, overrideLog: '[]',
    recordedBy: 'Amina Njeri', createdAt: d('2026-01-20T18:00:00Z'), version: 1,
  },
]

vi.mock('@/backend/lib/db', () => {
  const state = {
    flagRows: [
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
      { key: 'ai_voice', enabled: true, description: 'AI voice' },
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
    ],
  }
  return {
    db: {
      __state: state,
      featureFlag: {
        async upsert() { /* rows exist; lazy creation is a no-op here */ },
        async findMany({ where }: { where?: { key?: { in?: string[] } } }) {
          const keys = where?.key?.in
          return state.flagRows.filter((r) => !keys || keys.includes(r.key)).map((r) => ({ ...r }))
        },
        async update() { throw new Error('not used here') },
      },
      worker: {
        async findFirst({ where }: { where: { id: string } }) {
          // Deferred fixture references (the vi.mock factory is hoisted — the
          // consts are initialized by the time a request runs).
          const found = WORKERS.find((w) => w.id === where.id)
          if (!found) return null
          const attendances = found.id === 'wrk-00000001' ? W1_ATTENDANCES : []
          return structuredClone({ ...found, attendances: attendances.map((a) => ({ ...a })) })
        },
      },
    },
  }
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

// The payload seam the workers LIST reuses (the payload's OWN rollup fields
// are projected verbatim — controlled here; pinned by the app's own tests).
const svc = vi.hoisted(() => ({
  getProjectPayload: vi.fn(),
}))

vi.mock('@/backend/lib/mjengo', () => svc)

import { GET as openapiGet } from '@/app/api/openapi.json/route'
import { GET as projectWorkersGet } from '@/app/api/v1/projects/[id]/workers/route'
import { GET as workerDetailGet } from '@/app/api/v1/workers/[id]/route'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'

function sessionFor(role: string, projectId: string | null = null) {
  h.session = { user: { id: `u-${role}`, email: `${role}@test.dev`, name: role, role, projectId } }
}

function getReq(url: string, extra: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: { 'content-type': 'application/json', ...extra } })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

// ---------------------------------------------------------------- payload fixture

const PAYLOAD = {
  project: { id: 'p-1', name: 'Nyumba Yangu' },
  workers: WORKERS.map((w) => ({ ...w })),
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  svc.getProjectPayload.mockResolvedValue(PAYLOAD)
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  vi.useRealTimers()
})

// ---------------------------------------------------------------- workers list

describe('GET /api/v1/projects/:id/workers — the roster with its rollup', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/${id}/workers${qs}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — every worker, deterministic (name ASC, id ASC) roster order, the payload rollup projected verbatim', async () => {
    sessionFor('contractor')
    const res = await projectWorkersGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const items = body.data as Array<Record<string, unknown>>
    expect(items.map((w) => w.id)).toEqual(['wrk-00000001', 'wrk-00000002', 'wrk-00000003'])
    expect(items[0]).toEqual({
      id: 'wrk-00000001', projectId: 'p-1', name: 'Amina Njeri', role: 'Fundi wa Mawe (Mason)',
      phone: '+254712000001', dailyRate: 1500, active: true, employmentType: 'casual',
      skills: ['masonry', 'plastering'],
      todayStatus: WORKERS[0].todayStatus,
      weekEarnings: 3750,
    })
    // no today-row → the all-null todayStatus with wage 0 (honest, never fabricated)
    expect(items[1]).toMatchObject({ todayStatus: { status: null, wage: 0 }, weekEarnings: 0, skills: [] })
    // malformed stored skills JSON → [] , never a 500; inactive roster split surfaced
    expect(items[2]).toMatchObject({ skills: [], active: false })
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('HONEST ABSENCES: no pin, no createdAt/updatedAt, no attendance-count key on the list items', async () => {
    sessionFor('admin')
    const body = await bodyOf(await projectWorkersGet(req('p-1'), ctx('p-1')))
    for (const item of body.data as Array<Record<string, unknown>>) {
      expect(Object.keys(item)).not.toContain('pin')
      expect(Object.keys(item)).not.toContain('createdAt')
      expect(Object.keys(item)).not.toContain('updatedAt')
      expect(Object.keys(item)).not.toContain('attendanceCount')
      expect(Object.keys(item)).not.toContain('attendanceSummary')
    }
  })

  it('?active= filters BEFORE pagination — false → 1 (Chelu); a bogus value → honest 400', async () => {
    sessionFor('admin')
    const inactive = await bodyOf(await projectWorkersGet(req('p-1', '?active=false'), ctx('p-1')))
    expect((inactive.data as Array<{ id: string }>).map((w) => w.id)).toEqual(['wrk-00000003'])

    const bogus = await projectWorkersGet(req('p-1', '?active=maybe'), ctx('p-1'))
    expect(bogus.status).toBe(400)
    const body = await bodyOf(bogus)
    expect(body.error).toMatch(/active must be "true" or "false"/)
    expect(body.field).toBe('active')
  })

  it('cursor pagination: limit=2 pages walk all 3 workers with no overlap', async () => {
    sessionFor('admin')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const url = `http://localhost/api/v1/projects/p-1/workers?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await bodyOf(await projectWorkersGet(getReq(url), ctx('p-1')))
      seen.push(...(body.data as Array<{ id: string }>).map((w) => w.id))
      pages++
      expect(body.hasMore).toBe(pages < 2)
      cursor = (body.nextCursor as string | null) ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(2)
    expect(seen).toEqual(['wrk-00000001', 'wrk-00000002', 'wrk-00000003'])
  })

  it('a cursor that fell out of the filtered list → 400 naming "a worker"', async () => {
    sessionFor('admin')
    const res = await projectWorkersGet(req('p-1', '?active=false&cursor=wrk-00000001'), ctx('p-1'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/the id of a worker in this list/)
    expect(body.field).toBe('cursor')
  })

  it('unknown query key → 400 (typo protection, strictObject)', async () => {
    sessionFor('admin')
    const res = await projectWorkersGet(req('p-1', '?trade=mason'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "trade"' })
  })

  it('scoping: unknown project → 404; foreign client → 403; own client → 200; supplier → uniform 403; anonymous → 401', async () => {
    svc.getProjectPayload.mockResolvedValueOnce(null)
    sessionFor('admin')
    expect((await projectWorkersGet(req('p-x'), ctx('p-x'))).status).toBe(404)

    sessionFor('client', 'p-2')
    const denied = await projectWorkersGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    sessionFor('client', 'p-1')
    expect((await projectWorkersGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    sessionFor('supplier')
    const supplierDenied = await projectWorkersGet(req('p-1'), ctx('p-1'))
    expect(supplierDenied.status).toBe(403)
    expect(await bodyOf(supplierDenied)).toEqual({ error: 'Not permitted for this supplier account' })

    h.session = null
    expect((await projectWorkersGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })
})

// ---------------------------------------------------------------- worker detail

describe('GET /api/v1/workers/:id — the full attendance summary', () => {
  const req = (id: string) => getReq(`http://localhost/api/v1/workers/${id}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — identity + true attendance counts + the recent day rows (fake-timer determinism for EAT today)', async () => {
    // Freeze the clock so todayStatus/weekEarnings derive off a known EAT day
    // (2026-02-14) — the payload's exact derivation, never re-implemented.
    vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
    sessionFor('client', 'p-1')
    const res = await workerDetailGet(req('wrk-00000001'), ctx('wrk-00000001'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.data).toEqual({
      id: 'wrk-00000001', projectId: 'p-1', name: 'Amina Njeri', role: 'Fundi wa Mawe (Mason)',
      phone: '+254712000001', dailyRate: 1500, active: true, employmentType: 'casual',
      skills: ['masonry', 'plastering'],
      todayStatus: {
        status: 'present', checkIn: '2026-02-14T04:30:00.000Z', checkOut: '2026-02-14T12:30:00.000Z',
        method: 'kiosk_pin', wage: 1500, paid: true, verification: 'verified', exceptionReason: null,
      },
      weekEarnings: 3750, // 14+13+12+11+10-day wages (750 half-day) — the 20 Jan row is outside the window
      idNumber: '28491022',
      emergencyContactName: 'Njeri Mwangi',
      emergencyContactPhone: '+254722000009',
      attendanceSummary: {
        records: 6, present: 3, absent: 1, halfDay: 1, excused: 1,
        verified: 2, reported: 3, exception: 1,
        paidWages: 3000, unpaidWages: 2250, unpaidRecords: 2,
        firstDate: '2026-01-20', lastDate: '2026-02-14',
      },
      recentAttendance: W1_ATTENDANCES.map((a) => ({
        id: a.id, date: a.date, status: a.status,
        checkIn: a.checkIn ? a.checkIn.toISOString() : null,
        checkOut: a.checkOut ? a.checkOut.toISOString() : null,
        method: a.method, wage: a.wage, paid: a.paid, verification: a.verification,
        exceptionReason: a.exceptionReason, version: a.version,
        createdAt: a.createdAt.toISOString(),
      })),
    })
  })

  it('200 no-rows worker — honest zeros and nulls everywhere (never fabricated)', async () => {
    vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
    sessionFor('contractor')
    const body = await bodyOf(await workerDetailGet(req('wrk-00000002'), ctx('wrk-00000002')))
    expect(body.data).toMatchObject({
      todayStatus: { status: null, wage: 0, paid: false },
      weekEarnings: 0,
      attendanceSummary: {
        records: 0, present: 0, paidWages: 0, unpaidWages: 0,
        firstDate: null, lastDate: null,
      },
      recentAttendance: [],
    })
  })

  it('Worker.pin is never served — the kiosk credential is absent from every key', async () => {
    sessionFor('admin')
    const body = await bodyOf(await workerDetailGet(req('wrk-00000001'), ctx('wrk-00000001')))
    expect(Object.keys(body.data as Record<string, unknown>)).not.toContain('pin')
  })

  it('scoping: unknown worker → 404; foreign client → 403 (resolve-first, pin-second); own client → 200; supplier → uniform 403; anonymous → 401', async () => {
    sessionFor('admin')
    const missing = await workerDetailGet(req('wrk-99999999'), ctx('wrk-99999999'))
    expect(missing.status).toBe(404)
    expect(await bodyOf(missing)).toEqual({ error: 'Worker not found' })

    sessionFor('client', 'p-2')
    const denied = await workerDetailGet(req('wrk-00000001'), ctx('wrk-00000001'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    sessionFor('client', 'p-1')
    expect((await workerDetailGet(req('wrk-00000001'), ctx('wrk-00000001'))).status).toBe(200)

    sessionFor('supplier')
    const supplierDenied = await workerDetailGet(req('wrk-00000001'), ctx('wrk-00000001'))
    expect(supplierDenied.status).toBe(403)
    expect(await bodyOf(supplierDenied)).toEqual({ error: 'Not permitted for this supplier account' })

    h.session = null
    expect((await workerDetailGet(req('wrk-00000001'), ctx('wrk-00000001'))).status).toBe(401)
  })

  it('a malformed :id (41 chars) → 400 field "id"; unknown query key → 400', async () => {
    sessionFor('admin')
    const long = 'x'.repeat(41)
    const res = await workerDetailGet(req(long), ctx(long))
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).field).toBe('id')

    const bad = await workerDetailGet(getReq('http://localhost/api/v1/workers/wrk-00000001?projectId=p-1'), ctx('wrk-00000001'))
    expect(bad.status).toBe(400)
    expect(await bodyOf(bad)).toEqual({ error: 'Unknown field(s): "projectId"' })
  })
})

// ---------------------------------------------------------------- no flag gate

describe('no feature flag gates the workforce reads', () => {
  it('every flag forced OFF + contractor → both routes still answer 200', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress,ai_voice,wallet,marketplace,land_verification'
    invalidateFlagCache()
    sessionFor('contractor')
    const list = await projectWorkersGet(getReq('http://localhost/api/v1/projects/p-1/workers'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(list.status).toBe(200)
    const detail = await workerDetailGet(getReq('http://localhost/api/v1/workers/wrk-00000001'), { params: Promise.resolve({ id: 'wrk-00000001' }) })
    expect(detail.status).toBe(200)
  })
})

// ---------------------------------------------------------------- rate limit

describe('GET /api/v1/projects/:id/workers — rate limit (120/min per principal)', () => {
  it('the 121st call within the window → 429 with Retry-After', async () => {
    // Fake timers freeze Date.now() so the continuous token refill cannot
    // mask the exhaustion (120 tokens at 120/min = 500ms per token).
    vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
    try {
      sessionFor('contractor')
      const withIp = () => getReq('http://localhost/api/v1/projects/p-1/workers', { 'x-forwarded-for': '10.99.0.2' })
      const ctxP1 = { params: Promise.resolve({ id: 'p-1' }) }
      for (let i = 0; i < 120; i++) {
        const res = await projectWorkersGet(withIp(), ctxP1)
        expect(res.status, `request ${i + 1} should pass`).toBe(200)
      }
      const blocked = await projectWorkersGet(withIp(), ctxP1)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
      expect(await bodyOf(blocked)).toMatchObject({ error: 'Too many requests' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------- OpenAPI

describe('GET /api/openapi.json — Phase D worker paths', () => {
  it('serves the two workforce paths; /api/v1 counts 27 paths', async () => {
    const res = await openapiGet()
    expect(res.status).toBe(200)
    const doc = (await res.json()) as Record<string, any>
    for (const path of ['/api/v1/projects/{id}/workers', '/api/v1/workers/{id}']) {
      expect(Object.keys(doc.paths)).toContain(path)
    }
    const v1Paths = Object.keys(doc.paths).filter((p) => p.startsWith('/api/v1'))
    expect(v1Paths.length).toBe(27)
  })

  it('matching operationIds + tags for the worker ops', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    expect(doc.paths['/api/v1/projects/{id}/workers'].get.operationId).toBe('listProjectWorkers')
    expect(doc.paths['/api/v1/workers/{id}'].get.operationId).toBe('getWorker')
    expect(doc.paths['/api/v1/projects/{id}/workers'].get.tags).toEqual(['workers'])
    expect(doc.paths['/api/v1/workers/{id}'].get.tags).toEqual(['workers'])
  })

  it('the WorkerSummary/WorkerDetail schemas are declared and carry the honest omission notes', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    for (const name of ['WorkerSummary', 'WorkerDetail']) {
      expect(Object.keys(doc.components.schemas)).toContain(name)
    }
    expect(doc.components.schemas.WorkerSummary.description).toMatch(/kiosk PIN/i)
    expect(doc.components.schemas.WorkerSummary.description).toMatch(/no createdAt/i)
  })

  it('SDK ROUND-TRIP: the documented required fields are exactly the response fields (no drift, no leaks)', async () => {
    vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
    sessionFor('contractor')
    // Unique IP: a fresh rate-limit principal (the frozen clock never lets
    // an earlier bucket refill, so the SDK requests need their own).
    const withIp = (url: string) => getReq(url, { 'x-forwarded-for': '10.99.0.3' })
    const doc = (await (await openapiGet()).json()) as Record<string, any>

    // list item ↔ WorkerSummary
    const listBody = await bodyOf(
      await projectWorkersGet(withIp('http://localhost/api/v1/projects/p-1/workers'), { params: Promise.resolve({ id: 'p-1' }) }),
    )
    const item = (listBody.data as Array<Record<string, unknown>>)[0]
    const summary = doc.components.schemas.WorkerSummary as { required: string[]; properties: Record<string, unknown> }
    for (const key of summary.required) expect(item, `WorkerSummary.${key}`).toHaveProperty(key)
    for (const key of Object.keys(item)) expect(summary.properties, `undocumented list key "${key}"`).toHaveProperty(key)
    const todayStatus = item.todayStatus as Record<string, unknown>
    const todaySchema = summary.properties.todayStatus as { required: string[]; properties: Record<string, unknown> }
    for (const key of todaySchema.required) expect(todayStatus, `todayStatus.${key}`).toHaveProperty(key)
    for (const key of Object.keys(todayStatus)) expect(todaySchema.properties, `undocumented todayStatus key "${key}"`).toHaveProperty(key)

    // detail ↔ WorkerDetail (incl. attendanceSummary + recentAttendance rows)
    const detail = (await bodyOf(
      await workerDetailGet(withIp('http://localhost/api/v1/workers/wrk-00000001'), { params: Promise.resolve({ id: 'wrk-00000001' }) }),
    )).data as Record<string, unknown>
    const detailSchema = doc.components.schemas.WorkerDetail as { required: string[]; properties: Record<string, unknown> }
    for (const key of detailSchema.required) expect(detail, `WorkerDetail.${key}`).toHaveProperty(key)
    for (const key of Object.keys(detail)) expect(detailSchema.properties, `undocumented detail key "${key}"`).toHaveProperty(key)
    const attSummary = detail.attendanceSummary as Record<string, unknown>
    const attSummarySchema = detailSchema.properties.attendanceSummary as { required: string[]; properties: Record<string, unknown> }
    for (const key of attSummarySchema.required) expect(attSummary, `attendanceSummary.${key}`).toHaveProperty(key)
    for (const key of Object.keys(attSummary)) expect(attSummarySchema.properties, `undocumented attendanceSummary key "${key}"`).toHaveProperty(key)
    const recentRow = (detail.recentAttendance as Array<Record<string, unknown>>)[0]
    const recentSchema = (detailSchema.properties.recentAttendance as { items: { required: string[]; properties: Record<string, unknown> } }).items
    for (const key of recentSchema.required) expect(recentRow, `recentAttendance.${key}`).toHaveProperty(key)
    for (const key of Object.keys(recentRow)) expect(recentSchema.properties, `undocumented recentAttendance key "${key}"`).toHaveProperty(key)
  })
})
