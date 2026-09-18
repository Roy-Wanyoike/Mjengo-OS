/**
 * /api/v1 issue #154 (audit API-3) — the DIRECT-READ pins for every
 * project-subresource list route that used to materialize the full
 * getProjectPayload (~20 reads) to slice one collection out of it.
 *
 * Pinned invariants (the #155 attendance-pin pattern applied to the family):
 *   · NO PAYLOAD — getProjectPayload is never called by any of the seven
 *     routes (the spy would fire if a route regressed to the old building
 *     block; the response contracts themselves are pinned byte-for-byte by
 *     the v1-*. suites, which stay green unedited in their assertions).
 *   · PUSHDOWN — every list route's single findMany carries where:{projectId}
 *     (+ the route's filter), the documented total order and take = limit+1;
 *     every page AFTER the first carries the cursor row's boundary (the
 *     keyset OR) so page 2 never re-reads page 1 rows at the DB level.
 *   · RESOLVE — the project resolves by db.project.findUnique (unknown →
 *     404, the attendance/deliveries step).
 *   · MODULE READS — suppliers read loadSupplierDirectoryBounded (the
 *     supply module's bounded directory), intel reads loadIntelSlice (the
 *     intel module's public read) + the route-layer Alert ledger read.
 *   · BOUNDED ROLLUP — the workers rollup reads ONE attendance query over
 *     the PAGE's workers inside an 8-day window (never the project's whole
 *     attendance history).
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control), '@/backend/lib/mjengo' (the getProjectPayload/getProjectsList
 * SPY — nothing else; no route in this suite may import more of it),
 * '@/backend/lib/db' (honest Prisma twins with recorded call args),
 * '@/backend/modules/supply/repository' (loadSupplierDirectoryBounded) and
 * '@/backend/modules/intel/repository' (loadIntelSlice). route-kit,
 * rate-limit, respond/schemas/keyset and the routes themselves stay REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string; role: string; projectId: string | null; supplierId?: string | null }
  },
}))

const d = (iso: string) => new Date(iso)

// ---------------------------------------------------------------- fixtures (hoisted for the db factory)

const TASKS = [
  {
    id: 'tsk-1', phaseId: 'ph-1', title: 'Pour slab', status: 'done', progress: 100, priority: 'high',
    dueDate: null, assignedToId: null, blockedById: null, blockedReason: null, verifiedAt: null,
    verifiedByName: null, version: 1, createdAt: d('2026-01-10T10:00:00Z'), updatedAt: d('2026-01-10T10:00:00Z'),
  },
  {
    id: 'tsk-2', phaseId: 'ph-2', title: 'Frame roof trusses', status: 'in_progress', progress: 50, priority: 'normal',
    dueDate: null, assignedToId: null, blockedById: null, blockedReason: null, verifiedAt: null,
    verifiedByName: null, version: 1, createdAt: d('2026-01-12T10:00:00Z'), updatedAt: d('2026-01-12T10:00:00Z'),
  },
  {
    id: 'tsk-3', phaseId: 'ph-1', title: 'Cure slab', status: 'pending', progress: 0, priority: 'normal',
    dueDate: null, assignedToId: null, blockedById: null, blockedReason: null, verifiedAt: null,
    verifiedByName: null, version: 1, createdAt: d('2026-01-15T10:00:00Z'), updatedAt: d('2026-01-15T10:00:00Z'),
  },
]

const TASK_PHASES: Record<string, { id: string; name: string; projectId: string }> = {
  'ph-1': { id: 'ph-1', name: 'Site Prep & Foundation', projectId: 'p-1' },
  'ph-2': { id: 'ph-2', name: 'Roofing', projectId: 'p-1' },
}

const PHASES = [
  { id: 'ph-1', name: 'Site Prep & Foundation' },
  { id: 'ph-2', name: 'Roofing' },
]

const MILESTONES = [
  {
    id: 'mst-1', projectId: 'p-1', phaseId: 'ph-1', name: 'Foundation complete', amount: 80000000n,
    status: 'released', evidencePhotoIds: '["photo-f1"]', requestedAt: d('2026-01-18T11:00:00Z'),
    decidedAt: d('2026-01-20T18:00:00Z'), decidedBy: 'Amina (Client)', decisionNote: null,
    releasedAt: d('2026-01-20T18:00:00Z'), createdAt: d('2026-01-10T09:00:00Z'),
  },
  {
    id: 'mst-2', projectId: 'p-1', phaseId: null, name: 'Plumbing first fix', amount: 120_000,
    status: 'locked', evidencePhotoIds: '[]', requestedAt: null, decidedAt: null, decidedBy: null,
    decisionNote: null, releasedAt: null, createdAt: d('2026-02-05T09:00:00Z'),
  },
  {
    id: 'mst-3', projectId: 'p-1', phaseId: 'ph-2', name: 'Roofing package', amount: 50000000n,
    status: 'release_requested', evidencePhotoIds: '["photo-w1"]', requestedAt: d('2026-02-13T16:00:00Z'),
    decidedAt: null, decidedBy: null, decisionNote: null, releasedAt: null, createdAt: d('2026-02-15T09:00:00Z'),
  },
]

const WORKERS = [
  {
    id: 'wrk-1', projectId: 'p-1', name: 'Amina Njeri', role: 'Fundi wa Mawe (Mason)', phone: '+254712000001',
    dailyRate: 150000n, active: true, employmentType: 'casual', skills: '["masonry"]',
    idNumber: null, emergencyContactName: null, emergencyContactPhone: null,
  },
  {
    id: 'wrk-2', projectId: 'p-1', name: 'Baraka Otieno', role: 'Foreman', phone: '+254712000002',
    dailyRate: 200000n, active: false, employmentType: null, skills: null,
    idNumber: null, emergencyContactName: null, emergencyContactPhone: null,
  },
]

/** Two day-rows of wrk-1 (the rollup window read's rows). */
const WORKER_ATTENDANCES = [
  {
    id: 'att-1', workerId: 'wrk-1', projectId: 'p-1', date: '2026-02-14', status: 'present',
    checkIn: d('2026-02-14T04:30:00Z'), checkOut: null, method: 'kiosk_pin', wage: 150000n, paid: true,
    synced: true, verification: 'verified', evidence: '["pin"]', exceptionReason: null, exceptionNote: null,
    overrideLog: null, recordedBy: 'Kiosk (site device)', createdAt: d('2026-02-14T07:30:00Z'), version: 1,
  },
  {
    id: 'att-2', workerId: 'wrk-1', projectId: 'p-1', date: '2026-02-13', status: 'present',
    checkIn: d('2026-02-13T04:35:00Z'), checkOut: null, method: 'geofence', wage: 150000n, paid: false,
    synced: true, verification: 'reported', evidence: null, exceptionReason: null, exceptionNote: null,
    overrideLog: null, recordedBy: 'Joe (Foreman)', createdAt: d('2026-02-13T18:00:00Z'), version: 1,
  },
]

const INVOICES = [
  {
    id: 'inv-1', invoiceCode: 'INV-2026-000021', projectId: 'p-1', orderId: null, supplierId: 'sup-1',
    status: 'paid', subtotal: 36300n, tax: 0n, total: 46000n, dueDate: null, issuedAt: null,
    submittedAt: null, decidedAt: null, decidedBy: null, paidAt: null, paidByRole: null,
    paymentMethod: null, paymentReference: null, createdBy: null, note: null,
    createdAt: d('2026-01-20T11:00:00Z'), updatedAt: d('2026-01-20T11:00:00Z'),
    lines: [{ id: 'il-1' }], supplier: { businessName: 'Nairobi Hardware Centre' }, order: null,
  },
  {
    id: 'inv-2', invoiceCode: 'INV-2026-000027', projectId: 'p-1', orderId: 'po-1', supplierId: 'sup-2',
    status: 'approved', subtotal: 62750n, tax: 0n, total: 62750n, dueDate: null, issuedAt: null,
    submittedAt: null, decidedAt: null, decidedBy: null, paidAt: null, paidByRole: null,
    paymentMethod: null, paymentReference: null, createdBy: null, note: null,
    createdAt: d('2026-02-07T11:00:00Z'), updatedAt: d('2026-02-07T11:00:00Z'),
    lines: [{ id: 'il-2' }, { id: 'il-3' }], supplier: { businessName: 'Kiambu Road Supplies' }, order: { orderCode: 'PO-2026-000009' },
  },
  {
    id: 'inv-3', invoiceCode: 'INV-2026-000031', projectId: 'p-1', orderId: null, supplierId: 'sup-1',
    status: 'submitted', subtotal: 136000n, tax: 0n, total: 138500n, dueDate: null, issuedAt: null,
    submittedAt: null, decidedAt: null, decidedBy: null, paidAt: null, paidByRole: null,
    paymentMethod: null, paymentReference: null, createdBy: null, note: null,
    createdAt: d('2026-02-11T11:00:00Z'), updatedAt: d('2026-02-11T11:00:00Z'),
    lines: [], supplier: null, order: null,
  },
]

const PARCELS = [
  {
    id: 'par-1', projectId: 'p-1', plotNumber: 'LR No. 2090/1234', county: 'Kiambu', town: 'Kitengela',
    lat: null, lng: null, approxArea: '0.25 ha', tenureType: 'freehold', status: 'verified',
    createdAt: d('2026-01-02T09:00:00Z'), updatedAt: d('2026-01-30T09:00:00Z'),
    documents: [{ id: 'pdoc-1' }, { id: 'pdoc-2' }],
    searches: [
      {
        id: 'srch-2', searchRef: 'RS-2026-000118', status: 'reviewed', transcriptionMatch: 'consistent',
        requestedAt: d('2026-01-10T09:00:00Z'), receivedAt: d('2026-01-27T09:00:00Z'),
        reviewedAt: d('2026-01-30T09:00:00Z'), createdAt: d('2026-01-10T09:00:00Z'),
      },
    ],
    assignments: [
      {
        id: 'asg-1', role: 'surveyor', status: 'active', createdAt: d('2026-01-05T09:00:00Z'),
        professional: { name: 'Surveyor Kimani', category: 'surveyor' },
      },
    ],
  },
  {
    id: 'par-2', projectId: 'p-1', plotNumber: 'LR No. 2090/5678', county: 'Kiambu', town: null,
    lat: null, lng: null, approxArea: null, tenureType: 'leasehold', status: 'flagged',
    createdAt: d('2026-01-15T09:00:00Z'), updatedAt: d('2026-02-08T09:00:00Z'),
    documents: [], searches: [], assignments: [],
  },
  {
    id: 'par-3', projectId: 'p-1', plotNumber: 'LR No. 2090/9012', county: 'Machakos', town: 'Athi River',
    lat: null, lng: null, approxArea: '50x100 ft', tenureType: null, status: 'searching',
    createdAt: d('2026-02-10T09:00:00Z'), updatedAt: d('2026-02-10T09:00:00Z'),
    documents: [], searches: [], assignments: [],
  },
]

const ALERTS = [
  {
    id: 'alt-1', projectId: 'p-1', type: 'anomaly', severity: 'warning', title: 'Cement burn rate above plan',
    message: '…', acknowledged: false, createdAt: d('2026-02-13T18:00:00Z'),
  },
  {
    id: 'alt-2', projectId: 'p-1', type: 'budget', severity: 'info', title: 'Spend pace note',
    message: '…', acknowledged: true, createdAt: d('2026-02-12T18:00:00Z'),
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
    projects: [{ id: 'p-1', name: 'Nyumba Yangu' }],
    // The #154 query-shape pins, in call order.
    taskCalls: [] as Array<Record<string, unknown>>,
    milestoneCalls: [] as Array<Record<string, unknown>>,
    workerCalls: [] as Array<Record<string, unknown>>,
    attendanceCalls: [] as Array<Record<string, unknown>>,
    invoiceCalls: [] as Array<Record<string, unknown>>,
    parcelCalls: [] as Array<Record<string, unknown>>,
    projectResolveCalls: [] as Array<Record<string, unknown>>,
  }

  /** (createdAt, id) keyset boundary — `gt` for asc, `lt` for desc. */
  const inCreatedAtBoundary = (
    row: { createdAt: Date; id: string },
    boundary: Array<Record<string, unknown>> | undefined,
    dir: 'asc' | 'desc',
  ) => {
    if (!boundary) return true
    return boundary.some((cond) => {
      const c = cond.createdAt as unknown
      if (c instanceof Date) {
        const id = cond.id as { gt?: string; lt?: string }
        return row.createdAt.getTime() === c.getTime() && (dir === 'asc' ? row.id > (id.gt ?? '') : row.id < (id.lt ?? ''))
      }
      const bound = (c as { gt?: Date; lt?: Date }).gt ?? (c as { lt?: Date }).lt
      return dir === 'asc' ? row.createdAt.getTime() > bound.getTime() : row.createdAt.getTime() < bound.getTime()
    })
  }

  const db = {
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
        state.projectResolveCalls.push({ where })
        return state.projects.find((p) => p.id === where.id) ?? null
      },
    },
    task: {
      async findFirst({ where }: { where: { id: string; phase?: { projectId: string }; status?: string } }) {
        const t = TASKS.find((x) => x.id === where.id)
        if (!t) return null
        if (where.phase && TASK_PHASES[t.phaseId].projectId !== where.phase.projectId) return null
        if (where.status && t.status !== where.status) return null
        return { ...t }
      },
      async findMany({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Array<Record<string, string>>; take?: number }) {
        state.taskCalls.push({ where, orderBy, take })
        const boundary = where?.OR as Array<Record<string, unknown>> | undefined
        const rows = TASKS.filter((t) => {
          if (where?.phase && TASK_PHASES[t.phaseId].projectId !== (where.phase as { projectId: string }).projectId) return false
          if (where?.status && t.status !== where.status) return false
          if (!inCreatedAtBoundary(t, boundary, 'asc')) return false
          return true
        }).map((t) => ({ ...t, phase: { ...TASK_PHASES[t.phaseId] } }))
        void orderBy // the fixture is already in (createdAt ASC, id ASC) order
        return take !== undefined ? rows.slice(0, take) : rows
      },
    },
    phase: {
      async findMany({ where }: { where?: { projectId?: string } }) {
        void where // every fixture phase belongs to p-1
        return PHASES.map((p) => ({ ...p }))
      },
    },
    milestone: {
      async findFirst({ where }: { where: { id: string; projectId?: string; status?: string } }) {
        const m = MILESTONES.find(
          (x) =>
            x.id === where.id &&
            (where.projectId === undefined || x.projectId === where.projectId) &&
            (where.status === undefined || x.status === where.status),
        )
        return m ? { ...m } : null
      },
      async findMany({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Array<Record<string, string>>; take?: number }) {
        state.milestoneCalls.push({ where, orderBy, take })
        const boundary = where?.OR as Array<Record<string, unknown>> | undefined
        const rows = MILESTONES.filter((m) => {
          if (where?.projectId && m.projectId !== where.projectId) return false
          if (where?.status && m.status !== where.status) return false
          if (!inCreatedAtBoundary(m, boundary, 'asc')) return false
          return true
        }).map((m) => ({ ...m }))
        void orderBy
        return take !== undefined ? rows.slice(0, take) : rows
      },
    },
    worker: {
      async findFirst({ where }: { where: { id: string; projectId?: string; active?: boolean } }) {
        const w = WORKERS.find(
          (x) =>
            x.id === where.id &&
            (where.projectId === undefined || x.projectId === where.projectId) &&
            (where.active === undefined || x.active === where.active),
        )
        return w ? { ...w } : null
      },
      async findMany({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Array<Record<string, string>>; take?: number }) {
        state.workerCalls.push({ where, orderBy, take })
        const boundary = where?.OR as Array<Record<string, unknown>> | undefined
        const inNameBoundary = (w: (typeof WORKERS)[number]) => {
          if (!boundary) return true
          return boundary.some((cond) => {
            const n = cond.name as unknown
            if (typeof n === 'string') {
              const id = cond.id as { gt: string }
              return w.name === n && w.id > id.gt
            }
            return w.name > (n as { gt: string }).gt
          })
        }
        const rows = WORKERS.filter((w) => {
          if (where?.projectId && w.projectId !== where.projectId) return false
          if (where?.active !== undefined && w.active !== where.active) return false
          if (!inNameBoundary(w)) return false
          return true
        }).map((w) => ({ ...w }))
        void orderBy // the fixture is already in (name ASC, id ASC) order
        return take !== undefined ? rows.slice(0, take) : rows
      },
    },
    attendance: {
      async findMany({ where }: { where?: { projectId?: string; workerId?: { in?: string[] }; date?: { gte?: string } } }) {
        state.attendanceCalls.push({ where })
        void where?.projectId
        const ids = where?.workerId?.in
        return WORKER_ATTENDANCES.filter(
          (a) => (!ids || ids.includes(a.workerId)) && (!where?.date?.gte || a.date >= where.date.gte),
        ).map((a) => ({ ...a }))
      },
    },
    invoice: {
      async findFirst({ where }: { where: { id: string; projectId?: string; status?: string; supplierId?: string } }) {
        const i = INVOICES.find(
          (x) =>
            x.id === where.id &&
            (where.projectId === undefined || x.projectId === where.projectId) &&
            (where.status === undefined || x.status === where.status) &&
            (where.supplierId === undefined || x.supplierId === where.supplierId),
        )
        return i ? { ...i, lines: [...i.lines], supplier: i.supplier, order: i.order } : null
      },
      async findMany({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Array<Record<string, string>>; take?: number }) {
        state.invoiceCalls.push({ where, orderBy, take })
        const boundary = where?.OR as Array<Record<string, unknown>> | undefined
        const rows = INVOICES.filter((i) => {
          if (where?.projectId && i.projectId !== where.projectId) return false
          if (where?.status && i.status !== where.status) return false
          if (where?.supplierId && i.supplierId !== where.supplierId) return false
          if (!inCreatedAtBoundary(i, boundary, 'desc')) return false
          return true
        })
          .map((i) => ({ ...i, lines: [...i.lines] }))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        void orderBy
        return take !== undefined ? rows.slice(0, take) : rows
      },
    },
    landParcel: {
      async findFirst({ where }: { where: { id: string; projectId?: string; status?: string } }) {
        const p = PARCELS.find(
          (x) =>
            x.id === where.id &&
            (where.projectId === undefined || x.projectId === where.projectId) &&
            (where.status === undefined || x.status === where.status),
        )
        return p ? { ...p, documents: [...p.documents], searches: [...p.searches], assignments: [...p.assignments] } : null
      },
      async findMany({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: Array<Record<string, string>>; take?: number }) {
        state.parcelCalls.push({ where, orderBy, take })
        const boundary = where?.OR as Array<Record<string, unknown>> | undefined
        const rows = PARCELS.filter((p) => {
          if (where?.projectId && p.projectId !== where.projectId) return false
          if (where?.status && p.status !== where.status) return false
          if (!inCreatedAtBoundary(p, boundary, 'asc')) return false
          return true
        }).map((p) => ({ ...p, documents: [...p.documents], searches: [...p.searches], assignments: [...p.assignments] }))
        void orderBy // the fixture is already in (createdAt ASC, id ASC) order
        return take !== undefined ? rows.slice(0, take) : rows
      },
    },
    alert: {
      async findMany({ where }: { where?: { projectId?: string } }) {
        return ALERTS.filter((a) => !where?.projectId || a.projectId === where.projectId).map((a) => ({ ...a }))
      },
    },
  }
  return { db }
})

// Full fake guard (the flags-gating idiom — mirrors guard.ts 1:1, INCLUDING
// the W5-3 sessionSupplierId pin).
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
    sessionSupplierId: (session: { user: { role: string; supplierId?: string | null } }) => {
      if (session.user.role !== 'supplier') return null
      const id = session.user.supplierId
      return typeof id === 'string' && id.trim() ? id.trim() : null
    },
    FINANCE_ROLES,
    PAYMENT_ROLES,
    KNOWN_ROLES,
    OWNER_ROLES,
  }
})

// THE #154 SPY — the payload must never be a v1 building block. The mock
// replaces the module wholesale; if any route regressed to importing more of
// it, the import itself would surface undefined exports.
const mjengo = vi.hoisted(() => ({ getProjectPayload: vi.fn(), getProjectsList: vi.fn() }))
vi.mock('@/backend/lib/mjengo', () => mjengo)

// The supply module's bounded directory read (the suppliers route's source).
const supplyRepo = vi.hoisted(() => ({ loadSupplierDirectoryBounded: vi.fn() }))
vi.mock('@/backend/modules/supply/repository', () => supplyRepo)

// The intel module's public read (the intel route's source).
const intelRepo = vi.hoisted(() => ({ loadIntelSlice: vi.fn() }))
vi.mock('@/backend/modules/intel/repository', () => intelRepo)

import { getProjectPayload } from '@/backend/lib/mjengo'
import { GET as projectTasksGet } from '@/app/api/v1/projects/[id]/tasks/route'
import { GET as projectMilestonesGet } from '@/app/api/v1/projects/[id]/milestones/route'
import { GET as projectWorkersGet } from '@/app/api/v1/projects/[id]/workers/route'
import { GET as projectSuppliersGet } from '@/app/api/v1/projects/[id]/suppliers/route'
import { GET as projectParcelsGet } from '@/app/api/v1/projects/[id]/parcels/route'
import { GET as projectInvoicesGet } from '@/app/api/v1/projects/[id]/invoices/route'
import { GET as projectIntelGet } from '@/app/api/v1/projects/[id]/intel/route'
import { db } from '@/backend/lib/db'

/** The db stub's recorded state (the #154 query-shape pins). */
function state() {
  return (db as unknown as {
    __state: {
      taskCalls: Array<Record<string, unknown>>
      milestoneCalls: Array<Record<string, unknown>>
      workerCalls: Array<Record<string, unknown>>
      attendanceCalls: Array<Record<string, unknown>>
      invoiceCalls: Array<Record<string, unknown>>
      parcelCalls: Array<Record<string, unknown>>
      projectResolveCalls: Array<Record<string, unknown>>
    }
  }).__state
}

function sessionFor(role: string, projectId: string | null = null, supplierId: string | null = null) {
  h.session = { user: { id: `u-${role}`, email: `${role}.${Math.random().toString(36).slice(2)}@test.dev`, name: role, role, projectId, supplierId } }
}

function getReq(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: { 'content-type': 'application/json' } })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  intelRepo.loadIntelSlice.mockResolvedValue({
    risk: null, score: null, digests: [], pricePoints: [], priceTrends: [],
    suggestions: [], reliability: [], health: null,
    flags: { ai_progress: true, ai_voice: true, wallet: true, marketplace: true, land_verification: true },
  })
  supplyRepo.loadSupplierDirectoryBounded.mockResolvedValue({
    suppliers: [
      { id: 'sup-1', businessName: 'Nairobi Hardware Centre', county: 'Nairobi', town: 'Industrial Area', phone: null, email: null, verificationState: 4, reliabilityScore: 78, responseHours: 12, deliveryFeeBase: 3500, minimumOrder: 5000, freeDeliveryOver: 200_000, deliveryZones: 'Nairobi', operatingHours: null, catalogItems: [], createdAt: d('2026-01-05T09:00:00Z'), updatedAt: d('2026-02-20T09:00:00Z') },
      { id: 'sup-2', businessName: 'Kiambu Road Building Supplies', county: 'Kiambu', town: 'Kiambu', phone: null, email: null, verificationState: 3, reliabilityScore: 65, responseHours: 24, deliveryFeeBase: 1500, minimumOrder: 0, freeDeliveryOver: null, deliveryZones: 'Kiambu', operatingHours: null, catalogItems: [], createdAt: d('2026-01-12T09:00:00Z'), updatedAt: d('2026-02-18T09:00:00Z') },
    ],
    savedSupplierIds: ['sup-2'],
    ordersBySupplier: new Map([['sup-1', { count: 2, total: 101_750 }]]),
  })
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
})

// ---------------------------------------------------------------- tasks

describe('GET /api/v1/projects/:id/tasks — the direct task read', () => {
  const req = (qs = '') => getReq(`http://localhost/api/v1/projects/p-1/tasks${qs}`)
  const ctx = () => ({ params: Promise.resolve({ id: 'p-1' }) })

  it('page 2 pushes the cursor boundary + take into ONE findMany (never the payload)', async () => {
    sessionFor('contractor')
    const page1 = await bodyOf(await projectTasksGet(req('?limit=2'), ctx()))
    expect((page1.data as Array<{ id: string }>).map((t) => t.id)).toEqual(['tsk-1', 'tsk-2'])
    expect(page1.hasMore).toBe(true)
    const page2 = await bodyOf(await projectTasksGet(req(`?limit=2&cursor=${page1.nextCursor}`), ctx()))
    expect((page2.data as Array<{ id: string }>).map((t) => t.id)).toEqual(['tsk-3'])
    expect(page2.hasMore).toBe(false)

    const calls = state().taskCalls
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.take).toBe(3) // limit 2 + the hasMore probe row
      expect(c.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
      expect(c.where).toMatchObject({ phase: { projectId: 'p-1' } })
    }
    expect(calls[0].where).not.toHaveProperty('OR') // first page: no boundary
    // Page 2's boundary = (createdAt, id) of tsk-2, page 1's last item.
    expect(calls[1].where).toMatchObject({
      OR: [
        { createdAt: { gt: d('2026-01-12T10:00:00Z') } },
        { createdAt: d('2026-01-12T10:00:00Z'), id: { gt: 'tsk-2' } },
      ],
    })
    // The resolve step is the direct project read — one per request (both
    // pages of the walk resolved the project before querying).
    expect(state().projectResolveCalls).toEqual([{ where: { id: 'p-1' } }, { where: { id: 'p-1' } }])
  })

  it('?status= rides the where; a filtered-out cursor → the pageOfKind 400', async () => {
    sessionFor('contractor')
    const done = await bodyOf(await projectTasksGet(req('?status=done'), ctx()))
    expect((done.data as Array<{ id: string }>).map((t) => t.id)).toEqual(['tsk-1'])
    expect(state().taskCalls.at(-1)?.where).toMatchObject({ phase: { projectId: 'p-1' }, status: 'done' })

    const stale = await projectTasksGet(req('?status=done&cursor=tsk-2'), ctx())
    expect(stale.status).toBe(400)
    expect(await bodyOf(stale)).toEqual({
      error: 'Unknown cursor — it must be the id of a task in this list',
      field: 'cursor',
    })
  })
})

// ---------------------------------------------------------------- milestones

describe('GET /api/v1/projects/:id/milestones — the direct milestone read', () => {
  const req = (qs = '') => getReq(`http://localhost/api/v1/projects/p-1/milestones${qs}`)
  const ctx = () => ({ params: Promise.resolve({ id: 'p-1' }) })

  it('one findMany with the boundary + take pushed in; the phase names ride ONE bounded phases read', async () => {
    sessionFor('contractor')
    const page1 = await bodyOf(await projectMilestonesGet(req('?limit=2'), ctx()))
    expect((page1.data as Array<{ id: string }>).map((m) => m.id)).toEqual(['mst-1', 'mst-2'])
    const page2 = await bodyOf(await projectMilestonesGet(req(`?limit=2&cursor=${page1.nextCursor}`), ctx()))
    expect((page2.data as Array<{ id: string }>).map((m) => m.id)).toEqual(['mst-3'])
    // The ladder summaries join the phase name.
    expect((page1.data as Array<{ phaseName: string | null }>)[0].phaseName).toBe('Site Prep & Foundation')
    expect((page1.data as Array<{ phaseName: string | null }>)[1].phaseName).toBeNull()

    const calls = state().milestoneCalls
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.take).toBe(3)
      expect(c.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
      expect(c.where).toMatchObject({ projectId: 'p-1' })
    }
    expect(calls[1].where).toMatchObject({
      OR: [
        { createdAt: { gt: d('2026-02-05T09:00:00Z') } },
        { createdAt: d('2026-02-05T09:00:00Z'), id: { gt: 'mst-2' } },
      ],
    })
  })
})

// ---------------------------------------------------------------- workers

describe('GET /api/v1/projects/:id/workers — the direct roster read + the bounded rollup', () => {
  const req = (qs = '') => getReq(`http://localhost/api/v1/projects/p-1/workers${qs}`)
  const ctx = () => ({ params: Promise.resolve({ id: 'p-1' }) })

  it('page 2 carries the (name, id) boundary; the rollup reads ONE windowed attendance query per page', async () => {
    sessionFor('contractor')
    const page1 = await bodyOf(await projectWorkersGet(req('?limit=1'), ctx()))
    expect((page1.data as Array<{ id: string }>).map((w) => w.id)).toEqual(['wrk-1'])
    const page2 = await bodyOf(await projectWorkersGet(req(`?limit=1&cursor=${page1.nextCursor}`), ctx()))
    expect((page2.data as Array<{ id: string }>).map((w) => w.id)).toEqual(['wrk-2'])

    const calls = state().workerCalls
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.take).toBe(2) // limit 1 + the hasMore probe row
      expect(c.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }])
      expect(c.where).toMatchObject({ projectId: 'p-1' })
    }
    // Page 2's boundary = (name, id) of wrk-1 — Worker has no createdAt.
    expect(calls[1].where).toMatchObject({
      OR: [{ name: { gt: 'Amina Njeri' } }, { name: 'Amina Njeri', id: { gt: 'wrk-1' } }],
    })

    // The rollup: one attendance query per page, scoped to the PAGE's worker
    // ids inside the 8-day window (date >= today-7) — never the whole
    // history, never other pages' workers.
    const att = state().attendanceCalls
    expect(att).toHaveLength(2)
    expect(att[0].where).toMatchObject({ projectId: 'p-1', workerId: { in: ['wrk-1'] } })
    expect(att[1].where).toMatchObject({ projectId: 'p-1', workerId: { in: ['wrk-2'] } })
    for (const c of att) {
      const gte = (c.where as { date?: { gte?: string } }).date?.gte
      expect(gte).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(new Date(gte!).getTime()).toBeLessThanOrEqual(Date.now() - 6 * 86_400_000)
    }
  })

  it('?active=false rides the where; a filtered-out cursor → the pageOfKind 400', async () => {
    sessionFor('contractor')
    const inactive = await bodyOf(await projectWorkersGet(req('?active=false'), ctx()))
    expect((inactive.data as Array<{ id: string }>).map((w) => w.id)).toEqual(['wrk-2'])
    expect(state().workerCalls.at(-1)?.where).toMatchObject({ projectId: 'p-1', active: false })

    const stale = await projectWorkersGet(req('?active=false&cursor=wrk-1'), ctx())
    expect(stale.status).toBe(400)
    expect(await bodyOf(stale)).toEqual({
      error: 'Unknown cursor — it must be the id of a worker in this list',
      field: 'cursor',
    })
  })
})

// ---------------------------------------------------------------- parcels

describe('GET /api/v1/projects/:id/parcels — the direct parcel read', () => {
  const req = (qs = '') => getReq(`http://localhost/api/v1/projects/p-1/parcels${qs}`)
  const ctx = () => ({ params: Promise.resolve({ id: 'p-1' }) })

  it('page 2 pushes the boundary + take into ONE findMany with the summary joins', async () => {
    sessionFor('contractor')
    const page1 = await bodyOf(await projectParcelsGet(req('?limit=2'), ctx()))
    expect((page1.data as Array<{ id: string }>).map((p) => p.id)).toEqual(['par-1', 'par-2'])
    const page2 = await bodyOf(await projectParcelsGet(req(`?limit=2&cursor=${page1.nextCursor}`), ctx()))
    expect((page2.data as Array<{ id: string }>).map((p) => p.id)).toEqual(['par-3'])

    const calls = state().parcelCalls
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.take).toBe(3)
      expect(c.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
      expect(c.where).toMatchObject({ projectId: 'p-1' })
    }
    expect(calls[1].where).toMatchObject({
      OR: [
        { createdAt: { gt: d('2026-01-15T09:00:00Z') } },
        { createdAt: d('2026-01-15T09:00:00Z'), id: { gt: 'par-2' } },
      ],
    })
    // The summary joins ride the same query (counts + latest search +
    // assignments with the professional join) — no second read.
    const first = (page1.data as Array<Record<string, unknown>>)[0]
    expect(first).toMatchObject({ documentCount: 2, searchCount: 1, assignmentCount: 1 })
    expect(first.latestSearch).toMatchObject({ id: 'srch-2', transcriptionMatch: 'consistent' })
  })

  it('?status= rides the where; a filtered-out cursor → the pageOfKind 400', async () => {
    sessionFor('contractor')
    const flagged = await bodyOf(await projectParcelsGet(req('?status=flagged'), ctx()))
    expect((flagged.data as Array<{ id: string }>).map((p) => p.id)).toEqual(['par-2'])
    expect(state().parcelCalls.at(-1)?.where).toMatchObject({ projectId: 'p-1', status: 'flagged' })

    const stale = await projectParcelsGet(req('?status=flagged&cursor=par-1'), ctx())
    expect(stale.status).toBe(400)
    expect(await bodyOf(stale)).toEqual({
      error: 'Unknown cursor — it must be the id of a parcel in this list',
      field: 'cursor',
    })
  })
})

// ---------------------------------------------------------------- invoices

describe('GET /api/v1/projects/:id/invoices — the direct invoice read', () => {
  const req = (qs = '') => getReq(`http://localhost/api/v1/projects/p-1/invoices${qs}`)
  const ctx = () => ({ params: Promise.resolve({ id: 'p-1' }) })

  it('page 2 pushes the (createdAt DESC, id DESC) boundary + take; KSh conversion at the boundary', async () => {
    sessionFor('contractor')
    const page1 = await bodyOf(await projectInvoicesGet(req('?limit=2'), ctx()))
    expect((page1.data as Array<{ id: string }>).map((i) => i.id)).toEqual(['inv-3', 'inv-2'])
    const page2 = await bodyOf(await projectInvoicesGet(req(`?limit=2&cursor=${page1.nextCursor}`), ctx()))
    expect((page2.data as Array<{ id: string }>).map((i) => i.id)).toEqual(['inv-1'])

    const calls = state().invoiceCalls
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.take).toBe(3)
      expect(c.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
      expect(c.where).toMatchObject({ projectId: 'p-1' })
    }
    expect(calls[1].where).toMatchObject({
      OR: [
        { createdAt: { lt: d('2026-02-07T11:00:00Z') } },
        { createdAt: d('2026-02-07T11:00:00Z'), id: { lt: 'inv-2' } },
      ],
    })
    // Cents → KSh exactly once, at the row boundary (bigint fixture rows).
    const first = (page1.data as Array<Record<string, unknown>>)[0]
    expect(first).toMatchObject({ subtotal: 1360, tax: 0, total: 1385, lineCount: 0, supplierName: null })
  })

  it('the supplier row pin rides the where (their invoices only, fail closed)', async () => {
    sessionFor('supplier', null, 'sup-1')
    const body = await bodyOf(await projectInvoicesGet(req(), ctx()))
    expect((body.data as Array<{ id: string }>).map((i) => i.id)).toEqual(['inv-3', 'inv-1'])
    expect(state().invoiceCalls.at(-1)?.where).toMatchObject({ projectId: 'p-1', supplierId: 'sup-1' })

    sessionFor('supplier', null, null)
    const denied = await projectInvoicesGet(req(), ctx())
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Supplier account has no supplier linked' })
  })
})

// ---------------------------------------------------------------- suppliers

describe('GET /api/v1/projects/:id/suppliers — the bounded directory read', () => {
  const req = (qs = '') => getReq(`http://localhost/api/v1/projects/p-1/suppliers${qs}`)
  const ctx = () => ({ params: Promise.resolve({ id: 'p-1' }) })

  it('reads loadSupplierDirectoryBounded once (never the payload, never the full supply slice)', async () => {
    sessionFor('contractor')
    const body = await bodyOf(await projectSuppliersGet(req(), ctx()))
    expect((body.data as Array<{ id: string }>).map((s) => s.id)).toEqual(['sup-1', 'sup-2'])
    expect(supplyRepo.loadSupplierDirectoryBounded).toHaveBeenCalledTimes(1)
    expect(supplyRepo.loadSupplierDirectoryBounded).toHaveBeenCalledWith('p-1')
    // The relationship marks are the repository's aggregates.
    const first = (body.data as Array<Record<string, unknown>>)[0]
    expect(first).toMatchObject({ savedByProject: false, orderCount: 2, orderTotal: 101_750 })
    expect((body.data as Array<Record<string, unknown>>)[1]).toMatchObject({ savedByProject: true, orderCount: 0 })
  })
})

// ---------------------------------------------------------------- intel

describe('GET /api/v1/projects/:id/intel — the module read', () => {
  const req = () => getReq('http://localhost/api/v1/projects/p-1/intel')
  const ctx = () => ({ params: Promise.resolve({ id: 'p-1' }) })

  it('reads loadIntelSlice + the alert ledger directly (never the payload)', async () => {
    sessionFor('contractor')
    const body = await bodyOf(await projectIntelGet(req(), ctx()))
    expect(intelRepo.loadIntelSlice).toHaveBeenCalledTimes(1)
    expect(intelRepo.loadIntelSlice).toHaveBeenCalledWith('p-1')
    // The never-computed state answers honestly (score/risk/health/digest
    // null — pinned field-for-field by v1-intel-budget.test.ts).
    expect(body.data).toMatchObject({
      projectId: 'p-1',
      score: null, risk: null, health: null, digest: null,
      anomalies: { total: 2, unacknowledged: 1, warning: 1, info: 1 },
    })
  })
})

// ---------------------------------------------------------------- the payload ban

describe('the payload is never a v1 building block (issue #154)', () => {
  it('getProjectPayload was not called by ANY route exercised in this suite', () => {
    expect(getProjectPayload).not.toHaveBeenCalled()
  })

  it('every route above resolved its project with db.project.findUnique (the attendance step)', () => {
    // 2+2+2+2+2+2+1 = the tasks/milestones/workers/parcels/invoices walks
    // plus the suppliers/intel reads — each page resolved the project first.
    expect(state().projectResolveCalls.length).toBeGreaterThanOrEqual(13)
    for (const c of state().projectResolveCalls) {
      expect(c.where).toEqual({ id: 'p-1' })
    }
  })
})
