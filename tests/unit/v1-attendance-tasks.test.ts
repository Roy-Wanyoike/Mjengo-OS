/**
 * /api/v1 Phase D (task 7-b) — the ATTENDANCE + TASK-DETAIL read surface:
 * GET /api/v1/projects/:id/attendance and GET /api/v1/tasks/:id.
 *
 * Pinned invariants:
 *   · ROLE SCOPING mirrors the v1 payments precedent — resolve first, pin
 *     second: any signed-in role may read; a client-role session is pinned
 *     to its own project (foreign → 403 'Not permitted for this project',
 *     indistinguishable for probes; own → 200); unknown project/task → 404;
 *     anonymous → 401. W5-3: supplier sessions are not project readers —
 *     uniform 403 'Not permitted for this supplier account'.
 *   · NO FEATURE FLAG gates these resources — even with every flag forced
 *     off, the reads still answer 200 (none of the five flags names the
 *     workforce or task surface).
 *   · KEYSET PAGINATION — the attendance page is ordered (createdAt DESC,
 *     id DESC) newest-day-rows-first (the invoices-list precedent); ?workerId=
 *     / ?status= / ?date= all filter BEFORE pagination; a cursor outside the
 *     (filtered) list → 400 { field }. A foreign/unknown workerId matches no
 *     rows → honest empty page (the never-written-status precedent).
 *   · WORKFORCE TRUST HONESTY — evidence and the append-only override log
 *     surface as COUNTS ONLY (evidenceCount/overrideCount — malformed stored
 *     JSON → 0, never a 500); the worker join (name/role) rides every row.
 *   · TASK DETAIL = the /api/v1/projects/:id/tasks list fields PLUS the
 *     detail joins (assignedToName, blockedByTitle) — read-only, Phase D
 *     exposes no task mutations (the actions layer owns them).
 *   · The OpenAPI document carries the two new paths (27 /api/v1 total) with
 *     matching operationIds + tags + the AttendanceRecord/TaskDetail schemas.
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control), '@/backend/lib/db' (project.findUnique + attendance.findMany
 * with honest where-filtering + task.findFirst with the phase/worker/blocker
 * include). route-kit, rate-limit, respond/schemas and the routes stay REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

const d = (iso: string) => new Date(iso)

// ---------------------------------------------------------------- fixtures (hoisted for the db factory)

/** Six attendance day-rows of p-1 across two workers (evidence/override JSON strings). */
const ATTENDANCES = [
  {
    id: 'att-00000001', workerId: 'wrk-00000001', projectId: 'p-1', date: '2026-02-14',
    status: 'present', checkIn: d('2026-02-14T04:30:00Z'), checkOut: d('2026-02-14T12:30:00Z'),
    method: 'kiosk_pin', wage: 1500, paid: true, synced: true, verification: 'verified',
    evidence: '["pin","gps"]', exceptionReason: null, exceptionNote: null, overrideLog: null,
    recordedBy: 'Kiosk (site device)', createdAt: d('2026-02-14T07:30:00Z'), version: 1,
  },
  {
    id: 'att-00000002', workerId: 'wrk-00000002', projectId: 'p-1', date: '2026-02-14',
    status: 'present', checkIn: d('2026-02-14T04:35:00Z'), checkOut: null,
    method: 'geofence', wage: 800, paid: false, synced: true, verification: 'reported',
    evidence: '["supervisor"]', exceptionReason: null, exceptionNote: null, overrideLog: '[]',
    recordedBy: 'Joe (Foreman)', createdAt: d('2026-02-14T07:35:00Z'), version: 1,
  },
  {
    id: 'att-00000003', workerId: 'wrk-00000001', projectId: 'p-1', date: '2026-02-13',
    status: 'absent', checkIn: null, checkOut: null,
    method: 'manager', wage: 0, paid: true, synced: true, verification: 'reported',
    evidence: null, exceptionReason: null, exceptionNote: null, overrideLog: '[]',
    recordedBy: 'Joe (Foreman)', createdAt: d('2026-02-13T18:00:00Z'), version: 1,
  },
  {
    id: 'att-00000004', workerId: 'wrk-00000002', projectId: 'p-1', date: '2026-02-12',
    status: 'half_day', checkIn: d('2026-02-12T04:30:00Z'), checkOut: d('2026-02-12T09:00:00Z'),
    method: 'app', wage: 400, paid: false, synced: true, verification: 'exception',
    evidence: '["supervisor"]', exceptionReason: 'emergency', exceptionNote: 'Family emergency.',
    overrideLog: '[{"at":"2026-02-13T10:00:00.000Z","by":"Joe (Foreman)","from":"present","to":"half_day","reason":"Left site at noon"}]',
    recordedBy: 'Joe (Foreman)', createdAt: d('2026-02-12T18:00:00Z'), version: 2,
  },
  {
    // malformed stored evidence JSON — must count 0, never a 500
    id: 'att-00000005', workerId: 'wrk-00000001', projectId: 'p-1', date: '2026-02-11',
    status: 'excused', checkIn: null, checkOut: null,
    method: 'manager', wage: 0, paid: true, synced: true, verification: 'reported',
    evidence: 'not-json', exceptionReason: 'network', exceptionNote: null, overrideLog: '[]',
    recordedBy: 'Joe (Foreman)', createdAt: d('2026-02-11T18:00:00Z'), version: 1,
  },
  {
    id: 'att-00000006', workerId: 'wrk-00000002', projectId: 'p-1', date: '2026-02-10',
    status: 'present', checkIn: d('2026-02-10T04:30:00Z'), checkOut: d('2026-02-10T12:30:00Z'),
    method: 'ussd', wage: 800, paid: true, synced: true, verification: 'verified',
    evidence: '["ussd"]', exceptionReason: null, exceptionNote: null, overrideLog: '[]',
    recordedBy: 'Baraka Otieno', createdAt: d('2026-02-10T18:00:00Z'), version: 1,
  },
]

/** The worker join the attendance rows carry. */
const WORKER_NAMES: Record<string, { name: string; role: string }> = {
  'wrk-00000001': { name: 'Amina Njeri', role: 'Fundi wa Mawe (Mason)' },
  'wrk-00000002': { name: 'Baraka Otieno', role: 'Foreman' },
}

/** Four tasks: assigned+in_progress, blocked, plain pending, and a foreign-project one. */
const TASKS = [
  {
    id: 'tsk-00000001', phaseId: 'ph-1', title: 'Foundation blinding layer', status: 'in_progress', progress: 60,
    priority: 'high', dueDate: d('2026-02-20T00:00:00Z'), assignedToId: 'wrk-00000001', blockedById: null,
    blockedReason: null, verifiedAt: null, verifiedByName: null,
    createdAt: d('2026-01-10T09:00:00Z'), updatedAt: d('2026-02-13T16:00:00Z'), version: 4,
    phase: { id: 'ph-1', name: 'Site Prep & Foundation', projectId: 'p-1' },
    assignedTo: { id: 'wrk-00000001', name: 'Amina Njeri' },
    blockedBy: null,
  },
  {
    id: 'tsk-00000002', phaseId: 'ph-2', title: 'Ring beam formwork', status: 'blocked', progress: 10,
    priority: 'urgent', dueDate: d('2026-02-25T00:00:00Z'), assignedToId: 'wrk-00000002', blockedById: 'tsk-00000001',
    blockedReason: 'Formwork timber delivery short — waiting on PO-2026-000012.',
    verifiedAt: null, verifiedByName: null,
    createdAt: d('2026-01-20T09:00:00Z'), updatedAt: d('2026-02-12T16:00:00Z'), version: 2,
    phase: { id: 'ph-2', name: 'Walling', projectId: 'p-1' },
    assignedTo: { id: 'wrk-00000002', name: 'Baraka Otieno' },
    blockedBy: { id: 'tsk-00000001', title: 'Foundation blinding layer' },
  },
  {
    id: 'tsk-00000003', phaseId: 'ph-3', title: 'Roof truss procurement', status: 'pending', progress: 0,
    priority: 'normal', dueDate: null, assignedToId: null, blockedById: null,
    blockedReason: null, verifiedAt: d('2026-02-02T10:00:00Z'), verifiedByName: 'Joe (Foreman)',
    createdAt: d('2026-02-01T09:00:00Z'), updatedAt: d('2026-02-02T10:00:00Z'), version: 1,
    phase: { id: 'ph-3', name: 'Roofing', projectId: 'p-1' },
    assignedTo: null,
    blockedBy: null,
  },
  {
    // a task of ANOTHER project — the resolve-first pin-second probe target
    id: 'tsk-00000009', phaseId: 'ph-9', title: 'Duplex perimeter wall', status: 'pending', progress: 0,
    priority: 'low', dueDate: null, assignedToId: null, blockedById: null,
    blockedReason: null, verifiedAt: null, verifiedByName: null,
    createdAt: d('2026-02-05T09:00:00Z'), updatedAt: d('2026-02-05T09:00:00Z'), version: 1,
    phase: { id: 'ph-9', name: 'External works', projectId: 'p-2' },
    assignedTo: null,
    blockedBy: null,
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
    projects: [
      { id: 'p-1', name: 'Nyumba Yangu' },
      { id: 'p-2', name: 'Kiambu Road Duplex' },
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
      project: {
        async findUnique({ where }: { where: { id: string } }) {
          return state.projects.find((p) => p.id === where.id) ?? null
        },
      },
      attendance: {
        // Honest where-filtering (projectId + workerId + status + date) — the
        // route applies the same filters, and the mock honors them so the
        // filter tests exercise the real query seam.
        async findMany({ where }: { where?: Record<string, unknown> }) {
          return ATTENDANCES.filter((a) => {
            if (where?.projectId && a.projectId !== where.projectId) return false
            if (where?.workerId && a.workerId !== where.workerId) return false
            if (where?.status && a.status !== where.status) return false
            if (where?.date && a.date !== where.date) return false
            return true
          }).map((a) => ({
            ...a,
            worker: WORKER_NAMES[a.workerId] ?? null,
          }))
        },
      },
      task: {
        async findFirst({ where }: { where: { id: string } }) {
          const found = TASKS.find((t) => t.id === where.id)
          return found ? structuredClone(found) : null
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

import { GET as openapiGet } from '@/app/api/openapi.json/route'
import { GET as projectAttendanceGet } from '@/app/api/v1/projects/[id]/attendance/route'
import { GET as taskDetailGet } from '@/app/api/v1/tasks/[id]/route'
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

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  vi.useRealTimers()
})

// ---------------------------------------------------------------- attendance list

describe('GET /api/v1/projects/:id/attendance — the day-rows', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/${id}/attendance${qs}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — every row, deterministic (createdAt DESC, id DESC) newest-first order, worker join + counts', async () => {
    sessionFor('contractor')
    const res = await projectAttendanceGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const items = body.data as Array<Record<string, unknown>>
    expect(items.map((a) => a.id)).toEqual([
      'att-00000002', 'att-00000001', 'att-00000003', 'att-00000004', 'att-00000005', 'att-00000006',
    ])
    expect(items[0]).toEqual({
      id: 'att-00000002', projectId: 'p-1', workerId: 'wrk-00000002',
      workerName: 'Baraka Otieno', workerRole: 'Foreman',
      date: '2026-02-14', status: 'present',
      checkIn: '2026-02-14T04:35:00.000Z', checkOut: null, method: 'geofence',
      wage: 800, paid: false, verification: 'reported',
      evidenceCount: 1, overrideCount: 0,
      exceptionReason: null, exceptionNote: null, recordedBy: 'Joe (Foreman)',
      version: 1, createdAt: '2026-02-14T07:35:00.000Z',
    })
    // malformed stored evidence JSON → count 0, never a 500; override log → count only
    expect(items[4]).toMatchObject({ id: 'att-00000005', evidenceCount: 0 })
    expect(items[3]).toMatchObject({ id: 'att-00000004', overrideCount: 1, exceptionReason: 'emergency' })
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('?workerId= filters BEFORE pagination — w-1 → 3 rows; a foreign/unknown id → honest empty page', async () => {
    sessionFor('admin')
    const w1 = await bodyOf(await projectAttendanceGet(req('p-1', '?workerId=wrk-00000001'), ctx('p-1')))
    expect((w1.data as Array<{ id: string }>).map((a) => a.id)).toEqual(['att-00000001', 'att-00000003', 'att-00000005'])

    const foreign = await bodyOf(await projectAttendanceGet(req('p-1', '?workerId=wrk-foreign'), ctx('p-1')))
    expect(foreign.data).toEqual([])
    expect(foreign.hasMore).toBe(false)
  })

  it('?status= and ?date= filter BEFORE pagination (composable: workerId + date)', async () => {
    sessionFor('admin')
    const absent = await bodyOf(await projectAttendanceGet(req('p-1', '?status=absent'), ctx('p-1')))
    expect((absent.data as Array<{ id: string }>).map((a) => a.id)).toEqual(['att-00000003'])

    const day = await bodyOf(await projectAttendanceGet(req('p-1', '?date=2026-02-14'), ctx('p-1')))
    expect((day.data as Array<{ id: string }>).map((a) => a.id)).toEqual(['att-00000002', 'att-00000001'])

    const both = await bodyOf(await projectAttendanceGet(req('p-1', '?workerId=wrk-00000001&date=2026-02-14'), ctx('p-1')))
    expect((both.data as Array<{ id: string }>).map((a) => a.id)).toEqual(['att-00000001'])
  })

  it('ill-typed filters → honest 400s with fields (status, date, workerId)', async () => {
    sessionFor('admin')
    const badStatus = await projectAttendanceGet(req('p-1', '?status=late'), ctx('p-1'))
    expect(badStatus.status).toBe(400)
    expect(await bodyOf(badStatus)).toMatchObject({ field: 'status' })

    const badDate = await projectAttendanceGet(req('p-1', '?date=2026-2-14'), ctx('p-1'))
    expect(badDate.status).toBe(400)
    expect(await bodyOf(badDate)).toMatchObject({ field: 'date' })

    const longWorker = await projectAttendanceGet(req('p-1', `?workerId=${'x'.repeat(41)}`), ctx('p-1'))
    expect(longWorker.status).toBe(400)
    expect(await bodyOf(longWorker)).toMatchObject({ field: 'workerId' })
  })

  it('cursor pagination: limit=2 pages walk all 6 rows with no overlap; a filtered-out cursor → 400', async () => {
    sessionFor('admin')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const url = `http://localhost/api/v1/projects/p-1/attendance?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await bodyOf(await projectAttendanceGet(getReq(url), ctx('p-1')))
      seen.push(...(body.data as Array<{ id: string }>).map((a) => a.id))
      pages++
      expect(body.hasMore).toBe(pages < 3)
      cursor = (body.nextCursor as string | null) ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual(['att-00000002', 'att-00000001', 'att-00000003', 'att-00000004', 'att-00000005', 'att-00000006'])

    const stale = await projectAttendanceGet(req('p-1', '?status=absent&cursor=att-00000002'), ctx('p-1'))
    expect(stale.status).toBe(400)
    const body = await bodyOf(stale)
    expect(body.error).toMatch(/the id of an attendance record in this list/)
    expect(body.field).toBe('cursor')
  })

  it('unknown query key → 400 (typo protection, strictObject)', async () => {
    sessionFor('admin')
    const res = await projectAttendanceGet(req('p-1', '?day=2026-02-14'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "day"' })
  })

  it('scoping: unknown project → 404; foreign client → 403; own client → 200; supplier → uniform 403; anonymous → 401', async () => {
    sessionFor('admin')
    expect((await projectAttendanceGet(req('p-x'), ctx('p-x'))).status).toBe(404)

    sessionFor('client', 'p-2')
    const denied = await projectAttendanceGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    sessionFor('client', 'p-1')
    expect((await projectAttendanceGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    sessionFor('supplier')
    const supplierDenied = await projectAttendanceGet(req('p-1'), ctx('p-1'))
    expect(supplierDenied.status).toBe(403)
    expect(await bodyOf(supplierDenied)).toEqual({ error: 'Not permitted for this supplier account' })

    h.session = null
    expect((await projectAttendanceGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })
})

// ---------------------------------------------------------------- task detail

describe('GET /api/v1/tasks/:id — the detail with its joins', () => {
  const req = (id: string) => getReq(`http://localhost/api/v1/tasks/${id}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — every list field + projectId + the assignedToName / blockedByTitle joins', async () => {
    sessionFor('client', 'p-1')
    const res = await taskDetailGet(req('tsk-00000001'), ctx('tsk-00000001'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.data).toEqual({
      id: 'tsk-00000001', projectId: 'p-1', phaseId: 'ph-1', phaseName: 'Site Prep & Foundation',
      title: 'Foundation blinding layer', status: 'in_progress', progress: 60, priority: 'high',
      dueDate: '2026-02-20T00:00:00.000Z',
      assignedToId: 'wrk-00000001', assignedToName: 'Amina Njeri',
      blockedById: null, blockedByTitle: null, blockedReason: null,
      verifiedAt: null, verifiedByName: null,
      version: 4, createdAt: '2026-01-10T09:00:00.000Z', updatedAt: '2026-02-13T16:00:00.000Z',
    })
  })

  it('200 blocked — the dependency chain + reason + the verification trail surface as stored', async () => {
    sessionFor('contractor')
    const body = await bodyOf(await taskDetailGet(req('tsk-00000002'), ctx('tsk-00000002')))
    expect(body.data).toMatchObject({
      status: 'blocked', priority: 'urgent',
      blockedById: 'tsk-00000001', blockedByTitle: 'Foundation blinding layer',
      blockedReason: 'Formwork timber delivery short — waiting on PO-2026-000012.',
      assignedToName: 'Baraka Otieno',
    })
  })

  it('200 unassigned + verified — nulls and the verification trail (never fabricated)', async () => {
    sessionFor('admin')
    const body = await bodyOf(await taskDetailGet(req('tsk-00000003'), ctx('tsk-00000003')))
    expect(body.data).toMatchObject({
      assignedToId: null, assignedToName: null, blockedById: null, blockedByTitle: null,
      verifiedAt: '2026-02-02T10:00:00.000Z', verifiedByName: 'Joe (Foreman)',
    })
  })

  it('scoping: unknown task → 404; foreign-project task + foreign client → 403 (resolve-first, pin-second); own client → 200; supplier → uniform 403; anonymous → 401', async () => {
    sessionFor('admin')
    const missing = await taskDetailGet(req('tsk-99999999'), ctx('tsk-99999999'))
    expect(missing.status).toBe(404)
    expect(await bodyOf(missing)).toEqual({ error: 'Task not found' })

    sessionFor('client', 'p-1')
    const denied = await taskDetailGet(req('tsk-00000009'), ctx('tsk-00000009'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    sessionFor('client', 'p-2')
    expect((await taskDetailGet(req('tsk-00000009'), ctx('tsk-00000009'))).status).toBe(200)

    sessionFor('supplier')
    const supplierDenied = await taskDetailGet(req('tsk-00000001'), ctx('tsk-00000001'))
    expect(supplierDenied.status).toBe(403)
    expect(await bodyOf(supplierDenied)).toEqual({ error: 'Not permitted for this supplier account' })

    h.session = null
    expect((await taskDetailGet(req('tsk-00000001'), ctx('tsk-00000001'))).status).toBe(401)
  })

  it('a malformed :id (41 chars) → 400 field "id"; unknown query key → 400', async () => {
    sessionFor('admin')
    const long = 'x'.repeat(41)
    const res = await taskDetailGet(req(long), ctx(long))
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).field).toBe('id')

    const bad = await taskDetailGet(getReq('http://localhost/api/v1/tasks/tsk-00000001?phaseId=ph-1'), ctx('tsk-00000001'))
    expect(bad.status).toBe(400)
    expect(await bodyOf(bad)).toEqual({ error: 'Unknown field(s): "phaseId"' })
  })
})

// ---------------------------------------------------------------- no flag gate

describe('no feature flag gates the attendance or task reads', () => {
  it('every flag forced OFF + contractor → both routes still answer 200', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress,ai_voice,wallet,marketplace,land_verification'
    invalidateFlagCache()
    sessionFor('contractor')
    const attendance = await projectAttendanceGet(getReq('http://localhost/api/v1/projects/p-1/attendance'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(attendance.status).toBe(200)
    const task = await taskDetailGet(getReq('http://localhost/api/v1/tasks/tsk-00000001'), { params: Promise.resolve({ id: 'tsk-00000001' }) })
    expect(task.status).toBe(200)
  })
})

// ---------------------------------------------------------------- rate limit

describe('GET /api/v1/projects/:id/attendance — rate limit (120/min per principal)', () => {
  it('the 121st call within the window → 429 with Retry-After', async () => {
    vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
    try {
      sessionFor('contractor')
      const withIp = () => getReq('http://localhost/api/v1/projects/p-1/attendance', { 'x-forwarded-for': '10.99.0.4' })
      const ctxP1 = { params: Promise.resolve({ id: 'p-1' }) }
      for (let i = 0; i < 120; i++) {
        const res = await projectAttendanceGet(withIp(), ctxP1)
        expect(res.status, `request ${i + 1} should pass`).toBe(200)
      }
      const blocked = await projectAttendanceGet(withIp(), ctxP1)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
      expect(await bodyOf(blocked)).toMatchObject({ error: 'Too many requests' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------- OpenAPI

describe('GET /api/openapi.json — Phase D attendance + task paths', () => {
  it('serves the two paths with matching operationIds + tags; /api/v1 counts 27 paths', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    expect(Object.keys(doc.paths)).toContain('/api/v1/projects/{id}/attendance')
    expect(Object.keys(doc.paths)).toContain('/api/v1/tasks/{id}')
    expect(doc.paths['/api/v1/projects/{id}/attendance'].get.operationId).toBe('listProjectAttendance')
    expect(doc.paths['/api/v1/tasks/{id}'].get.operationId).toBe('getTask')
    expect(doc.paths['/api/v1/projects/{id}/attendance'].get.tags).toEqual(['workers'])
    expect(doc.paths['/api/v1/tasks/{id}'].get.tags).toEqual(['projects'])
    const v1Paths = Object.keys(doc.paths).filter((p) => p.startsWith('/api/v1'))
    expect(v1Paths.length).toBe(27)
  })

  it('the AttendanceRecord/TaskDetail schemas are declared and carry the honest notes (counts only, no task mutations)', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    for (const name of ['AttendanceRecord', 'TaskDetail']) {
      expect(Object.keys(doc.components.schemas)).toContain(name)
    }
    expect(doc.components.schemas.AttendanceRecord.description).toMatch(/COUNTS ONLY/i)
    expect(doc.paths['/api/v1/tasks/{id}'].get.description).toMatch(/no task mutations|READ-ONLY/)
  })

  it('SDK ROUND-TRIP: the documented required fields are exactly the response fields (no drift, no leaks)', async () => {
    sessionFor('contractor')
    // Unique IP: a fresh rate-limit principal for these requests.
    const withIp = (url: string) => getReq(url, { 'x-forwarded-for': '10.99.0.5' })
    const doc = (await (await openapiGet()).json()) as Record<string, any>

    const listBody = await bodyOf(
      await projectAttendanceGet(withIp('http://localhost/api/v1/projects/p-1/attendance'), { params: Promise.resolve({ id: 'p-1' }) }),
    )
    const item = (listBody.data as Array<Record<string, unknown>>)[0]
    const record = doc.components.schemas.AttendanceRecord as { required: string[]; properties: Record<string, unknown> }
    for (const key of record.required) expect(item, `AttendanceRecord.${key}`).toHaveProperty(key)
    for (const key of Object.keys(item)) expect(record.properties, `undocumented attendance key "${key}"`).toHaveProperty(key)

    const detail = (await bodyOf(
      await taskDetailGet(withIp('http://localhost/api/v1/tasks/tsk-00000002'), { params: Promise.resolve({ id: 'tsk-00000002' }) }),
    )).data as Record<string, unknown>
    const detailSchema = doc.components.schemas.TaskDetail as { required: string[]; properties: Record<string, unknown> }
    for (const key of detailSchema.required) expect(detail, `TaskDetail.${key}`).toHaveProperty(key)
    for (const key of Object.keys(detail)) expect(detailSchema.properties, `undocumented task key "${key}"`).toHaveProperty(key)
  })
})
