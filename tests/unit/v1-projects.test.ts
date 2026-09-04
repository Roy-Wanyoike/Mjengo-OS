/**
 * /api/v1 Phase B (task 10-a) — the PROJECTS resource contract:
 * GET /api/v1/projects, GET /api/v1/projects/:id, GET /api/v1/projects/:id/tasks.
 *
 * Pinned invariants:
 *   · ROLE SCOPING mirrors the webapp guard — every signed-in role sees the
 *     portfolio; a client-role session sees exactly its OWN project (a
 *     client with no pinned project sees an empty list, never 403 — the
 *     list filters, the detail/tasks routes pin with 403 'Not permitted for
 *     this project', the v1 payments precedent).
 *   · CURSOR PAGINATION — stable pages, no overlap, nextCursor null on the
 *     last page, a cursor outside the (filtered) list → 400 { field }.
 *   · FILTERS apply BEFORE pagination (?status=, ?q= on the list; ?status=
 *     on tasks).
 *   · ERROR SHAPES — one { error, field? } contract: 400 zod (unknown query
 *     keys are listed by name), 401 anonymous, 403 client pin, 404 unknown
 *     project.
 *   · DETAIL HONESTY — every figure is an existing aggregation
 *     (ProjectSummary + procurementTotals over the payload supply slice);
 *     shareToken is NEVER exposed (bearer capability, not a data field).
 *   · NO FEATURE FLAG gates the projects resource — even with every flag
 *     forced off, the reads still answer 200 (documented decision).
 *   · The OpenAPI document carries the new paths with matching operationIds
 *     and stays structurally valid OpenAPI 3.1 (unique operationIds, $refs
 *     resolve, every operation declares tags + responses with content).
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control for route-kit's withGuard), '@/backend/lib/mjengo' (the
 * getProjectsList / getProjectPayload service seams), '@/backend/lib/db'
 * (featureFlag rows only — the flags module stays REAL, like flags-gating).
 * route-kit, rate-limit, respond/schemas and the routes themselves stay
 * REAL. NEXT_FLAGS_OFF + invalidateFlagCache() control the flag state.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

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

// The service seams the projects resource reuses (aggregations stay REAL in
// production — pinned by the app's own tests; here they are controlled).
const svc = vi.hoisted(() => ({
  getProjectsList: vi.fn(),
  getProjectPayload: vi.fn(),
}))

vi.mock('@/backend/lib/mjengo', () => svc)

import { GET as openapiGet } from '@/app/api/openapi.json/route'
import { GET as projectsGet } from '@/app/api/v1/projects/route'
import { GET as projectDetailGet } from '@/app/api/v1/projects/[id]/route'
import { GET as projectTasksGet } from '@/app/api/v1/projects/[id]/tasks/route'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'

type SessionUser = NonNullable<typeof h.session>['user']

function sessionFor(role: string, projectId: string | null = null) {
  h.session = { user: { id: `u-${role}`, email: `${role}@test.dev`, name: role, role, projectId } }
}

function getReq(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: { 'content-type': 'application/json' } })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

// ---------------------------------------------------------------- fixtures

const PROJECTS = [
  { id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', clientType: 'diaspora', location: 'Karen', status: 'active', startDate: '2026-01-05T09:00:00.000Z', targetDate: '2026-05-05T09:00:00.000Z', budgetTotal: 2_000_000, budgetSpent: 700_000, progressPct: 35, dayCount: 40, fundisCount: 5, unackedAlerts: 2, photoCount: 8 },
  { id: 'p-2', name: 'Westlands Duplex', client: 'John Kamau', clientType: 'local', location: 'Westlands', status: 'completed', startDate: '2025-06-01T09:00:00.000Z', targetDate: '2025-12-01T09:00:00.000Z', budgetTotal: 4_500_000, budgetSpent: 4_400_000, progressPct: 100, dayCount: 200, fundisCount: 9, unackedAlerts: 0, photoCount: 30 },
  { id: 'p-3', name: 'Nyali Bungalow', client: 'Aisha Mwinyi', clientType: 'diaspora', location: 'Mombasa', status: 'on_hold', startDate: '2026-02-01T09:00:00.000Z', targetDate: '2026-08-01T09:00:00.000Z', budgetTotal: 6_000_000, budgetSpent: 100_000, progressPct: 3, dayCount: 10, fundisCount: 2, unackedAlerts: 5, photoCount: 1 },
  { id: 'p-4', name: 'Karen Maisonette', client: 'Wanjiku Ltd', clientType: 'company', location: 'Karen', status: 'active', startDate: '2026-01-10T09:00:00.000Z', targetDate: '2026-11-10T09:00:00.000Z', budgetTotal: 8_000_000, budgetSpent: 1_000_000, progressPct: 12, dayCount: 35, fundisCount: 12, unackedAlerts: 1, photoCount: 4 },
  { id: 'p-5', name: 'Riverside Villas Phase 2', client: 'Mama Njeri', clientType: 'diaspora', location: 'Karen', status: 'active', startDate: '2026-03-01T09:00:00.000Z', targetDate: '2026-09-01T09:00:00.000Z', budgetTotal: 3_000_000, budgetSpent: 0, progressPct: 0, dayCount: 1, fundisCount: 0, unackedAlerts: 0, photoCount: 0 },
]

const d = (iso: string) => new Date(iso)

const task = (id: string, phaseId: string, title: string, status: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id, phaseId, title, status, progress: status === 'done' ? 100 : status === 'in_progress' ? 50 : 0,
  priority: 'normal', dueDate: null, assignedToId: null, blockedById: null, blockedReason: null,
  verifiedAt: null, verifiedByName: null, version: 1,
  createdAt: d(createdAt), updatedAt: d(createdAt),
  ...extra,
})

const TASKS = [
  task('t-1', 'ph-1', 'Pour slab', 'done', '2026-01-10T10:00:00Z', { priority: 'high', assignedToId: 'wkr-1', verifiedAt: d('2026-01-11T10:00:00Z'), verifiedByName: 'Juma', version: 3 }),
  task('t-2', 'ph-2', 'Frame roof trusses', 'pending', '2026-01-12T10:00:00Z'),
  task('t-3', 'ph-1', 'Cure slab', 'in_progress', '2026-01-15T10:00:00Z'),
  task('t-4', 'ph-2', 'Fix drainage', 'blocked', '2026-01-18T10:00:00Z', { blockedById: 't-2', blockedReason: 'waiting on trusses' }),
  task('t-5', 'ph-2', 'Paint interior', 'done', '2026-01-20T10:00:00Z'),
]

const PAYLOAD = {
  project: { id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', clientType: 'diaspora', location: 'Karen', status: 'active', budget: 2_000_000, shareToken: 'tok-secret-1', startDate: d('2026-01-05T09:00:00Z'), targetDate: d('2026-05-05T09:00:00Z'), createdAt: d('2026-01-04T09:00:00Z'), updatedAt: d('2026-02-01T09:00:00Z') },
  phases: [
    { id: 'ph-1', projectId: 'p-1', name: 'Site Prep & Foundation', order: 1, budget: 1_200_000, status: 'in_progress', progressManual: null, tasks: [TASKS[0], TASKS[2]] },
    { id: 'ph-2', projectId: 'p-1', name: 'Roofing', order: 2, budget: 800_000, status: 'pending', progressManual: null, tasks: [TASKS[1], TASKS[3], TASKS[4]] },
  ],
  summary: {
    dayCount: 40, daysRemaining: 80, progressPct: 35, budgetTotal: 2_000_000, budgetSpent: 700_000,
    budgetSpentPct: 35, plannedSpendPct: 33, spendVsPlanDelta: 2, fundisToday: 4, fundisExpected: 5,
    wagesToday: 8_000, wagesUnpaid: 5_000, fundisVerified: 3, fundisReported: 1, fundisException: 0,
    wagesVerified: 6_000, wagesPendingReview: 2_000, materialSpend: 400_000, spendTrend: [], unackedAlerts: 2,
  },
  supply: {
    suppliers: [],
    requests: [{ status: 'submitted', lines: [], quotes: [] }],
    approvalRules: [],
    approvals: [{ decision: 'pending' }],
    quotes: [],
    orders: [
      { status: 'sent', total: 150_000, lines: [], deliveries: [] },
      { status: 'confirmed', total: 50_000, lines: [], deliveries: [] },
      { status: 'draft', total: 999, lines: [], deliveries: [] },
    ],
    savedSupplierIds: [],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  svc.getProjectsList.mockResolvedValue(PROJECTS.map((p) => ({ ...p })))
  svc.getProjectPayload.mockResolvedValue(PAYLOAD)
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

// ---------------------------------------------------------------- list

describe('GET /api/v1/projects — role-scoped list', () => {
  it('admin sees the whole portfolio, items are the roster rows verbatim', async () => {
    sessionFor('admin')
    const res = await projectsGet(getReq('http://localhost/api/v1/projects'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
    expect(body.data).toEqual(PROJECTS)
    expect((body.data as unknown[])[0]).toMatchObject({ budgetTotal: 2_000_000, budgetSpent: 700_000, progressPct: 35 })
  })

  it('contractor (any non-client role) also sees the portfolio — the webapp guard', async () => {
    sessionFor('contractor')
    const res = await projectsGet(getReq('http://localhost/api/v1/projects'))
    expect(res.status).toBe(200)
    expect(((await bodyOf(res)).data as unknown[]).length).toBe(5)
  })

  it('client sees EXACTLY their own project', async () => {
    sessionFor('client', 'p-2')
    const body = await bodyOf(await projectsGet(getReq('http://localhost/api/v1/projects')))
    expect(body.data).toEqual([PROJECTS[1]])
  })

  it('client without a pinned project sees an empty list (never the portfolio)', async () => {
    sessionFor('client', null)
    const body = await bodyOf(await projectsGet(getReq('http://localhost/api/v1/projects')))
    expect(body.data).toEqual([])
    expect(body.hasMore).toBe(false)
  })

  it('anonymous → 401 { error: "Sign in required" }', async () => {
    const res = await projectsGet(getReq('http://localhost/api/v1/projects'))
    expect(res.status).toBe(401)
    expect(await bodyOf(res)).toEqual({ error: 'Sign in required' })
  })

  it('?status= filters before pagination', async () => {
    sessionFor('admin')
    const body = await bodyOf(await projectsGet(getReq('http://localhost/api/v1/projects?status=active')))
    expect((body.data as unknown[]).map((p) => (p as { status: string }).status)).toEqual(['active', 'active', 'active'])
    const onHold = await bodyOf(await projectsGet(getReq('http://localhost/api/v1/projects?status=on_hold')))
    expect((onHold.data as unknown[]).length).toBe(1)
    const completed = await bodyOf(await projectsGet(getReq('http://localhost/api/v1/projects?status=completed')))
    expect((completed.data as unknown[]).map((p) => (p as { id: string }).id)).toEqual(['p-2'])
  })

  it('an undocumented status value → honest 400 listing the supported ones', async () => {
    sessionFor('admin')
    const res = await projectsGet(getReq('http://localhost/api/v1/projects?status=paused'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/status must be one of active, completed, on_hold/)
    expect(body.field).toBe('status')
  })

  it('?q= matches name AND client, ASCII case-insensitively', async () => {
    sessionFor('admin')
    const byName = await bodyOf(await projectsGet(getReq('http://localhost/api/v1/projects?q=RIVERSIDE')))
    expect((byName.data as unknown[]).map((p) => (p as { id: string }).id)).toEqual(['p-1', 'p-5'])
    const byClient = await bodyOf(await projectsGet(getReq('http://localhost/api/v1/projects?q=kamau')))
    expect((byClient.data as unknown[]).map((p) => (p as { id: string }).id)).toEqual(['p-2'])
  })

  it('?q= with no match → empty page, hasMore false', async () => {
    sessionFor('admin')
    const body = await bodyOf(await projectsGet(getReq('http://localhost/api/v1/projects?q=nomatch')))
    expect(body.data).toEqual([])
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })
})

describe('GET /api/v1/projects — cursor pagination', () => {
  it('stable pages with no overlap: limit=2 walks all 5 projects', async () => {
    sessionFor('admin')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const url = `http://localhost/api/v1/projects?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await bodyOf(await projectsGet(getReq(url)))
      const items = body.data as Array<{ id: string }>
      seen.push(...items.map((i) => i.id))
      pages++
      expect(body.hasMore).toBe(cursor === 'p-4' ? false : true)
      cursor = (body.nextCursor as string | null) ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual(['p-1', 'p-2', 'p-3', 'p-4', 'p-5']) // ordered, no overlap
    expect(new Set(seen).size).toBe(5)
  })

  it('last page: nextCursor null + hasMore false', async () => {
    sessionFor('admin')
    const body = await bodyOf(await projectsGet(getReq('http://localhost/api/v1/projects?limit=5')))
    expect(body.nextCursor).toBeNull()
    expect(body.hasMore).toBe(false)
  })

  it('a cursor outside the (filtered) list → 400 naming the cursor field', async () => {
    sessionFor('admin')
    const res = await projectsGet(getReq('http://localhost/api/v1/projects?cursor=p-x'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/Unknown cursor — it must be the id of a project in this list/)
    expect(body.field).toBe('cursor')
  })

  it('a cursor that fell out of the status-filtered list → 400 (stale cursor)', async () => {
    sessionFor('admin')
    // p-1 is a valid project id but not in the completed set
    const res = await projectsGet(getReq('http://localhost/api/v1/projects?status=completed&cursor=p-1'))
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).field).toBe('cursor')
  })
})

describe('GET /api/v1/projects — query validation (zod strictObject)', () => {
  it('unknown query keys are rejected by name (typo protection)', async () => {
    sessionFor('admin')
    const res = await projectsGet(getReq('http://localhost/api/v1/projects?wat=1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "wat"' })
  })

  it.each([
    ['limit=0', 'limit must be between 1 and 200', 'limit'],
    ['limit=201', 'limit must be between 1 and 200', 'limit'],
    ['limit=abc', 'limit must be a number', 'limit'],
    ['cursor=', 'cursor must not be empty', 'cursor'],
    ['q=', 'q must not be empty', 'q'],
  ])('?%s → honest 400 { error, field }', async (qs, message, field) => {
    sessionFor('contractor')
    const res = await projectsGet(getReq(`http://localhost/api/v1/projects?${qs}`))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect((body.error as string).startsWith(message)).toBe(true)
    expect(body.field).toBe(field)
  })
})

describe('GET /api/v1/projects — no feature flag gates the projects resource', () => {
  it('every flag forced OFF + contractor → the projects reads still answer 200', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress,ai_voice,wallet,marketplace,land_verification'
    sessionFor('contractor')
    const list = await projectsGet(getReq('http://localhost/api/v1/projects'))
    expect(list.status).toBe(200)
    const detail = await projectDetailGet(getReq('http://localhost/api/v1/projects/p-1'), {
      params: Promise.resolve({ id: 'p-1' }),
    })
    expect(detail.status).toBe(200)
    const tasks = await projectTasksGet(getReq('http://localhost/api/v1/projects/p-1/tasks'), {
      params: Promise.resolve({ id: 'p-1' }),
    })
    expect(tasks.status).toBe(200)
  })
})

// ---------------------------------------------------------------- detail

describe('GET /api/v1/projects/:id — honest summary', () => {
  const req = (id: string) => getReq(`http://localhost/api/v1/projects/${id}`)

  it('200 — existing aggregations, field-for-field', async () => {
    sessionFor('contractor')
    const res = await projectDetailGet(req('p-1'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.data).toEqual({
      project: {
        id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', clientType: 'diaspora',
        location: 'Karen', status: 'active', budget: 2_000_000,
        startDate: '2026-01-05T09:00:00.000Z', targetDate: '2026-05-05T09:00:00.000Z',
        createdAt: '2026-01-04T09:00:00.000Z', updatedAt: '2026-02-01T09:00:00.000Z',
      },
      progressPct: 35,
      dayCount: 40,
      daysRemaining: 80,
      budget: { total: 2_000_000, spent: 700_000, spentPct: 35, plannedSpendPct: 33, spendVsPlanDeltaPct: 2 },
      procurement: {
        required: 0, purchased: 0, committed: 200_000, remaining: 0,
        pendingRequests: 1, pendingApprovals: 1, ordersInTransit: 0, discrepancies: 0,
      },
      tasks: { total: 5, pending: 1, inProgress: 1, done: 2, blocked: 1 },
      phases: 2,
    })
  })

  it('shareToken is NEVER exposed (bearer capability, not a data field)', async () => {
    sessionFor('admin')
    const res = await projectDetailGet(req('p-1'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(res.status).toBe(200)
    const json = JSON.stringify(await bodyOf(res))
    expect(json).not.toContain('shareToken')
    expect(json).not.toContain('tok-secret-1')
  })

  it('committed = Σ totals of sent/confirmed/delivering orders (procurementTotals wiring)', async () => {
    sessionFor('admin')
    const body = await bodyOf(await projectDetailGet(req('p-1'), { params: Promise.resolve({ id: 'p-1' }) }))
    expect((body.data as { procurement: { committed: number } }).procurement.committed).toBe(200_000)
  })

  it('unknown project → 404 { error: "Project not found" }', async () => {
    svc.getProjectPayload.mockResolvedValueOnce(null)
    sessionFor('admin')
    const res = await projectDetailGet(req('p-x'), { params: Promise.resolve({ id: 'p-x' }) })
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Project not found' })
  })

  it('client pinned to a foreign project → 403 (resolve-first, pin-second)', async () => {
    sessionFor('client', 'p-2')
    const res = await projectDetailGet(req('p-1'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this project' })
  })

  it('client reading their OWN project → 200', async () => {
    sessionFor('client', 'p-1')
    const res = await projectDetailGet(req('p-1'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(res.status).toBe(200)
  })

  it('client with no pinned project → 403 (fail closed)', async () => {
    sessionFor('client', null)
    const res = await projectDetailGet(req('p-1'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(res.status).toBe(403)
  })

  it('a malformed :id (41 chars) → 400 field "id"', async () => {
    sessionFor('admin')
    const long = 'x'.repeat(41)
    const res = await projectDetailGet(req(long), { params: Promise.resolve({ id: long }) })
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/at most 40 characters/)
    expect(body.field).toBe('id')
  })

  it('unknown query key on the detail → 400 (strictObject)', async () => {
    sessionFor('admin')
    const res = await projectDetailGet(getReq('http://localhost/api/v1/projects/p-1?projectId=p-1'), {
      params: Promise.resolve({ id: 'p-1' }),
    })
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "projectId"' })
  })

  it('anonymous → 401', async () => {
    const res = await projectDetailGet(req('p-1'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------- tasks

describe('GET /api/v1/projects/:id/tasks', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/${id}/tasks${qs}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — every task, deterministic (createdAt ASC, id ASC) order, phase names joined', async () => {
    sessionFor('supervisor')
    const res = await projectTasksGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const items = body.data as Array<Record<string, unknown>>
    expect(items.map((t) => t.id)).toEqual(['t-1', 't-2', 't-3', 't-4', 't-5'])
    expect(items[0]).toEqual({
      id: 't-1', phaseId: 'ph-1', phaseName: 'Site Prep & Foundation', title: 'Pour slab',
      status: 'done', progress: 100, priority: 'high',
      dueDate: null, assignedToId: 'wkr-1', blockedById: null, blockedReason: null,
      verifiedAt: '2026-01-11T10:00:00.000Z', verifiedByName: 'Juma', version: 3,
      createdAt: '2026-01-10T10:00:00.000Z', updatedAt: '2026-01-10T10:00:00.000Z',
    })
    expect(items[3]).toMatchObject({ status: 'blocked', blockedById: 't-2', blockedReason: 'waiting on trusses' })
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('?status=blocked → only the blocked task, with its blocker fields', async () => {
    sessionFor('contractor')
    const body = await bodyOf(await projectTasksGet(req('p-1', '?status=blocked'), ctx('p-1')))
    const items = body.data as Array<Record<string, unknown>>
    expect(items.length).toBe(1)
    expect(items[0]).toMatchObject({ id: 't-4', blockedById: 't-2' })
  })

  it('?status=done → 2 done tasks; ill-typed status → 400', async () => {
    sessionFor('contractor')
    const done = await bodyOf(await projectTasksGet(req('p-1', '?status=done'), ctx('p-1')))
    expect((done.data as unknown[]).length).toBe(2)
    const bad = await projectTasksGet(req('p-1', '?status=archived'), ctx('p-1'))
    expect(bad.status).toBe(400)
    expect((await bodyOf(bad)).error).toMatch(/status must be one of pending, in_progress, done, blocked/)
  })

  it('cursor pagination: limit=2 pages walk all 5 tasks with no overlap', async () => {
    sessionFor('admin')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const url = `http://localhost/api/v1/projects/p-1/tasks?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await bodyOf(await projectTasksGet(getReq(url), ctx('p-1')))
      seen.push(...(body.data as Array<{ id: string }>).map((t) => t.id))
      pages++
      cursor = (body.nextCursor as string | null) ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual(['t-1', 't-2', 't-3', 't-4', 't-5'])
  })

  it('a cursor that fell out of the filtered task set → 400 "a task"', async () => {
    sessionFor('admin')
    const res = await projectTasksGet(req('p-1', '?status=done&cursor=t-3'), ctx('p-1'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/the id of a task in this list/)
    expect(body.field).toBe('cursor')
  })

  it('unknown query key → 400', async () => {
    sessionFor('admin')
    const res = await projectTasksGet(req('p-1', '?assignee=me'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "assignee"' })
  })

  it('unknown project → 404; client foreign project → 403; anonymous → 401', async () => {
    svc.getProjectPayload.mockResolvedValueOnce(null)
    sessionFor('admin')
    expect((await projectTasksGet(req('p-x'), ctx('p-x'))).status).toBe(404)

    sessionFor('client', 'p-2')
    const denied = await projectTasksGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    h.session = null
    expect((await projectTasksGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })
})

// ---------------------------------------------------------------- OpenAPI

describe('GET /api/openapi.json — Phase B projects paths + structural validity', () => {
  it('serves valid JSON with the four new project paths and matching operationIds', async () => {
    const res = await openapiGet()
    expect(res.status).toBe(200)
    const doc = (await res.json()) as Record<string, any>
    expect(doc.openapi).toBe('3.1.0')
    for (const path of [
      '/api/v1/projects',
      '/api/v1/projects/{id}',
      '/api/v1/projects/{id}/tasks',
    ]) {
      expect(Object.keys(doc.paths)).toContain(path)
    }
    expect(doc.paths['/api/v1/projects'].get.operationId).toBe('listProjects')
    expect(doc.paths['/api/v1/projects/{id}'].get.operationId).toBe('getProject')
    expect(doc.paths['/api/v1/projects/{id}/tasks'].get.operationId).toBe('listProjectTasks')
    expect(doc.paths['/api/v1/projects'].get.tags).toEqual(['projects'])
  })

  it('the new schemas are declared as components', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    for (const name of ['ProjectListItem', 'ProjectDetail', 'TaskSummary']) {
      expect(Object.keys(doc.components.schemas)).toContain(name)
    }
    // The detail schema documents the shareToken omission honestly.
    expect(doc.components.schemas.ProjectDetail.description).toMatch(/shareToken/)
  })

  it('EVERY operation has a unique operationId, tags and numeric responses with content', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    const operationIds: string[] = []
    for (const [path, ops] of Object.entries<Record<string, any>>(doc.paths)) {
      for (const [method, op] of Object.entries<Record<string, any>>(ops)) {
        expect(['get', 'post'].includes(method)).toBe(true)
        expect(typeof op.operationId).toBe('string')
        operationIds.push(op.operationId)
        expect(Array.isArray(op.tags)).toBe(true)
        expect(Object.keys(op.responses).length).toBeGreaterThan(0)
        for (const [status, response] of Object.entries<Record<string, any>>(op.responses)) {
          expect(status).toMatch(/^\d{3}$/)
          expect(response.content['application/json']).toBeDefined()
        }
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length)
    expect(operationIds).toContain('listSupplyOrders') // Phase B supply ops present too
  })

  it('every $ref in the document resolves to a declared component schema', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([A-Za-z]+)"/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(Object.keys(doc.components.schemas)).toContain(ref)
    }
  })

  it('every tag used by an operation is declared in the document tags', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    const declared = doc.tags.map((t: { name: string }) => t.name)
    const used = new Set<string>()
    for (const ops of Object.values<Record<string, any>>(doc.paths)) {
      for (const op of Object.values<Record<string, any>>(ops)) used.add(...op.tags)
    }
    for (const tag of used) expect(declared).toContain(tag)
  })
})
