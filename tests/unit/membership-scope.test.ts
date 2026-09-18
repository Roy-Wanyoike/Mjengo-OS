/**
 * Issue #174 (SEC-6) — project-membership read scoping for the site team.
 *
 * Pinned invariants (the security contract this suite exists to hold):
 *   · PORTFOLIO GRANT — contractor/admin read the whole portfolio via an
 *     EXPLICIT code grant: ownerReadScope answers { kind: 'portfolio' }
 *     WITHOUT consulting a single ProjectMembership row (an empty table can
 *     never widen or narrow their scope — pinned by a zero-calls assert).
 *   · MEMBERSHIP SCOPE, FAIL CLOSED — supervisor/procurement/qs/finance
 *     read EXACTLY the projects their ProjectMembership rows name; zero
 *     rows = the honest empty portfolio (list) / uniform 403 (detail),
 *     NEVER everything. The deny body is byte-identical to the client pin's
 *     ('Not permitted for this project') — no role/membership oracle.
 *   · RESOLVE-THEN-PIN — an unknown project keeps its honest 404; a
 *     known-but-foreign project gets the 403 (the v1 payments precedent).
 *   · WORKER PII — idNumber/emergencyContactName/emergencyContactPhone are
 *     served ONLY to membership-holders of the worker's project,
 *     contractor/admin, and the project's own client. Everyone else gets
 *     the SAME worker row with the three fields as nulls — byte-identical
 *     to a worker with no PII on file, so the strip is not an oracle and
 *     the response shape never changes for legit readers.
 *   · client/supplier pins are UNCHANGED (their own helpers run first).
 *   · migration 13_project_membership is additive-only (one CREATE TABLE +
 *     its indexes; no ALTER/DROP/DML anywhere).
 *
 * Mocks (the v1-projects/v1-workers idioms): '@/backend/lib/guard' full
 * fake (session control), '@/backend/lib/db' (projectMembership rows +
 * the worker read for the PII half + featureFlag rows), '@/backend/lib/
 * mjengo' (getProjectsList / getProjectPayload seams). membership-scope,
 * scope, the v1 routes and route-kit stay REAL.
 */
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

// The membership rows the mocked db serves + call counters (the PII/list
// tests pin the fail-closed and zero-calls properties with them) + the
// late-bound worker read for the PII half (assigned per beforeEach).
const mdb = vi.hoisted(() => ({
  memberships: [] as Array<{ userId: string; projectId: string; role: string; createdAt: Date }>,
  calls: { findMany: 0, findUnique: 0 },
  workerFindUnique: async () => null as unknown,
}))

vi.mock('@/backend/lib/db', () => {
  const flagRows = [
    { key: 'ai_progress', enabled: true, description: 'AI progress' },
    { key: 'ai_voice', enabled: true, description: 'AI voice' },
    { key: 'wallet', enabled: true, description: 'Wallet' },
    { key: 'marketplace', enabled: true, description: 'Marketplace' },
    { key: 'land_verification', enabled: true, description: 'Land' },
  ]
  return {
    db: {
      featureFlag: {
        async upsert() { /* rows exist; lazy creation is a no-op here */ },
        async findMany({ where }: { where?: { key?: { in?: string[] } } }) {
          const keys = where?.key?.in
          return flagRows.filter((r) => !keys || keys.includes(r.key)).map((r) => ({ ...r }))
        },
      },
      projectMembership: {
        async findMany({ where }: { where?: { userId?: string } }) {
          mdb.calls.findMany++
          return mdb.memberships
            .filter((m) => !where?.userId || m.userId === where.userId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((m) => ({ ...m }))
        },
        async findUnique({ where }: { where: { userId_projectId: { userId: string; projectId: string } } }) {
          mdb.calls.findUnique++
          const hit = mdb.memberships.find(
            (m) => m.userId === where.userId_projectId.userId && m.projectId === where.userId_projectId.projectId,
          )
          return hit ? { ...hit } : null
        },
      },
      worker: {
        async findFirst(args: { where: { id: string } }) {
          return mdb.workerFindUnique(args)
        },
        async findUnique(args: { where: { id: string } }) {
          return mdb.workerFindUnique(args)
        },
      },
    },
  }
})

// Full fake guard (the v1-projects idiom — mirrors guard.ts 1:1).
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
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
  }
})

// The service seams the projects resource reuses.
const svc = vi.hoisted(() => ({ getProjectsList: vi.fn(), getProjectPayload: vi.fn() }))
vi.mock('@/backend/lib/mjengo', () => svc)

import { GET as projectsListGet } from '@/app/api/v1/projects/route'
import { GET as projectDetailGet } from '@/app/api/v1/projects/[id]/route'
import { GET as workerDetailGet } from '@/app/api/v1/workers/[id]/route'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'
import { MEMBERSHIP_ROLES, PORTFOLIO_GRANT_ROLES, mayReadProject, maySeeWorkerPii, ownerReadScope } from '@/backend/lib/membership-scope'

const d = (iso: string) => new Date(iso)

function sessionFor(role: string, projectId: string | null = null, id?: string) {
  h.session = { user: { id: id ?? `u-${role}`, email: `${role}@test.dev`, name: role, role, projectId } }
}

function getReq(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: { 'content-type': 'application/json' } })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

// ---------------------------------------------------------------- fixtures

const PROJECTS = [
  { id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', clientType: 'diaspora', location: 'Karen', status: 'active', startDate: d('2026-01-05T09:00:00Z'), targetDate: d('2026-05-05T09:00:00Z'), budgetTotal: 2_000_000, budgetSpent: 700_000, progressPct: 35, dayCount: 40, fundisCount: 5, unackedAlerts: 2, photoCount: 8 },
  { id: 'p-2', name: 'Westlands Duplex', client: 'John Kamau', clientType: 'local', location: 'Westlands', status: 'completed', startDate: d('2025-06-01T09:00:00Z'), targetDate: d('2025-12-01T09:00:00Z'), budgetTotal: 4_500_000, budgetSpent: 4_400_000, progressPct: 100, dayCount: 200, fundisCount: 9, unackedAlerts: 0, photoCount: 30 },
  { id: 'p-3', name: 'Nyali Bungalow', client: 'Aisha Mwinyi', clientType: 'diaspora', location: 'Mombasa', status: 'on_hold', startDate: d('2026-02-01T09:00:00Z'), targetDate: d('2026-08-01T09:00:00Z'), budgetTotal: 6_000_000, budgetSpent: 100_000, progressPct: 3, dayCount: 10, fundisCount: 2, unackedAlerts: 5, photoCount: 1 },
]

/** One full getProjectPayload-shaped object for the detail route (p-2). */
const PAYLOAD_P2 = {
  project: { id: 'p-2', name: 'Westlands Duplex', client: 'John Kamau', clientType: 'local', location: 'Westlands', status: 'completed', budget: 4_500_000, shareToken: 'tok-2', startDate: d('2025-06-01T09:00:00Z'), targetDate: d('2025-12-01T09:00:00Z'), createdAt: d('2025-05-01T09:00:00Z'), updatedAt: d('2025-12-01T09:00:00Z') },
  phases: [],
  summary: { dayCount: 200, daysRemaining: 0, progressPct: 100, budgetTotal: 4_500_000, budgetSpent: 4_400_000, budgetSpentPct: 98, plannedSpendPct: 100, spendVsPlanDelta: -2, fundisToday: 0, fundisExpected: 0, wagesToday: 0, wagesUnpaid: 0, fundisVerified: 0, fundisReported: 0, fundisException: 0, wagesVerified: 0, wagesPendingReview: 0, materialSpend: 3_000_000, spendTrend: [], unackedAlerts: 0 },
  supply: { suppliers: [], requests: [], approvalRules: [], approvals: [], quotes: [], orders: [] },
} as never

/** The worker the PII half reads (BigInt cents — the #122 DB contract). */
const WORKER = {
  id: 'wrk-1', projectId: 'p-1', name: 'Amina Njeri', role: 'Fundi wa Mawe (Mason)', phone: '+254712000001',
  dailyRate: 150_000n, active: true, employmentType: 'casual', skills: '["masonry"]',
  idNumber: '28491022', emergencyContactName: 'Njeri Mwangi', emergencyContactPhone: '+254722000009',
  pin: '4321', // NEVER served (the bearer-credential pin)
  attendances: [
    { id: 'att-1', workerId: 'wrk-1', projectId: 'p-1', date: '2026-02-14', status: 'present', checkIn: d('2026-02-14T04:30:00Z'), checkOut: d('2026-02-14T12:30:00Z'), method: 'kiosk_pin', wage: 150_000n, paid: true, synced: true, verification: 'verified', evidence: null, exceptionReason: null, exceptionNote: null, overrideLog: null, recordedBy: 'Kiosk', createdAt: d('2026-02-14T07:30:00Z'), version: 1 },
  ],
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
  h.session = null
  mdb.memberships = []
  mdb.calls.findMany = 0
  mdb.calls.findUnique = 0
  svc.getProjectsList.mockReset()
  svc.getProjectsList.mockResolvedValue(PROJECTS.map((p) => ({ ...p })))
  svc.getProjectPayload.mockReset()
  svc.getProjectPayload.mockImplementation(async (id: string) =>
    id === 'p-2' ? PAYLOAD_P2 : null,
  )
  // The worker read for the PII half (late-bound to the WORKER fixture).
  mdb.workerFindUnique = async ({ where }: { where: { id: string } }) =>
    where.id === 'wrk-1' ? { ...WORKER, attendances: WORKER.attendances.map((a) => ({ ...a })) } : null
  invalidateFlagCache()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------- unit: the scope helpers

describe('ownerReadScope — the SEC-6 classification', () => {
  it('contractor/admin get the PORTFOLIO grant without consulting a single membership row', async () => {
    for (const role of PORTFOLIO_GRANT_ROLES) {
      sessionFor(role)
      mdb.calls.findMany = 0
      await expect(ownerReadScope(h.session!)).resolves.toEqual({ kind: 'portfolio' })
      expect(mdb.calls.findMany, `${role} must not read membership rows`).toBe(0)
    }
  })

  it('supervisor/procurement/qs/finance get EXACTLY their membership rows (createdAt order)', async () => {
    for (const role of MEMBERSHIP_ROLES) {
      sessionFor(role, null, `u-${role}`)
      mdb.memberships = [
        { userId: 'u-other', projectId: 'p-9', role, createdAt: d('2026-01-01T00:00:00Z') },
        { userId: `u-${role}`, projectId: 'p-3', role, createdAt: d('2026-01-02T00:00:00Z') },
        { userId: `u-${role}`, projectId: 'p-1', role, createdAt: d('2026-01-01T00:00:00Z') },
      ]
      await expect(ownerReadScope(h.session!)).resolves.toEqual({ kind: 'memberships', projectIds: ['p-1', 'p-3'] })
    }
  })

  it('zero membership rows = the honest EMPTY membership set (fail closed data shape)', async () => {
    sessionFor('supervisor')
    await expect(ownerReadScope(h.session!)).resolves.toEqual({ kind: 'memberships', projectIds: [] })
  })

  it('client/supplier/unknown roles are unpinned here (their own helpers pin them)', async () => {
    for (const role of ['client', 'supplier', 'inspector', '']) {
      sessionFor(role, 'p-1')
      await expect(ownerReadScope(h.session!)).resolves.toEqual({ kind: 'unpinned' })
      expect(mdb.calls.findMany).toBe(0)
    }
  })
})

describe('mayReadProject', () => {
  it('portfolio roles read any project', async () => {
    sessionFor('admin')
    await expect(mayReadProject(h.session!, 'p-any')).resolves.toBe(true)
  })

  it('membership roles read ONLY their held projects', async () => {
    sessionFor('procurement', null, 'u-proc')
    mdb.memberships = [{ userId: 'u-proc', projectId: 'p-1', role: 'procurement', createdAt: d('2026-01-01T00:00:00Z') }]
    await expect(mayReadProject(h.session!, 'p-1')).resolves.toBe(true)
    await expect(mayReadProject(h.session!, 'p-2')).resolves.toBe(false)
  })

  it('unpinned roles answer false (callers apply their own pins first)', async () => {
    sessionFor('client', 'p-1')
    await expect(mayReadProject(h.session!, 'p-1')).resolves.toBe(false)
  })
})

describe('maySeeWorkerPii', () => {
  it('contractor/admin see PII (portfolio grant, zero membership reads)', async () => {
    sessionFor('contractor')
    mdb.calls.findUnique = 0
    await expect(maySeeWorkerPii(h.session!, 'p-1')).resolves.toBe(true)
    expect(mdb.calls.findUnique).toBe(0)
  })

  it('the project\'s own client sees PII; a foreign client does not', async () => {
    sessionFor('client', 'p-1')
    await expect(maySeeWorkerPii(h.session!, 'p-1')).resolves.toBe(true)
    sessionFor('client', 'p-2')
    await expect(maySeeWorkerPii(h.session!, 'p-1')).resolves.toBe(false)
  })

  it('a membership-holder sees PII; the same role WITHOUT the row does not', async () => {
    sessionFor('supervisor', null, 'u-sup')
    mdb.memberships = [{ userId: 'u-sup', projectId: 'p-1', role: 'supervisor', createdAt: d('2026-01-01T00:00:00Z') }]
    await expect(maySeeWorkerPii(h.session!, 'p-1')).resolves.toBe(true)
    mdb.memberships = []
    await expect(maySeeWorkerPii(h.session!, 'p-1')).resolves.toBe(false)
  })

  it('supplier sessions never see PII', async () => {
    sessionFor('supplier')
    await expect(maySeeWorkerPii(h.session!, 'p-1')).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------- integration: the v1 list

describe('GET /api/v1/projects — the membership-scoped portfolio list', () => {
  it('a supervisor with memberships on p-1+p-3 sees EXACTLY those two (p-2 filtered out)', async () => {
    sessionFor('supervisor', null, 'u-sup')
    mdb.memberships = [
      { userId: 'u-sup', projectId: 'p-1', role: 'supervisor', createdAt: d('2026-01-01T00:00:00Z') },
      { userId: 'u-sup', projectId: 'p-3', role: 'supervisor', createdAt: d('2026-01-02T00:00:00Z') },
    ]
    const res = await projectsListGet(getReq('http://localhost/api/v1/projects'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.data as Array<{ id: string }>).map((p) => p.id)).toEqual(['p-1', 'p-3'])
  })

  it('zero membership rows = the honest EMPTY list (fail closed — never the portfolio)', async () => {
    sessionFor('finance', null, 'u-fin')
    const res = await projectsListGet(getReq('http://localhost/api/v1/projects'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.data).toEqual([])
  })

  it('contractor keeps the full portfolio (the explicit grant)', async () => {
    sessionFor('contractor')
    const res = await projectsListGet(getReq('http://localhost/api/v1/projects'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.data as Array<{ id: string }>).map((p) => p.id)).toEqual(['p-1', 'p-2', 'p-3'])
  })

  it('the client pin is unchanged: exactly their own project', async () => {
    sessionFor('client', 'p-2')
    const res = await projectsListGet(getReq('http://localhost/api/v1/projects'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.data as Array<{ id: string }>).map((p) => p.id)).toEqual(['p-2'])
  })
})

// ---------------------------------------------------------------- integration: the v1 detail pin

describe('GET /api/v1/projects/:id — the membership pin (resolve-then-pin)', () => {
  it('supervisor WITHOUT the row → the SAME uniform 403 body the client pin produces', async () => {
    sessionFor('supervisor', null, 'u-sup')
    const denied = await projectDetailGet(getReq('http://localhost/api/v1/projects/p-2'), ctx('p-2'))
    expect(denied.status).toBe(403)
    const deniedBody = await denied.json()
    expect(deniedBody).toEqual({ error: 'Not permitted for this project' })

    // byte-identical to the client pin's deny (no role/membership oracle)
    sessionFor('client', 'p-1')
    const clientDenied = await projectDetailGet(getReq('http://localhost/api/v1/projects/p-2'), ctx('p-2'))
    expect(clientDenied.status).toBe(403)
    expect(await clientDenied.json()).toEqual(deniedBody)
  })

  it('supervisor WITH the row → 200 (the read passes)', async () => {
    sessionFor('supervisor', null, 'u-sup')
    mdb.memberships = [{ userId: 'u-sup', projectId: 'p-2', role: 'supervisor', createdAt: d('2026-01-01T00:00:00Z') }]
    const res = await projectDetailGet(getReq('http://localhost/api/v1/projects/p-2'), ctx('p-2'))
    expect(res.status).toBe(200)
  })

  it('an unknown project keeps its honest 404 (resolve BEFORE the membership pin)', async () => {
    sessionFor('supervisor', null, 'u-sup')
    const res = await projectDetailGet(getReq('http://localhost/api/v1/projects/p-x'), ctx('p-x'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Project not found' })
  })

  it('contractor reads any known project (the explicit grant)', async () => {
    sessionFor('contractor')
    const res = await projectDetailGet(getReq('http://localhost/api/v1/projects/p-2'), ctx('p-2'))
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------- integration: worker PII

describe('GET /api/v1/workers/:id — the PII gate', () => {
  it('a membership-holder of the worker\'s project sees the PII fields', async () => {
    sessionFor('supervisor', null, 'u-sup')
    mdb.memberships = [{ userId: 'u-sup', projectId: 'p-1', role: 'supervisor', createdAt: d('2026-01-01T00:00:00Z') }]
    const body = await bodyOf(await workerDetailGet(getReq('http://localhost/api/v1/workers/wrk-1'), ctx('wrk-1')))
    expect(body.data).toMatchObject({
      id: 'wrk-1',
      idNumber: '28491022',
      emergencyContactName: 'Njeri Mwangi',
      emergencyContactPhone: '+254722000009',
    })
  })

  it('the SAME role WITHOUT the row → 200 with roster data, PII fields as NULLS (shape unchanged)', async () => {
    sessionFor('qs', null, 'u-qs')
    const res = await workerDetailGet(getReq('http://localhost/api/v1/workers/wrk-1'), ctx('wrk-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.data).toMatchObject({
      id: 'wrk-1', name: 'Amina Njeri', // roster data still served
      idNumber: null, emergencyContactName: null, emergencyContactPhone: null, // PII stripped
    })
    // the strip is not an oracle: the object still carries every other field
    expect(body.data).toHaveProperty('phone', '+254712000001')
    expect(body.data).toHaveProperty('attendanceSummary')
  })

  it('contractor and the project\'s own client see the PII (grant + own-project)', async () => {
    sessionFor('contractor')
    let body = await bodyOf(await workerDetailGet(getReq('http://localhost/api/v1/workers/wrk-1'), ctx('wrk-1')))
    expect(body.data).toMatchObject({ idNumber: '28491022' })
    sessionFor('client', 'p-1')
    body = await bodyOf(await workerDetailGet(getReq('http://localhost/api/v1/workers/wrk-1'), ctx('wrk-1')))
    expect(body.data).toMatchObject({ idNumber: '28491022' })
  })

  it('the kiosk PIN is never served to anyone (bearer credential)', async () => {
    sessionFor('contractor')
    const body = await bodyOf(await workerDetailGet(getReq('http://localhost/api/v1/workers/wrk-1'), ctx('wrk-1')))
    expect(JSON.stringify(body)).not.toContain('4321')
  })
})

// ---------------------------------------------------------------- migration + seed pins

describe('migration 13_project_membership is additive-only', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/13_project_membership/migration.sql', import.meta.url)),
    'utf8',
  )
  /** SQL with comment lines stripped (the additive-only assertions match statements, not prose). */
  const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

  it('exactly ONE CREATE TABLE + the unique/index statements, no existing table touched', () => {
    expect((statements.match(/CREATE TABLE/g) ?? []).length).toBe(1)
    expect((statements.match(/CREATE UNIQUE INDEX/g) ?? []).length).toBe(1)
    expect((statements.match(/CREATE INDEX/g) ?? []).length).toBe(1)
    expect(statements).toContain('"ProjectMembership"')
    for (const forbidden of ['ALTER TABLE', 'DROP TABLE', 'UPDATE ', 'DELETE FROM', 'INSERT INTO']) {
      // statement-anchored (the FK clauses legitimately contain "ON UPDATE CASCADE")
      const re = new RegExp(`^\\s*${forbidden.trim().replace(/ /g, '\\s+')}`, 'm')
      expect(statements, `must not contain a ${forbidden.trim()} statement`).not.toMatch(re)
    }
  })

  it('sorts after 12_integer_cents_money (the lexicographic fresh-deploy fix holds)', () => {
    expect('13_project_membership' > '12_integer_cents_money').toBe(true)
  })
})

describe('the memberships seed (single-org accepted-risk posture)', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../prisma/seed-extras/memberships.ts', import.meta.url)),
    'utf8',
  )

  it('wipes ONLY the ProjectMembership table and plants the four site-team roles', () => {
    expect(src).toContain('db.projectMembership.deleteMany()')
    expect(src).not.toMatch(/db\.(?!projectMembership)\w+\.deleteMany/)
    expect(src).toContain("'supervisor', 'procurement', 'qs', 'finance'")
  })
})
