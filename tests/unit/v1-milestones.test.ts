/**
 * /api/v1 Phase C (W3-2) — the MONEY-GOVERNANCE milestone + escrow contract:
 * GET /api/v1/projects/:id/milestones, GET /api/v1/milestones/:id and
 * GET /api/v1/projects/:id/escrow.
 *
 * Pinned invariants:
 *   · ROLE SCOPING mirrors the v1 payments precedent — resolve first, pin
 *     second: any signed-in role may read; a client-role session is pinned
 *     to its own project (foreign → 403 'Not permitted for this project',
 *     indistinguishable for probes; own → 200); unknown project/milestone →
 *     404; anonymous → 401.
 *   · NO FEATURE FLAG gates these resources — even with every flag forced
 *     off (wallet included), the reads still answer 200: flags.ts documents
 *     that the escrow/milestone release ladder survives the wallet flag.
 *   · CURSOR PAGINATION — stable pages, no overlap, ?status= filters BEFORE
 *     pagination, a cursor outside the (filtered) list → 400 { field }.
 *   · LADDER HONESTY — the timestamps are the three the model persists
 *     (requestedAt/decidedAt/releasedAt, null until reached); evidence
 *     photos are IDS ONLY (no bytes, no URLs); a malformed stored
 *     evidencePhotoIds string parses to [], never a 500; releaseLedger is
 *     null for not-released milestones and pre-ledger history (never
 *     fabricated).
 *   · ESCROW HONESTY — the balance is DERIVED from the ESCROW:<projectId>
 *     ledger account entries (credits − debits, the real derivedBalance) —
 *     never a stored number; a project with no ledger account derives an
 *     honest 0; the route never writes.
 *   · The OpenAPI document carries the new paths (19 /api/v1 total) with
 *     matching operationIds + tags.
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control for route-kit's withGuard), '@/backend/lib/db' (featureFlag rows +
 * the route-layer reads: project.findUnique, milestone.findFirst,
 * phase.findUnique, transaction.findFirst, ledgerAccount.findUnique), and
 * '@/backend/lib/mjengo' (getProjectPayload — the payload's milestones/
 * phases reads). route-kit, rate-limit, flags, ledger/service.derivedBalance,
 * respond/schemas and the routes themselves stay REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

const d = (iso: string) => new Date(iso)

// ---------------------------------------------------------------- fixtures (hoisted for the db factory)

/** Six milestones walking the whole ladder (createdAt ASC: ms1 → ms6). */
const MILESTONES = [
  {
    id: 'mst-00000001', projectId: 'p-1', phaseId: 'ph-1', name: 'Foundation complete', amount: 800_000,
    status: 'released', evidencePhotoIds: '["photo-f1","photo-f2"]',
    requestedAt: d('2026-01-18T11:00:00Z'), decidedAt: d('2026-01-20T18:00:00Z'),
    decidedBy: 'Amina (Client)', decisionNote: 'Foundation inspected via photos — approved for release.',
    releasedAt: d('2026-01-20T18:00:00Z'), createdAt: d('2026-01-10T09:00:00Z'),
  },
  {
    id: 'mst-00000002', projectId: 'p-1', phaseId: 'ph-2', name: 'Walling to ring beam', amount: 650_000,
    status: 'release_requested', evidencePhotoIds: '["photo-w1"]',
    requestedAt: d('2026-02-13T16:00:00Z'), decidedAt: null, decidedBy: null, decisionNote: null,
    releasedAt: null, createdAt: d('2026-01-20T09:00:00Z'),
  },
  {
    id: 'mst-00000003', projectId: 'p-1', phaseId: 'ph-3', name: 'Roofing package', amount: 500_000,
    status: 'locked', evidencePhotoIds: '[]',
    requestedAt: null, decidedAt: null, decidedBy: null, decisionNote: null,
    releasedAt: null, createdAt: d('2026-02-01T09:00:00Z'),
  },
  {
    id: 'mst-00000004', projectId: 'p-1', phaseId: null, name: 'Plumbing first fix', amount: 120_000,
    status: 'evidence_submitted', evidencePhotoIds: '["photo-p1"]',
    requestedAt: null, decidedAt: null, decidedBy: null, decisionNote: null,
    releasedAt: null, createdAt: d('2026-02-05T09:00:00Z'),
  },
  {
    id: 'mst-00000005', projectId: 'p-1', phaseId: 'ph-2', name: 'Electrical rough-in', amount: 90_000,
    status: 'rejected', evidencePhotoIds: '["photo-e1"]',
    requestedAt: d('2026-02-08T10:00:00Z'), decidedAt: d('2026-02-09T15:00:00Z'),
    decidedBy: 'Amina (Client)', decisionNote: 'Conduit routing not per drawing — rework first.',
    releasedAt: null, createdAt: d('2026-02-10T09:00:00Z'),
  },
  {
    // malformed stored evidence JSON — must parse to [], never a 500
    id: 'mst-00000006', projectId: 'p-1', phaseId: null, name: 'Site hoarding', amount: 40_000,
    status: 'locked', evidencePhotoIds: 'not-json',
    requestedAt: null, decidedAt: null, decidedBy: null, decisionNote: null,
    releasedAt: null, createdAt: d('2026-02-15T09:00:00Z'),
  },
]

const PHASES = [
  { id: 'ph-1', name: 'Site Prep & Foundation' },
  { id: 'ph-2', name: 'Walling' },
  { id: 'ph-3', name: 'Roofing' },
]

/** The runtime-release Transaction row (money.ts releaseMilestoneAtomic). */
const RELEASE_TXN = {
  id: 'tx-rel-1', projectId: 'p-1', type: 'milestone', amount: 800_000, method: 'escrow',
  reference: 'MJP-000001', costCode: 'milestone', phaseId: 'ph-1', ledgerTxnId: 'ltx-rel-1',
  note: 'Foundation complete released to contractor — approved by Amina (Client)',
  date: d('2026-01-20T18:00:00Z'),
}

/** The escrow ledger accounts (liability: derived = credits − debits). */
const ESCROW_ACCOUNTS = [
  {
    id: 'la-esc-1', code: 'ESCROW:p-1', name: 'Project Escrow — 000001', kind: 'liability',
    normalSide: 'credit', ownerType: 'project', ownerId: 'p-1',
    entries: [
      { side: 'credit', amount: 1_500_000 }, // top-up
      { side: 'debit', amount: 800_000 }, // the release above
    ],
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
      milestone: {
        async findFirst({ where }: { where: { id: string } }) {
          const found = MILESTONES.find((m) => m.id === where.id)
          return found ? structuredClone(found) : null
        },
      },
      phase: {
        async findUnique({ where }: { where: { id: string } }) {
          const found = PHASES.find((p) => p.id === where.id)
          return found ? { name: found.name } : null
        },
      },
      transaction: {
        async findFirst({ where }: { where: { type: string; reference: string } }) {
          return RELEASE_TXN.type === where.type && RELEASE_TXN.reference === where.reference
            ? structuredClone(RELEASE_TXN)
            : null
        },
      },
      ledgerAccount: {
        async findUnique({ where }: { where: { code: string } }) {
          const found = ESCROW_ACCOUNTS.find((a) => a.code === where.code)
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

// The payload seam the milestone LIST reuses (aggregations stay REAL in
// production — pinned by the app's own tests; here they are controlled).
const svc = vi.hoisted(() => ({
  getProjectPayload: vi.fn(),
}))

vi.mock('@/backend/lib/mjengo', () => svc)

import { GET as openapiGet } from '@/app/api/openapi.json/route'
import { GET as projectMilestonesGet } from '@/app/api/v1/projects/[id]/milestones/route'
import { GET as milestoneDetailGet } from '@/app/api/v1/milestones/[id]/route'
import { GET as projectEscrowGet } from '@/app/api/v1/projects/[id]/escrow/route'
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
  phases: [
    { id: 'ph-1', name: 'Site Prep & Foundation' },
    { id: 'ph-2', name: 'Walling' },
    { id: 'ph-3', name: 'Roofing' },
  ],
  milestones: MILESTONES.map((m) => ({ ...m })),
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

// ---------------------------------------------------------------- milestone list

describe('GET /api/v1/projects/:id/milestones — the release ladder list', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/${id}/milestones${qs}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — every milestone, deterministic (createdAt ASC, id ASC) order, phase names joined', async () => {
    sessionFor('contractor')
    const res = await projectMilestonesGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const items = body.data as Array<Record<string, unknown>>
    expect(items.map((m) => m.id)).toEqual(['mst-00000001', 'mst-00000002', 'mst-00000003', 'mst-00000004', 'mst-00000005', 'mst-00000006'])
    expect(items[0]).toEqual({
      id: 'mst-00000001', phaseId: 'ph-1', phaseName: 'Site Prep & Foundation',
      name: 'Foundation complete', amount: 800_000, status: 'released', evidencePhotoCount: 2,
      requestedAt: '2026-01-18T11:00:00.000Z', decidedAt: '2026-01-20T18:00:00.000Z',
      releasedAt: '2026-01-20T18:00:00.000Z', createdAt: '2026-01-10T09:00:00.000Z',
    })
    // no phase → null phaseName; malformed evidence JSON → count 0, never a 500
    expect(items[3]).toMatchObject({ phaseId: null, phaseName: null, status: 'evidence_submitted', evidencePhotoCount: 1 })
    expect(items[5]).toMatchObject({ status: 'locked', evidencePhotoCount: 0 })
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('?status= filters BEFORE pagination — released → 1, rejected keeps its decision fields summary', async () => {
    sessionFor('admin')
    const released = await bodyOf(await projectMilestonesGet(req('p-1', '?status=released'), ctx('p-1')))
    expect((released.data as Array<{ id: string }>).map((m) => m.id)).toEqual(['mst-00000001'])
    const rejected = await bodyOf(await projectMilestonesGet(req('p-1', '?status=rejected'), ctx('p-1')))
    const items = rejected.data as Array<Record<string, unknown>>
    expect(items.length).toBe(1)
    expect(items[0]).toMatchObject({ id: 'mst-00000005', decidedAt: '2026-02-09T15:00:00.000Z', releasedAt: null })
    const locked = await bodyOf(await projectMilestonesGet(req('p-1', '?status=locked'), ctx('p-1')))
    expect((locked.data as unknown[]).length).toBe(2)
  })

  it('an undocumented status value → honest 400 listing the six documented ones', async () => {
    sessionFor('contractor')
    const res = await projectMilestonesGet(req('p-1', '?status=paused'), ctx('p-1'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/status must be one of locked, evidence_submitted, release_requested, approved, released, rejected/)
    expect(body.field).toBe('status')
  })

  it('cursor pagination: limit=2 pages walk all 6 milestones with no overlap', async () => {
    sessionFor('admin')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const url = `http://localhost/api/v1/projects/p-1/milestones?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await bodyOf(await projectMilestonesGet(getReq(url), ctx('p-1')))
      seen.push(...(body.data as Array<{ id: string }>).map((m) => m.id))
      pages++
      expect(body.hasMore).toBe(pages < 3)
      cursor = (body.nextCursor as string | null) ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual(['mst-00000001', 'mst-00000002', 'mst-00000003', 'mst-00000004', 'mst-00000005', 'mst-00000006'])
  })

  it('a cursor that fell out of the filtered list → 400 naming "a milestone"', async () => {
    sessionFor('admin')
    const res = await projectMilestonesGet(req('p-1', '?status=locked&cursor=mst-00000001'), ctx('p-1'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/the id of a milestone in this list/)
    expect(body.field).toBe('cursor')
  })

  it('unknown query key → 400 (typo protection, strictObject)', async () => {
    sessionFor('admin')
    const res = await projectMilestonesGet(req('p-1', '?phase=ph-1'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "phase"' })
  })

  it('scoping: unknown project → 404; foreign client → 403; own client → 200; anonymous → 401', async () => {
    svc.getProjectPayload.mockResolvedValueOnce(null)
    sessionFor('admin')
    expect((await projectMilestonesGet(req('p-x'), ctx('p-x'))).status).toBe(404)

    sessionFor('client', 'p-2')
    const denied = await projectMilestonesGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    sessionFor('client', 'p-1')
    expect((await projectMilestonesGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    h.session = null
    expect((await projectMilestonesGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })
})

// ---------------------------------------------------------------- milestone detail

describe('GET /api/v1/milestones/:id — the full ladder', () => {
  const req = (id: string) => getReq(`http://localhost/api/v1/milestones/${id}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 released — ladder timestamps, evidence photo ids, decision history + the release ledger tie', async () => {
    sessionFor('client', 'p-1')
    const res = await milestoneDetailGet(req('mst-00000001'), ctx('mst-00000001'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.data).toEqual({
      id: 'mst-00000001', projectId: 'p-1', phaseId: 'ph-1', phaseName: 'Site Prep & Foundation',
      name: 'Foundation complete', amount: 800_000, status: 'released', evidencePhotoCount: 2,
      requestedAt: '2026-01-18T11:00:00.000Z', decidedAt: '2026-01-20T18:00:00.000Z',
      releasedAt: '2026-01-20T18:00:00.000Z', createdAt: '2026-01-10T09:00:00.000Z',
      evidencePhotoIds: ['photo-f1', 'photo-f2'],
      decidedBy: 'Amina (Client)',
      decisionNote: 'Foundation inspected via photos — approved for release.',
      releaseLedger: {
        transactionId: 'tx-rel-1', reference: 'MJP-000001', amount: 800_000, method: 'escrow',
        ledgerTxnId: 'ltx-rel-1', costCode: 'milestone', date: '2026-01-20T18:00:00.000Z',
        note: 'Foundation complete released to contractor — approved by Amina (Client)',
      },
    })
  })

  it('200 locked — nulls everywhere the ladder has not reached, releaseLedger null (never fabricated)', async () => {
    sessionFor('contractor')
    const body = await bodyOf(await milestoneDetailGet(req('mst-00000003'), ctx('mst-00000003')))
    expect(body.data).toMatchObject({
      status: 'locked', evidencePhotoIds: [], decidedBy: null, decisionNote: null,
      requestedAt: null, decidedAt: null, releasedAt: null, releaseLedger: null,
      phaseName: 'Roofing',
    })
  })

  it('200 rejected — the decision history is preserved forever', async () => {
    sessionFor('admin')
    const body = await bodyOf(await milestoneDetailGet(req('mst-00000005'), ctx('mst-00000005')))
    expect(body.data).toMatchObject({
      status: 'rejected', decidedBy: 'Amina (Client)',
      decisionNote: 'Conduit routing not per drawing — rework first.',
      releasedAt: null, releaseLedger: null,
    })
  })

  it('200 release_requested — awaiting the client decision (requestedAt set, decided null)', async () => {
    sessionFor('client', 'p-1')
    const body = await bodyOf(await milestoneDetailGet(req('mst-00000002'), ctx('mst-00000002')))
    expect(body.data).toMatchObject({
      status: 'release_requested', requestedAt: '2026-02-13T16:00:00.000Z',
      decidedAt: null, decidedBy: null, releasedAt: null, releaseLedger: null,
      evidencePhotoIds: ['photo-w1'],
    })
  })

  it('evidence photo ids are IDS ONLY — no bytes, no storage URLs anywhere in the body', async () => {
    sessionFor('admin')
    const res = await milestoneDetailGet(req('mst-00000001'), ctx('mst-00000001'))
    expect(JSON.stringify(await bodyOf(res))).not.toMatch(/http|storageKey|photoUrls|\.png/)
  })

  it('scoping: unknown milestone → 404; foreign client → 403 (resolve-first, pin-second); anonymous → 401', async () => {
    sessionFor('admin')
    const missing = await milestoneDetailGet(req('mst-99999999'), ctx('mst-99999999'))
    expect(missing.status).toBe(404)
    expect(await bodyOf(missing)).toEqual({ error: 'Milestone not found' })

    sessionFor('client', 'p-2')
    const denied = await milestoneDetailGet(req('mst-00000001'), ctx('mst-00000001'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    h.session = null
    expect((await milestoneDetailGet(req('mst-00000001'), ctx('mst-00000001'))).status).toBe(401)
  })

  it('a malformed :id (41 chars) → 400 field "id"; unknown query key → 400', async () => {
    sessionFor('admin')
    const long = 'x'.repeat(41)
    const res = await milestoneDetailGet(req(long), ctx(long))
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).field).toBe('id')

    const bad = await milestoneDetailGet(getReq('http://localhost/api/v1/milestones/mst-00000001?projectId=p-1'), ctx('mst-00000001'))
    expect(bad.status).toBe(400)
    expect(await bodyOf(bad)).toEqual({ error: 'Unknown field(s): "projectId"' })
  })
})

// ---------------------------------------------------------------- escrow

describe('GET /api/v1/projects/:id/escrow — the ledger-derived balance', () => {
  const req = (id: string) => getReq(`http://localhost/api/v1/projects/${id}/escrow`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — balance DERIVED from the ESCROW ledger entries (credits − debits), never a stored number', async () => {
    sessionFor('contractor')
    const res = await projectEscrowGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.data).toEqual({
      projectId: 'p-1',
      currency: 'KES',
      balance: 700_000, // 1,500,000 credit − 800,000 release debit — from the ENTRIES
      ledgerAccountCode: 'ESCROW:p-1',
      derivation: expect.stringContaining('ledger entries'),
    })
    expect(String((body.data as { derivation: string }).derivation)).toContain('never the stored')
  })

  it('a project with no escrow ledger account yet → honest 0 (the route never creates it)', async () => {
    sessionFor('admin')
    const body = await bodyOf(await projectEscrowGet(req('p-2'), ctx('p-2')))
    expect(body.data).toMatchObject({ projectId: 'p-2', balance: 0, ledgerAccountCode: 'ESCROW:p-2' })
  })

  it('unknown project → 404 (not a zero balance); foreign client → 403; own client → 200; anonymous → 401', async () => {
    sessionFor('admin')
    expect((await projectEscrowGet(req('p-x'), ctx('p-x'))).status).toBe(404)

    sessionFor('client', 'p-2')
    expect((await projectEscrowGet(req('p-1'), ctx('p-1'))).status).toBe(403)

    sessionFor('client', 'p-1')
    expect((await projectEscrowGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    h.session = null
    expect((await projectEscrowGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })

  it('unknown query key → 400 (strictObject)', async () => {
    sessionFor('admin')
    const res = await projectEscrowGet(getReq('http://localhost/api/v1/projects/p-1/escrow?stored=1'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "stored"' })
  })
})

// ---------------------------------------------------------------- no flag gate

describe('no feature flag gates the money-governance reads', () => {
  it('every flag forced OFF (wallet included) + contractor → all three routes still answer 200', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress,ai_voice,wallet,marketplace,land_verification'
    invalidateFlagCache()
    sessionFor('contractor')
    const list = await projectMilestonesGet(getReq('http://localhost/api/v1/projects/p-1/milestones'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(list.status).toBe(200)
    const detail = await milestoneDetailGet(getReq('http://localhost/api/v1/milestones/mst-00000002'), { params: Promise.resolve({ id: 'mst-00000002' }) })
    expect(detail.status).toBe(200)
    const escrow = await projectEscrowGet(getReq('http://localhost/api/v1/projects/p-1/escrow'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(escrow.status).toBe(200)
  })
})

// ---------------------------------------------------------------- rate limit

describe('GET /api/v1/projects/:id/milestones — rate limit (120/min per principal)', () => {
  it('the 121st call within the window → 429 with Retry-After', async () => {
    // Fake timers freeze Date.now() so the continuous token refill cannot
    // mask the exhaustion (120 tokens at 120/min = 500ms per token).
    vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
    try {
      sessionFor('contractor')
      const withIp = () => getReq('http://localhost/api/v1/projects/p-1/milestones', { 'x-forwarded-for': '10.99.0.1' })
      const ctxP1 = { params: Promise.resolve({ id: 'p-1' }) }
      for (let i = 0; i < 120; i++) {
        const res = await projectMilestonesGet(withIp(), ctxP1)
        expect(res.status, `request ${i + 1} should pass`).toBe(200)
      }
      const blocked = await projectMilestonesGet(withIp(), ctxP1)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
      expect(await bodyOf(blocked)).toMatchObject({ error: 'Too many requests' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------- OpenAPI

describe('GET /api/openapi.json — Phase C milestone + escrow paths', () => {
  it('serves the five new money-governance paths; /api/v1 now counts 19 paths', async () => {
    const res = await openapiGet()
    expect(res.status).toBe(200)
    const doc = (await res.json()) as Record<string, any>
    for (const path of [
      '/api/v1/projects/{id}/milestones',
      '/api/v1/milestones/{id}',
      '/api/v1/projects/{id}/invoices',
      '/api/v1/invoices/{id}',
      '/api/v1/projects/{id}/escrow',
    ]) {
      expect(Object.keys(doc.paths)).toContain(path)
    }
    const v1Paths = Object.keys(doc.paths).filter((p) => p.startsWith('/api/v1'))
    expect(v1Paths.length).toBe(19)
  })

  it('matching operationIds + tags for the milestone/escrow ops', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    expect(doc.paths['/api/v1/projects/{id}/milestones'].get.operationId).toBe('listProjectMilestones')
    expect(doc.paths['/api/v1/milestones/{id}'].get.operationId).toBe('getMilestone')
    expect(doc.paths['/api/v1/projects/{id}/escrow'].get.operationId).toBe('getProjectEscrow')
    expect(doc.paths['/api/v1/projects/{id}/milestones'].get.tags).toEqual(['milestones'])
    expect(doc.paths['/api/v1/projects/{id}/escrow'].get.tags).toEqual(['milestones'])
  })

  it('the new schemas are declared and carry the honest notes (ledger-derived, photo ids only)', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    for (const name of ['MilestoneSummary', 'MilestoneDetail', 'ProjectEscrow']) {
      expect(Object.keys(doc.components.schemas)).toContain(name)
    }
    expect(doc.components.schemas.ProjectEscrow.description).toMatch(/never the stored/i)
    expect(doc.components.schemas.MilestoneDetail.description).toMatch(/IDS \(no bytes, no storage URLs/i)
    expect(doc.paths['/api/v1/projects/{id}/escrow'].get.description).toMatch(/derived/i)
  })

  it('SDK ROUND-TRIP: the documented required fields are exactly the response fields (no drift, no leaks)', async () => {
    sessionFor('contractor')
    const doc = (await (await openapiGet()).json()) as Record<string, any>

    // list item ↔ MilestoneSummary
    const listBody = await bodyOf(
      await projectMilestonesGet(getReq('http://localhost/api/v1/projects/p-1/milestones'), { params: Promise.resolve({ id: 'p-1' }) }),
    )
    const item = (listBody.data as Array<Record<string, unknown>>)[0]
    const summary = doc.components.schemas.MilestoneSummary as { required: string[]; properties: Record<string, unknown> }
    for (const key of summary.required) expect(item, `MilestoneSummary.${key}`).toHaveProperty(key)
    for (const key of Object.keys(item)) expect(summary.properties, `undocumented list key "${key}"`).toHaveProperty(key)

    // detail ↔ MilestoneDetail (incl. the releaseLedger sub-object)
    const detail = (await bodyOf(
      await milestoneDetailGet(getReq('http://localhost/api/v1/milestones/mst-00000001'), { params: Promise.resolve({ id: 'mst-00000001' }) }),
    )).data as Record<string, unknown>
    const detailSchema = doc.components.schemas.MilestoneDetail as { required: string[]; properties: Record<string, unknown> }
    for (const key of detailSchema.required) expect(detail, `MilestoneDetail.${key}`).toHaveProperty(key)
    for (const key of Object.keys(detail)) expect(detailSchema.properties, `undocumented detail key "${key}"`).toHaveProperty(key)
    const ledgerFields = (detail.releaseLedger as Record<string, unknown>)
    const ledgerSchema = detailSchema.properties.releaseLedger as { required: string[]; properties: Record<string, unknown> }
    for (const key of ledgerSchema.required) expect(ledgerFields, `releaseLedger.${key}`).toHaveProperty(key)
    for (const key of Object.keys(ledgerFields)) expect(ledgerSchema.properties, `undocumented releaseLedger key "${key}"`).toHaveProperty(key)

    // escrow ↔ ProjectEscrow
    const escrow = (await bodyOf(
      await projectEscrowGet(getReq('http://localhost/api/v1/projects/p-1/escrow'), { params: Promise.resolve({ id: 'p-1' }) }),
    )).data as Record<string, unknown>
    const escrowSchema = doc.components.schemas.ProjectEscrow as { required: string[]; properties: Record<string, unknown> }
    for (const key of escrowSchema.required) expect(escrow, `ProjectEscrow.${key}`).toHaveProperty(key)
    for (const key of Object.keys(escrow)) expect(escrowSchema.properties, `undocumented escrow key "${key}"`).toHaveProperty(key)
  })
})
