/**
 * /api/v1 Phase D (task 7-b) — the INTEL DIGEST + BUDGET-VARIANCE read
 * surfaces: GET /api/v1/projects/:id/intel and
 * GET /api/v1/projects/:id/budget-variance.
 *
 * Pinned invariants:
 *   · INTEL ROLE SCOPING: any signed-in role may read; a client-role session
 *     is pinned to its own project (foreign → 403 'Not permitted for this
 *     project'); unknown project → 404; anonymous → 401. W5-3: supplier
 *     sessions are not project readers — uniform 403.
 *   · NO FEATURE FLAG gates the intel READ — even with every flag forced
 *     off, the route still answers 200 (ai_progress/ai_voice gate the AI
 *     routes, not the intel module's deterministic reads; the webapp Intel
 *     tab renders while flags are off).
 *   · INTEL HONESTY — the digest carries flags state, the LATEST MjengoScore
 *     (score NULL = honest low-confidence, never a fake 0/100, with the
 *     explanation in notes), the latest risk assessment (findings parsed with
 *     the module's own safe parser — malformed stored JSON → [], never a
 *     500), the §48 health snapshot, the latest weekly digest row, and the
 *     anomalies summary (honest row counts over the Alert ledger + the 5
 *     newest alerts).
 *   · BUDGET-VARIANCE MIRROR — the v1 route mirrors /api/reports/
 *     budget-variance exactly: the SAME buildBudgetVarianceReport service
 *     call, same roles gate (contractor / admin / supervisor / qs — client,
 *     finance, procurement and supplier → 403 with the honest role message),
 *     same 30/min heavyweight-read limit (NOT the 120/min v1 read
 *     convention — the deliberate, documented deviation), null report → 404
 *     'Project not found', { ok: true, data } envelope.
 *   · The OpenAPI document carries the two new paths (27 /api/v1 total) with
 *     matching operationIds + tags + the IntelDigest schema (the
 *     budget-variance route reuses the existing BudgetVarianceReport).
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control), '@/backend/lib/db' (featureFlag rows + alert.findMany — the
 * anomalies read), '@/backend/lib/mjengo' (getProjectPayload — the payload's
 * intel slice) and '@/backend/modules/reports/service'
 * (buildBudgetVarianceReport — controlled here; the derivation math is
 * pinned by reports tests). route-kit, rate-limit, flags, intel/types
 * parsers, respond/schemas and the routes themselves stay REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

const d = (iso: string) => new Date(iso)

// ---------------------------------------------------------------- fixtures (hoisted for the db factory)

/** The project's alert ledger (the anomaly scan's output rows). */
const ALERTS = [
  {
    id: 'alt-00000005', projectId: 'p-1', type: 'anomaly', severity: 'warning', title: 'Cement burn rate above plan',
    message: '104 bags consumed vs 90 expected for 30% progress — verify consumption logs. Evidence: 6 rows. [rule: material_variance]',
    acknowledged: false, createdAt: d('2026-02-13T18:00:00Z'),
  },
  {
    id: 'alt-00000004', projectId: 'p-1', type: 'budget', severity: 'warning', title: 'Spend pace ahead of plan',
    message: 'Spend 34% vs plan 28% — review expenses. Evidence: 12 transactions. [rule: budget_pace]',
    acknowledged: false, createdAt: d('2026-02-12T18:00:00Z'),
  },
  {
    id: 'alt-00000003', projectId: 'p-1', type: 'anomaly', severity: 'critical', title: 'Duplicate purchase watch',
    message: 'PO-2026-000010 duplicates 80% of PO-2026-000009 lines while the first is still delivering. Evidence: 2 orders. [rule: duplicate_purchase_watch]',
    acknowledged: true, createdAt: d('2026-02-11T18:00:00Z'),
  },
  {
    id: 'alt-00000002', projectId: 'p-1', type: 'attendance', severity: 'info', title: 'Attendance override pattern',
    message: 'Joe (Foreman) recorded 14 attendance rows and 2 carry an override log. Evidence: 14 rows. [rule: attendance_override_pattern]',
    acknowledged: false, createdAt: d('2026-02-10T18:00:00Z'),
  },
  {
    id: 'alt-00000001', projectId: 'p-1', type: 'anomaly', severity: 'info', title: 'Delivery discrepancy note',
    message: 'PO-2026-000009 short-delivered 2 bags — recorded at receive time.',
    acknowledged: true, createdAt: d('2026-02-09T18:00:00Z'),
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
      alert: {
        async findMany({ where }: { where?: { projectId?: string } }) {
          return ALERTS.filter((a) => !where?.projectId || a.projectId === where.projectId)
            .map((a) => ({ ...a }))
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

// The payload seam the intel route reuses (the intel slice — controlled
// here; pinned by the app's own tests).
const svc = vi.hoisted(() => ({
  getProjectPayload: vi.fn(),
}))

vi.mock('@/backend/lib/mjengo', () => svc)

// The reports service seam the budget-variance mirror calls (the app route's
// exact dependency — the derivation math is pinned by reports tests).
const reports = vi.hoisted(() => ({
  buildBudgetVarianceReport: vi.fn(),
}))

vi.mock('@/backend/modules/reports/service', () => reports)

import { GET as openapiGet } from '@/app/api/openapi.json/route'
import { GET as projectIntelGet } from '@/app/api/v1/projects/[id]/intel/route'
import { GET as projectBudgetVarianceGet } from '@/app/api/v1/projects/[id]/budget-variance/route'
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

// ---------------------------------------------------------------- fixtures

const INTEL_SLICE = {
  risk: {
    id: 'ra-1', projectId: 'p-1', overallScore: 42, ruleVersion: 'v1',
    computedAt: d('2026-02-12T08:00:00Z'),
    findings: JSON.stringify([
      {
        rule: 'budget_pace', severity: 'warning', title: 'Budget pace', score: 15,
        message: 'Spend 34% is 12 points ahead of plan.', evidence: '12 transactions · 5 phases',
      },
      {
        rule: 'attendance_watch', severity: 'info', title: 'Attendance', score: 5,
        message: '3 of 70 rows carry exceptions this week.', evidence: '70 attendance rows',
      },
    ]),
  },
  score: {
    id: 'ms-1', projectId: 'p-1', score: 90, confidence: 'high', ruleVersion: '1',
    computedAt: d('2026-02-13T09:00:00Z'),
    components: JSON.stringify([
      {
        key: 'evidence_backed_releases', label: 'Evidence-backed releases', weight: 20, value: 100,
        deduction: 0, evidence: '1 of 1 released milestones carry evidence',
      },
      {
        key: 'attendance_verification', label: 'Attendance verification', weight: 15, value: 70,
        deduction: 4.5, evidence: '49 of 70 verified in the trailing 30 days',
      },
    ]),
    notes: null,
  },
  digests: [
    {
      id: 'dg-1', projectId: 'p-1', weekStart: '2026-02-09',
      summary: 'Week of 2026-02-09: progress 34% · risk 42/100 · 1 release decision pending.',
      items: JSON.stringify([
        { kind: 'risk', title: 'Risk score 42/100', detail: 'Computed 2026-02-12 (rule set v1). 2 rule finding(s) on record.' },
        { kind: 'procurement', title: '1 order in transit', detail: 'Counts straight from the request, order and delivery tables for this project.' },
      ]),
      createdAt: d('2026-02-09T18:00:00Z'),
    },
  ],
  pricePoints: [],
  priceTrends: [],
  suggestions: [],
  reliability: [],
  health: {
    projectId: 'p-1',
    computedAt: '2026-02-14T08:00:00.000Z',
    overall: 74,
    dimensions: [
      { key: 'progress', label: 'Progress', score: 80, grade: 'good', summary: 'Budget-weighted phase progress 34%.' },
      { key: 'budget', label: 'Budget', score: 62, grade: 'attention', summary: 'Spend 34% vs plan 28% — pace ahead.' },
    ],
  },
  flags: {
    ai_progress: true, ai_voice: false, wallet: true, marketplace: false, land_verification: true,
  },
}

const PAYLOAD = {
  project: { id: 'p-1', name: 'Nyumba Yangu' },
  intel: INTEL_SLICE,
}

/** A representative BudgetVarianceReport (the app route's contract). */
const REPORT = {
  project: {
    id: 'p-1', name: 'Nyumba Yangu', budgetTotal: 4_500_000, spent: 1_530_000,
    remaining: 2_970_000, spentPct: 34, progressPct: 34,
  },
  phases: [
    {
      id: 'ph-1', name: 'Site Prep & Foundation', budget: 800_000, spent: 800_000,
      variance: 0, variancePct: 0, progressPct: 100, txCount: 1,
      codedSpent: 0, codedTxnCount: 0,
      topTransactions: [{ id: 'tx-1', note: 'Foundation complete released', amount: 800_000, date: '2026-01-20T18:00:00.000Z' }],
    },
  ],
  categories: [
    { key: 'material', label: 'Materials', spent: 980_000, txCount: 9, share: 64 },
    { key: 'wage', label: 'Wages', spent: 384_000, txCount: 42, share: 25 },
  ],
  phaseAttribution: {
    mode: 'estimated', codedSpent: 0, codedTxnCount: 0,
    milestoneDerivedSpent: 800_000, milestoneDerivedTxnCount: 1,
    estimatedSpent: 730_000, estimatedTxnCount: 51,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  svc.getProjectPayload.mockResolvedValue(PAYLOAD)
  reports.buildBudgetVarianceReport.mockResolvedValue(REPORT)
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  vi.useRealTimers()
})

// ---------------------------------------------------------------- intel digest

describe('GET /api/v1/projects/:id/intel — the digest', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/${id}/intel${qs}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — flags state, latest score, risk, health, weekly digest + the anomalies summary (one object)', async () => {
    sessionFor('contractor')
    const res = await projectIntelGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.data).toEqual({
      projectId: 'p-1',
      flags: { ai_progress: true, ai_voice: false, wallet: true, marketplace: false, land_verification: true },
      score: {
        score: 90, confidence: 'high', ruleVersion: '1', computedAt: '2026-02-13T09:00:00.000Z',
        componentsCount: 2,
        components: [
          {
            key: 'evidence_backed_releases', label: 'Evidence-backed releases', weight: 20, value: 100,
            deduction: 0, evidence: '1 of 1 released milestones carry evidence',
          },
          {
            key: 'attendance_verification', label: 'Attendance verification', weight: 15, value: 70,
            deduction: 4.5, evidence: '49 of 70 verified in the trailing 30 days',
          },
        ],
        notes: null,
      },
      risk: {
        overallScore: 42, ruleVersion: 'v1', computedAt: '2026-02-12T08:00:00.000Z',
        findings: [
          {
            rule: 'budget_pace', severity: 'warning', title: 'Budget pace', score: 15,
            message: 'Spend 34% is 12 points ahead of plan.', evidence: '12 transactions · 5 phases',
          },
          {
            rule: 'attendance_watch', severity: 'info', title: 'Attendance', score: 5,
            message: '3 of 70 rows carry exceptions this week.', evidence: '70 attendance rows',
          },
        ],
      },
      health: {
        overall: 74, computedAt: '2026-02-14T08:00:00.000Z',
        dimensions: [
          { key: 'progress', label: 'Progress', score: 80, grade: 'good', summary: 'Budget-weighted phase progress 34%.' },
          { key: 'budget', label: 'Budget', score: 62, grade: 'attention', summary: 'Spend 34% vs plan 28% — pace ahead.' },
        ],
      },
      digest: {
        id: 'dg-1', weekStart: '2026-02-09',
        summary: 'Week of 2026-02-09: progress 34% · risk 42/100 · 1 release decision pending.',
        items: [
          { kind: 'risk', title: 'Risk score 42/100', detail: 'Computed 2026-02-12 (rule set v1). 2 rule finding(s) on record.' },
          { kind: 'procurement', title: '1 order in transit', detail: 'Counts straight from the request, order and delivery tables for this project.' },
        ],
        createdAt: '2026-02-09T18:00:00.000Z',
      },
      anomalies: {
        total: 5, unacknowledged: 3, critical: 1, warning: 2, info: 2,
        byType: { anomaly: 3, budget: 1, attendance: 1, safety: 0, progress: 0, info: 0 },
        latest: ALERTS.map((a) => ({
          id: a.id, type: a.type, severity: a.severity, title: a.title, message: a.message,
          acknowledged: a.acknowledged, createdAt: a.createdAt.toISOString(),
        })),
      },
    })
  })

  it('the anomalies summary caps `latest` at the 5 newest rows (newest first)', async () => {
    sessionFor('admin')
    // 7 alerts → latest must carry exactly the 5 newest
    const extra = ALERTS.concat([
      { id: 'alt-00000006', projectId: 'p-1', type: 'safety', severity: 'info', title: 'PPE note', message: 'Helmets on site.', acknowledged: true, createdAt: d('2026-02-08T18:00:00Z') },
      { id: 'alt-00000007', projectId: 'p-1', type: 'progress', severity: 'info', title: 'Older note', message: 'Progress ok.', acknowledged: true, createdAt: d('2026-02-07T18:00:00Z') },
    ])
    const original = ALERTS.length
    ALERTS.push(extra[original], extra[original + 1])
    try {
      const data = (await bodyOf(await projectIntelGet(req('p-1'), ctx('p-1')))).data as Record<string, unknown>
      const anomalies = data.anomalies as { total: number; latest: Array<{ id: string }> }
      expect(anomalies.total).toBe(7)
      expect(anomalies.latest.map((a) => a.id)).toEqual([
        'alt-00000005', 'alt-00000004', 'alt-00000003', 'alt-00000002', 'alt-00000001',
      ])
    } finally {
      ALERTS.splice(original, 2)
    }
  })

  it('never-computed state — score/risk/health/digest all null (honest, never fabricated)', async () => {
    svc.getProjectPayload.mockResolvedValueOnce({
      ...PAYLOAD,
      intel: {
        ...INTEL_SLICE, risk: null, score: null, digests: [], health: null,
      },
    })
    sessionFor('admin')
    const body = await bodyOf(await projectIntelGet(req('p-1'), ctx('p-1')))
    expect(body.data).toMatchObject({ score: null, risk: null, health: null, digest: null })
    // the anomalies summary still answers (its source is the Alert ledger)
    expect((body.data as Record<string, unknown>)['anomalies']).toMatchObject({ total: 5, unacknowledged: 3 })
  })

  it('malformed stored JSON (components/findings/items) parses to [], never a 500', async () => {
    svc.getProjectPayload.mockResolvedValueOnce({
      ...PAYLOAD,
      intel: {
        ...INTEL_SLICE,
        risk: { ...INTEL_SLICE.risk, findings: 'not-json' },
        score: { ...INTEL_SLICE.score, components: 'nope' },
        digests: [{ ...INTEL_SLICE.digests[0], items: 'x' }],
      },
    })
    sessionFor('contractor')
    const res = await projectIntelGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const data = (await bodyOf(res)).data as Record<string, Record<string, unknown>>
    expect(data.risk.findings).toEqual([])
    expect(data.score.components).toEqual([])
    expect(data.score.componentsCount).toBe(0)
    expect(data.digest.items).toEqual([])
  })

  it('scoping: unknown project → 404; foreign client → 403; own client → 200; supplier → uniform 403; anonymous → 401', async () => {
    svc.getProjectPayload.mockResolvedValueOnce(null)
    sessionFor('admin')
    expect((await projectIntelGet(req('p-x'), ctx('p-x'))).status).toBe(404)

    sessionFor('client', 'p-2')
    const denied = await projectIntelGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    sessionFor('client', 'p-1')
    expect((await projectIntelGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    sessionFor('supplier')
    const supplierDenied = await projectIntelGet(req('p-1'), ctx('p-1'))
    expect(supplierDenied.status).toBe(403)
    expect(await bodyOf(supplierDenied)).toEqual({ error: 'Not permitted for this supplier account' })

    h.session = null
    expect((await projectIntelGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })

  it('unknown query key → 400 (typo protection, strictObject)', async () => {
    sessionFor('admin')
    const res = await projectIntelGet(req('p-1', '?score=1'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "score"' })
  })

  it('NO FEATURE FLAG gates the read — every flag forced OFF + contractor → 200', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress,ai_voice,wallet,marketplace,land_verification'
    invalidateFlagCache()
    sessionFor('contractor')
    const res = await projectIntelGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------- budget variance

describe('GET /api/v1/projects/:id/budget-variance — the v1 mirror', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/${id}/budget-variance${qs}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — the report served verbatim through the SAME service call the app route makes', async () => {
    sessionFor('contractor')
    const res = await projectBudgetVarianceGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body).toEqual({ ok: true, data: REPORT })
    expect(reports.buildBudgetVarianceReport).toHaveBeenCalledWith('p-1')
    expect(reports.buildBudgetVarianceReport).toHaveBeenCalledTimes(1)
  })

  it('unknown project → 404 { error: "Project not found" } (null report — never an empty report)', async () => {
    reports.buildBudgetVarianceReport.mockResolvedValueOnce(null)
    sessionFor('contractor')
    const res = await projectBudgetVarianceGet(req('p-x'), ctx('p-x'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Project not found' })
  })

  it('the mirror keeps the app route\'s role gate: client/finance/procurement/supplier → 403; qs+supervisor+admin → 200', async () => {
    for (const role of ['client', 'finance', 'procurement', 'supplier']) {
      sessionFor(role)
      const denied = await projectBudgetVarianceGet(req('p-1'), ctx('p-1'))
      expect(denied.status, `${role} should be denied`).toBe(403)
      expect(await bodyOf(denied)).toEqual({ error: `Not permitted for role "${role}"` })
    }
    for (const role of ['qs', 'supervisor', 'admin']) {
      sessionFor(role)
      expect((await projectBudgetVarianceGet(req('p-1'), ctx('p-1'))).status, `${role} should pass`).toBe(200)
    }
    h.session = null
    expect((await projectBudgetVarianceGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })

  it('a malformed :id (41 chars) → 400 field "id"; unknown query key → 400', async () => {
    sessionFor('contractor')
    const long = 'x'.repeat(41)
    const res = await projectBudgetVarianceGet(req(long), ctx(long))
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).field).toBe('id')

    const bad = await projectBudgetVarianceGet(req('p-1', '?projectId=p-1'), ctx('p-1'))
    expect(bad.status).toBe(400)
    expect(await bodyOf(bad)).toEqual({ error: 'Unknown field(s): "projectId"' })
  })

  it('rate limit mirrors the app route\'s heavyweight-read 30/min (the 31st call → 429)', async () => {
    vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
    try {
      sessionFor('contractor')
      const withIp = () => getReq('http://localhost/api/v1/projects/p-1/budget-variance', { 'x-forwarded-for': '10.99.0.8' })
      const ctxP1 = { params: Promise.resolve({ id: 'p-1' }) }
      for (let i = 0; i < 30; i++) {
        const res = await projectBudgetVarianceGet(withIp(), ctxP1)
        expect(res.status, `request ${i + 1} should pass`).toBe(200)
      }
      const blocked = await projectBudgetVarianceGet(withIp(), ctxP1)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
      expect(await bodyOf(blocked)).toMatchObject({ error: 'Too many requests' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------- OpenAPI

describe('GET /api/openapi.json — Phase D intel + budget-variance paths', () => {
  it('serves the two paths with matching operationIds + tags; /api/v1 counts 27 paths', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    expect(Object.keys(doc.paths)).toContain('/api/v1/projects/{id}/intel')
    expect(Object.keys(doc.paths)).toContain('/api/v1/projects/{id}/budget-variance')
    expect(doc.paths['/api/v1/projects/{id}/intel'].get.operationId).toBe('getProjectIntelDigest')
    expect(doc.paths['/api/v1/projects/{id}/budget-variance'].get.operationId).toBe('getProjectBudgetVariance')
    expect(doc.paths['/api/v1/projects/{id}/intel'].get.tags).toEqual(['intel'])
    expect(doc.paths['/api/v1/projects/{id}/budget-variance'].get.tags).toEqual(['reports'])
    const v1Paths = Object.keys(doc.paths).filter((p) => p.startsWith('/api/v1'))
    expect(v1Paths.length).toBe(27)
  })

  it('the IntelDigest schema is declared and carries the honesty notes; the mirror reuses BudgetVarianceReport', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    expect(Object.keys(doc.components.schemas)).toContain('IntelDigest')
    expect(doc.components.schemas.IntelDigest.description).toMatch(/describes, humans\s+decide/i)
    expect(doc.components.schemas.IntelDigest.description).toMatch(/NULL \(never a fake 0 or 100\)/i)
    // the mirror route $refs the SAME component the app route serves
    expect(
      JSON.stringify(doc.paths['/api/v1/projects/{id}/budget-variance'].get.responses[200]),
    ).toContain('#/components/schemas/BudgetVarianceReport')
  })

  it('SDK ROUND-TRIP: the documented required fields are exactly the response fields (no drift, no leaks)', async () => {
    sessionFor('contractor')
    // Unique IP: a fresh rate-limit principal for these requests.
    const withIp = (url: string) => getReq(url, { 'x-forwarded-for': '10.99.0.9' })
    const doc = (await (await openapiGet()).json()) as Record<string, any>

    const intel = (await bodyOf(
      await projectIntelGet(withIp('http://localhost/api/v1/projects/p-1/intel'), { params: Promise.resolve({ id: 'p-1' }) }),
    )).data as Record<string, unknown>
    const intelSchema = doc.components.schemas.IntelDigest as { required: string[]; properties: Record<string, unknown> }
    for (const key of intelSchema.required) expect(intel, `IntelDigest.${key}`).toHaveProperty(key)
    for (const key of Object.keys(intel)) expect(intelSchema.properties, `undocumented intel key "${key}"`).toHaveProperty(key)

    // flags ↔ the flags sub-object
    const flags = intel.flags as Record<string, unknown>
    const flagsSchema = intelSchema.properties.flags as { required: string[]; properties: Record<string, unknown> }
    for (const key of flagsSchema.required) expect(flags, `flags.${key}`).toHaveProperty(key)
    for (const key of Object.keys(flags)) expect(flagsSchema.properties, `undocumented flags key "${key}"`).toHaveProperty(key)

    // score ↔ the score sub-object (components rows included)
    const score = intel.score as Record<string, unknown>
    const scoreSchema = intelSchema.properties.score as { required: string[]; properties: Record<string, unknown> }
    for (const key of scoreSchema.required) expect(score, `score.${key}`).toHaveProperty(key)
    for (const key of Object.keys(score)) expect(scoreSchema.properties, `undocumented score key "${key}"`).toHaveProperty(key)
    const componentRow = (score.components as Array<Record<string, unknown>>)[0]
    const componentSchema = (scoreSchema.properties.components as { items: { required: string[]; properties: Record<string, unknown> } }).items
    for (const key of componentSchema.required) expect(componentRow, `components.${key}`).toHaveProperty(key)
    for (const key of Object.keys(componentRow)) expect(componentSchema.properties, `undocumented components key "${key}"`).toHaveProperty(key)

    // anomalies ↔ the anomalies sub-object (latest rows included)
    const anomalies = intel.anomalies as Record<string, unknown>
    const anomaliesSchema = intelSchema.properties.anomalies as { required: string[]; properties: Record<string, unknown> }
    for (const key of anomaliesSchema.required) expect(anomalies, `anomalies.${key}`).toHaveProperty(key)
    for (const key of Object.keys(anomalies)) expect(anomaliesSchema.properties, `undocumented anomalies key "${key}"`).toHaveProperty(key)
    const alertRow = (anomalies.latest as Array<Record<string, unknown>>)[0]
    const alertSchema = (anomaliesSchema.properties.latest as { items: { required: string[]; properties: Record<string, unknown> } }).items
    for (const key of alertSchema.required) expect(alertRow, `latest.${key}`).toHaveProperty(key)
    for (const key of Object.keys(alertRow)) expect(alertSchema.properties, `undocumented latest key "${key}"`).toHaveProperty(key)

    // budget-variance ↔ the shared BudgetVarianceReport (top-level keys)
    const budget = (await bodyOf(
      await projectBudgetVarianceGet(withIp('http://localhost/api/v1/projects/p-1/budget-variance'), { params: Promise.resolve({ id: 'p-1' }) }),
    )).data as Record<string, unknown>
    const budgetSchema = doc.components.schemas.BudgetVarianceReport as { required: string[]; properties: Record<string, unknown> }
    for (const key of budgetSchema.required) expect(budget, `BudgetVarianceReport.${key}`).toHaveProperty(key)
    for (const key of Object.keys(budget)) expect(budgetSchema.properties, `undocumented budget key "${key}"`).toHaveProperty(key)
  })
})
