/**
 * API-11 (issue #162) — POST /api/projects and POST /api/flags write audit
 * events.
 *
 * Both direct routes used to bypass the applyAction trail the /api/actions
 * dispatcher writes for every mutation: project creation (the founding
 * mutation of the data model — phases, budget baseline, share token) and
 * admin feature-flag toggles (flags gate real server-side behavior for
 * everyone) left NO AuditEvent. These tests pin the fix, mirroring the
 * v1-money-audit idiom:
 *  · every SUCCESSFUL mutation writes exactly ONE AuditEvent through the same
 *    writer as applyAction (lib/audit.ts logAudit) with the guard session as
 *    actor, an entity-scoped before/after snapshot and a meta.type;
 *  · a FAILED mutation (400 validation, 403 role gate) writes nothing — the
 *    audit line only runs after the change persists;
 *  · the share token NEVER lands in the trail row (SEC-3: it is a
 *    money-adjacent bearer capability — meta records only that one exists);
 *  · flag toggles snapshot the PRIOR persisted FeatureFlag row (lazily
 *    created rows default to FLAG_DEFAULTS), scoped to a real Project
 *    (AuditEvent.projectId is a required Project FK — the admin's pinned
 *    project, else the portfolio's founding project); with ZERO projects the
 *    row is skipped with ONE honest warning instead of a fabricated id.
 *
 * Mocks mirror tests/unit/v1-money-audit.test.ts: full fake guard (session
 * control), '@/backend/lib/db' (project/phase/featureFlag/auditEvent
 * captures) and '@/backend/lib/mjengo' (payload builders). route-kit,
 * rate-limit, lib/audit and the flags module stay REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

type FlagRow = { key: string; enabled: boolean; description: string }

vi.mock('@/backend/lib/db', () => {
  const state = {
    // Fresh-install flag table: the six real keys, wallet ON (money gates on).
    flagRows: [
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
      { key: 'ai_voice', enabled: true, description: 'AI voice' },
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
    ] as FlagRow[],
    auditRows: [] as Array<Record<string, unknown>>,
    projectRows: [{ id: 'p-found', name: 'Founding Villas' }] as Array<{ id: string; name: string }>,
    phaseCreates: [] as Array<Record<string, unknown>>,
    createdProjects: [] as Array<Record<string, unknown>>,
    reset() {
      state.flagRows = [
        { key: 'ai_progress', enabled: true, description: 'AI progress' },
        { key: 'ai_voice', enabled: true, description: 'AI voice' },
        { key: 'wallet', enabled: true, description: 'Wallet' },
        { key: 'marketplace', enabled: true, description: 'Marketplace' },
        { key: 'land_verification', enabled: true, description: 'Land' },
      ]
      state.auditRows = []
      state.phaseCreates = []
      state.createdProjects = []
      state.projectRows = [{ id: 'p-found', name: 'Founding Villas' }]
    },
  }
  const db = {
    __state: state,
    featureFlag: {
      async findUnique({ where }: { where: { key: string } }) {
        const row = state.flagRows.find((r) => r.key === where.key)
        return row ? { ...row } : null
      },
      // The real ensureRows upsert: create the row when missing (with the
      // caller's per-key default), no-op update when it exists.
      async upsert({ where, create }: { where: { key: string }; create: FlagRow }) {
        if (!state.flagRows.find((r) => r.key === where.key)) state.flagRows.push({ ...create })
        const row = state.flagRows.find((r) => r.key === where.key)
        return row ? { ...row } : { ...create }
      },
      async findMany({ where }: { where?: { key?: { in?: string[] } } }) {
        const keys = where?.key?.in
        return state.flagRows.filter((r) => !keys || keys.includes(r.key)).map((r) => ({ ...r }))
      },
      async update({ where, data }: { where: { key: string }; data: { enabled: boolean } }) {
        const row = state.flagRows.find((r) => r.key === where.key)
        if (!row) throw new Error('Record not found')
        row.enabled = data.enabled
        return { ...row }
      },
    },
    project: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: `p-new-${state.createdProjects.length + 1}`, ...data }
        state.createdProjects.push(row)
        return { ...row }
      },
      // The flags route's scope resolution when the admin has no pinned
      // project: the portfolio's founding project (createdAt asc).
      async findFirst() {
        return state.projectRows[0] ? { ...state.projectRows[0] } : null
      },
    },
    phase: {
      async create({ data }: { data: Record<string, unknown> }) {
        state.phaseCreates.push({ ...data })
        return { ...data }
      },
    },
    // logAudit is the ONLY writer in production — the stub captures its rows.
    auditEvent: {
      async create({ data }: { data: Record<string, unknown> }) {
        state.auditRows.push({ ...data })
        return { ...data }
      },
    },
  }
  return { db }
})

// Full fake guard (the v1-money-audit idiom — mirrors guard.ts 1:1).
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const KNOWN_ROLES = ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs']
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
        if (opts?.roles && !opts.roles.includes(session.user.role)) {
          return NextResponse.json({ error: `Not permitted for role "${session.user.role}"` }, { status: 403 })
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

// The payload builders are irrelevant to the trail contract under test.
vi.mock('@/backend/lib/mjengo', () => ({
  getProjectPayload: vi.fn(async () => ({ project: {} })),
  getProjectsList: vi.fn(async () => []),
}))

import { db } from '@/backend/lib/db'
import { POST as projectsPost } from '@/backend/api/projects'
import { POST as flagsPost } from '@/backend/api/flags'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'

const state = () => (db as unknown as { __state: ReturnType<typeof getState> }).__state
function getState() {
  return undefined as unknown as {
    auditRows: Array<Record<string, unknown>>
    phaseCreates: Array<Record<string, unknown>>
    createdProjects: Array<Record<string, unknown>>
    flagRows: FlagRow[]
    projectRows: Array<{ id: string; name: string }>
    reset: () => void
  }
}

function sessionFor(role: string, projectId: string | null = null) {
  h.session = { user: { id: `u-${role}`, email: `${role}@test.dev`, name: `${role}-actor`, role, projectId } }
}

function jsonReq(url: string, body: unknown, ip: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      'user-agent': 'vitest-audit-agent',
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>
}

beforeEach(() => {
  state().reset()
  sessionFor('contractor')
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.NEXTAUTH_SECRET
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

describe('POST /api/projects — audit trail (API-11 / issue #162)', () => {
  const url = 'http://localhost/api/projects'
  const body = {
    name: 'Audit Trail Villa',
    client: 'Amina (Diaspora)',
    location: 'Kitengela',
    budget: 4_500_000,
    template: 'bungalow',
  }

  it('a successful create writes exactly ONE project AuditEvent with actor, entity and after-snapshot', async () => {
    const res = await projectsPost(jsonReq(url, body, '10.7.0.1', { 'x-request-id': 'req-42' }), undefined)
    expect(res.status).toBe(200)
    const json = await bodyOf(res)
    expect(json.ok).toBe(true)
    expect(json.result.shareToken).toBeTypeOf('string')

    const rows = state().auditRows
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.projectId).toBe(state().createdProjects[0].id) // the NEW project
    expect(row.kind).toBe('project')
    expect(row.actor).toBe('contractor-actor')
    expect(row.role).toBe('contractor')
    expect(row.summary).toBe('Project created') // the registry summarizer — trail stays uniform
    expect(row.entity).toBe('Project')
    expect(row.entityId).toBe(state().createdProjects[0].id)
    expect(row.ip).toBe('10.7.0.1')
    expect(row.userAgent).toBe('vitest-audit-agent')
    expect(row.requestId).toBe('req-42')
    const after = JSON.parse(row.after as string)
    expect(after).toMatchObject({
      name: 'Audit Trail Villa', client: 'Amina (Diaspora)', location: 'Kitengela',
      budget: 4_500_000, status: 'active', template: 'bungalow',
    })
    const meta = JSON.parse(row.meta as string)
    expect(meta).toMatchObject({
      type: 'project.create', name: 'Audit Trail Villa', budget: 4_500_000,
      template: 'bungalow', phases: 5, shareTokenIssued: true,
    })
    // The phases were created before the trail row (the honest order: the
    // mutation is complete when it is audited).
    expect(state().phaseCreates).toHaveLength(5)
  })

  it('the share token NEVER lands in the trail row (SEC-3 bearer capability)', async () => {
    const res = await projectsPost(jsonReq(url, { name: 'Silent Token Villa', budget: 100 }, '10.7.0.2'), undefined)
    expect(res.status).toBe(200)
    const row = state().auditRows[0]
    const token = state().createdProjects[0].shareToken as string
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('a 400 validation failure writes NO audit event (and no project)', async () => {
    const res = await projectsPost(jsonReq(url, { name: '', budget: 100 }, '10.7.0.3'), undefined)
    expect(res.status).toBe(400)
    expect(state().auditRows).toHaveLength(0)
    expect(state().createdProjects).toHaveLength(0)

    const badBudget = await projectsPost(jsonReq(url, { name: 'X', budget: -5 }, '10.7.0.4'), undefined)
    expect(badBudget.status).toBe(400)
    expect(state().auditRows).toHaveLength(0)
  })

  it('a role-gated rejection (403) never reaches the db or the audit trail', async () => {
    sessionFor('client')
    const res = await projectsPost(jsonReq(url, body, '10.7.0.5'), undefined)
    expect(res.status).toBe(403)
    expect(state().createdProjects).toHaveLength(0)
    expect(state().auditRows).toHaveLength(0)
  })
})

describe('POST /api/flags — audit trail (API-11 / issue #162)', () => {
  const url = 'http://localhost/api/flags'

  it('a successful toggle writes ONE flag AuditEvent with the prior value as before', async () => {
    sessionFor('admin')
    const res = await flagsPost(jsonReq(url, { key: 'wallet', enabled: false }, '10.7.1.1', { 'x-request-id': 'req-43' }), undefined)
    expect(res.status).toBe(200)
    const json = await bodyOf(res)
    expect(json.ok).toBe(true)
    expect(json.enabled).toBe(false)

    const rows = state().auditRows
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.projectId).toBe('p-found') // the founding project (admin has no pin)
    expect(row.kind).toBe('flag')
    expect(row.actor).toBe('admin-actor')
    expect(row.role).toBe('admin')
    expect(row.summary).toBe('Feature flag "wallet" toggled ON → OFF')
    expect(row.entity).toBe('FeatureFlag')
    expect(row.entityId).toBe('wallet')
    expect(row.ip).toBe('10.7.1.1')
    expect(row.userAgent).toBe('vitest-audit-agent')
    expect(row.requestId).toBe('req-43')
    expect(JSON.parse(row.before as string)).toEqual({ enabled: true })
    expect(JSON.parse(row.after as string)).toEqual({ enabled: false })
    expect(JSON.parse(row.meta as string)).toMatchObject({ type: 'flag.toggle', key: 'wallet', before: true, after: false })
    // The flag itself moved.
    expect(state().flagRows.find((r) => r.key === 'wallet')?.enabled).toBe(false)
  })

  it('a lazily-created row (fresh install) honestly defaults before to FLAG_DEFAULTS', async () => {
    sessionFor('admin')
    // `ai` has no row yet (fresh-install shape) — default OFF, toggled ON.
    const res = await flagsPost(jsonReq(url, { key: 'ai', enabled: true }, '10.7.1.2'), undefined)
    expect(res.status).toBe(200)
    const row = state().auditRows[0]
    expect(JSON.parse(row.before as string)).toEqual({ enabled: false })
    expect(JSON.parse(row.after as string)).toEqual({ enabled: true })
    expect(row.summary).toBe('Feature flag "ai" toggled OFF → ON')
  })

  it('the admin\'s PINNED project wins the scope when one exists', async () => {
    sessionFor('admin', 'p-mine')
    const res = await flagsPost(jsonReq(url, { key: 'marketplace', enabled: false }, '10.7.1.3'), undefined)
    expect(res.status).toBe(200)
    expect(state().auditRows[0].projectId).toBe('p-mine')
  })

  it('a 400 validation failure writes NO audit event', async () => {
    sessionFor('admin')
    const res = await flagsPost(jsonReq(url, { key: 'not-a-flag', enabled: true }, '10.7.1.4'), undefined)
    expect(res.status).toBe(400)
    expect(state().auditRows).toHaveLength(0)

    const badType = await flagsPost(jsonReq(url, { key: 'wallet', enabled: 'yes' }, '10.7.1.5'), undefined)
    expect(badType.status).toBe(400)
    expect(state().auditRows).toHaveLength(0)
  })

  it('a non-admin role is rejected before any flag write or audit row', async () => {
    sessionFor('contractor')
    const res = await flagsPost(jsonReq(url, { key: 'wallet', enabled: false }, '10.7.1.6'), undefined)
    expect(res.status).toBe(403)
    expect(state().flagRows.find((r) => r.key === 'wallet')?.enabled).toBe(true) // untouched
    expect(state().auditRows).toHaveLength(0)
  })

  it('with ZERO projects in the database the row is skipped with ONE honest warning (no fabricated scope)', async () => {
    sessionFor('admin')
    state().projectRows = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await flagsPost(jsonReq(url, { key: 'wallet', enabled: true }, '10.7.1.7'), undefined)
      expect(res.status).toBe(200) // the toggle itself succeeded
      expect(state().auditRows).toHaveLength(0) // …but the trail honestly has no row
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0])).toContain('NOT audited')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
