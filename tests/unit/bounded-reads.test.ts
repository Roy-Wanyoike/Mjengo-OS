/**
 * Issue #155 (audit API-4) — DB-level bounds on every list read.
 *
 * The four unbounded reads the issue names, pinned at the db-stub seam (the
 * wallet-role-gates BE-8 / ledger-sql-sum query-shape idiom — the stub is a
 * faithful Prisma twin and the REAL service/route code runs against it):
 *
 *   · getProjectsList — the project roster scan is take-capped at 500
 *     (PROJECTS_LIST_TAKE), keyset-paginated on (createdAt ASC, id ASC) with
 *     the cursor row's boundary pushed INTO the findMany, and the client /
 *     membership id-scope pushed down too; over-cap seed → the read stops at
 *     the cap; a cursor page never re-reads page 1 rows at the DB level.
 *   · GET /api/projects — DB-level pagination contract: default first page
 *     byte-identical (projects + the NEW additive nextCursor/hasMore),
 *     ?limit (1-500, default 500) + ?cursor walk the portfolio with no
 *     overlap; ill-typed limits + unknown/out-of-scope cursors → honest 400s;
 *     the client pin / supplier empty-roster / SEC-6 membership scope all
 *     still hold (and ride the query's id scope).
 *   · getProjectPayload — milestones 200 / variations 60 / zones 120 /
 *     photoComments 120 explicit takes (query-shape pins + over-cap seeds →
 *     the payload lists stop at the cap).
 *   · loadSupplyOrdersBounded — the v1 LIST-surface read: ONE purchaseOrder
 *     findMany (no N+1) with take 200 and the exact includes the order /
 *     delivery DTOs need; over-cap seed → 200; the full loadSupplySlice
 *     (detail surfaces) stays uncapped and maps to the IDENTICAL orders DTO.
 *
 * Mocks: '@/backend/lib/db' (faithful findMany twins with arg recorders),
 * '@/backend/lib/guard' (full fake — session control), and the eight payload
 * slice loaders (importOriginal spreads — only the loaders are wrapped, and
 * the supply one delegates to the REAL implementation by default so the
 * repository half of this suite exercises real code). getProjectsList,
 * getProjectPayload, the /api/projects GET route and the supply repository
 * stay REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/backend/lib/db'
import { getProjectPayload, getProjectsList, PROJECTS_LIST_TAKE } from '@/backend/lib/mjengo'
import {
  loadSupplyOrdersBounded,
  loadSupplySlice,
  SUPPLY_ORDERS_LIST_TAKE,
} from '@/backend/modules/supply/repository'
import type { SupplySlice } from '@/backend/modules/supply/types'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string; role: string; projectId: string | null; supplierId: string | null }
  },
}))

// ---------------------------------------------------------------- fixtures

const d = (iso: string) => new Date(iso)

type Row = Record<string, unknown>

/** A complete Project row (cents BigInt, Dates) at a given createdAt. */
const project = (i: number, createdAt: string, name = `Project ${i}`): Row => ({
  id: `p-${String(i).padStart(3, '0')}`,
  name,
  client: `Client ${i}`,
  clientType: 'diaspora',
  location: 'Karen',
  status: 'active',
  budget: 200_000_000n, // KSh 2,000,000
  shareToken: `tok-${i}`,
  startDate: d('2026-01-05T09:00:00Z'),
  targetDate: d('2026-05-01T09:00:00Z'),
  createdAt: d(createdAt),
})

/** A raw PurchaseOrder row (cents BigInt) with the repository's includes. */
const order = (i: number, createdAt: string, projectId = 'p-001'): Row => ({
  id: `po-${String(i).padStart(3, '0')}`,
  orderCode: `PO-2026-${String(i).padStart(6, '0')}`,
  projectId,
  requestId: i % 2 === 0 ? `mr-${i}` : null,
  supplierId: `sup-${(i % 3) + 1}`,
  subtotal: 100_000n + BigInt(i), // cents
  deliveryFee: 500n,
  total: 100_500n + BigInt(i),
  status: i % 2 === 0 ? 'sent' : 'confirmed',
  paymentSource: 'client',
  createdByRole: 'contractor',
  note: null,
  createdAt: d(createdAt),
  updatedAt: d(createdAt),
  // the repository's include shape
  lines: [
    {
      id: `pol-${i}`, orderId: `po-${String(i).padStart(3, '0')}`, name: 'Cement 50kg', unit: 'bag',
      qty: 200, unitPrice: 750n, lineTotal: 150_000n, createdAt: d(createdAt), updatedAt: d(createdAt),
    },
  ],
  supplier: { id: `sup-${(i % 3) + 1}`, businessName: `Supplier ${(i % 3) + 1}`, deliveryFeeBase: 500n, freeDeliveryOver: null, minimumOrder: 100n },
  request: i % 2 === 0 ? { id: `mr-${i}`, requestCode: `MR-2026-${String(i).padStart(6, '0')}` } : null,
  deliveries: [
    {
      id: `dlv-${String(i).padStart(3, '0')}`, orderId: `po-${String(i).padStart(3, '0')}`, status: 'received',
      dispatchedAt: d(createdAt), receivedAt: d(createdAt), receivedBy: 'Juma', note: null,
      driverName: 'Otieno', driverPhone: null, vehicleReg: 'KDA 123X',
      etaAt: null, departedAt: null, arrivedAt: null, gpsLat: null, gpsLng: null,
      photoCount: 0, photoUrls: '[]', createdAt: d(createdAt),
      lines: [], photos: [],
    },
  ],
})

// ---------------------------------------------------------------- db stub

vi.mock('@/backend/lib/db', () => {
  const state = {
    projects: [] as Row[],
    memberships: [] as Row[],
    milestones: [] as Row[],
    variations: [] as Row[],
    zones: [] as Row[],
    photoComments: [] as Row[],
    purchaseOrders: [] as Row[],
    /** Arg recorders — the #155 query-shape pins. */
    calls: {
      projectFindMany: [] as Row[],
      projectFindUnique: [] as Row[],
      milestoneFindMany: [] as Row[],
      variationFindMany: [] as Row[],
      zoneFindMany: [] as Row[],
      photoCommentFindMany: [] as Row[],
      purchaseOrderFindMany: [] as Row[],
    },
    reset() {
      state.projects = []
      state.memberships = []
      state.milestones = []
      state.variations = []
      state.zones = []
      state.photoComments = []
      state.purchaseOrders = []
      state.calls = {
        projectFindMany: [],
        projectFindUnique: [],
        milestoneFindMany: [],
        variationFindMany: [],
        zoneFindMany: [],
        photoCommentFindMany: [],
        purchaseOrderFindMany: [],
      }
    },
  }
  state.reset()

  /** Faithful keyset boundary for the ASC (createdAt, id) roster order. */
  const ascBoundary = (row: Row, or: Row[]) =>
    or.some((cond) => {
      const c = cond.createdAt as unknown
      if (c instanceof Date) {
        const id = cond.id as { gt: string }
        return row.createdAt.getTime() === c.getTime() && (row.id as string) > id.gt
      }
      const gt = (c as { gt: Date }).gt
      return row.createdAt.getTime() > gt.getTime()
    })

  /** Faithful keyset boundary for a DESC (createdAt, id) order. */
  const descBoundary = (row: Row, or: Row[]) =>
    or.some((cond) => {
      const c = cond.createdAt as unknown
      if (c instanceof Date) {
        const id = cond.id as { lt: string }
        return row.createdAt.getTime() === c.getTime() && (row.id as string) < id.lt
      }
      const lt = (c as { lt: Date }).lt
      return row.createdAt.getTime() < lt.getTime()
    })

  const byAsc = (a: Row, b: Row) =>
    (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime() ||
    ((a.id as string) < (b.id as string) ? -1 : (a.id as string) > (b.id as string) ? 1 : 0)
  const byDesc = (a: Row, b: Row) => -byAsc(a, b)

  const empty = async () => []

  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: { id: string } }) {
        state.calls.projectFindUnique.push({ ...where })
        const row = state.projects.find((p) => p.id === where.id)
        return row ? { ...row } : null
      },
      async findFirst() {
        const rows = [...state.projects].sort(byAsc)
        return rows.length ? { ...rows[0] } : null
      },
      // Faithful twin: id-IN scope, keyset boundary OR, (createdAt ASC,
      // id ASC) order, take — everything getProjectsList pushes down.
      async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row[]; take?: number } = {}) {
        state.calls.projectFindMany.push({ where, orderBy, take })
        let rows = state.projects.filter((p) => {
          const inIds = (where?.id as { in?: string[] } | undefined)?.in
          if (inIds !== undefined && !inIds.includes(p.id as string)) return false
          if (where?.OR && !ascBoundary(p, where.OR as Row[])) return false
          return true
        })
        rows = rows.sort(byAsc)
        return (take !== undefined ? rows.slice(0, take) : rows).map((p) => ({ ...p }))
      },
    },
    projectMembership: {
      async findMany({ where }: { where?: { userId?: string } }) {
        return state.memberships
          .filter((m) => !where?.userId || m.userId === where.userId)
          .map((m) => ({ ...m }))
      },
    },
    phase: { findMany: empty },
    transaction: { findMany: empty },
    worker: { findMany: empty },
    alert: { findMany: empty },
    sitePhoto: { findMany: empty },
    material: { findMany: empty },
    delivery: { findMany: empty },
    consumption: { findMany: empty },
    recap: { findMany: empty },
    escrowWallet: { findUnique: async () => null },
    notification: { findMany: empty },
    auditEvent: { findMany: empty },
    milestone: {
      async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row[]; take?: number } = {}) {
        state.calls.milestoneFindMany.push({ where, orderBy, take })
        const rows = state.milestones
          .filter((m) => !where?.projectId || m.projectId === where.projectId)
          .sort(byAsc)
        return (take !== undefined ? rows.slice(0, take) : rows).map((m) => ({ ...m }))
      },
    },
    variationOrder: {
      async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row[]; take?: number } = {}) {
        state.calls.variationFindMany.push({ where, orderBy, take })
        const rows = state.variations
          .filter((v) => !where?.projectId || v.projectId === where.projectId)
          .sort(byDesc)
        return (take !== undefined ? rows.slice(0, take) : rows).map((v) => ({ ...v }))
      },
    },
    siteZone: {
      async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row[]; take?: number } = {}) {
        state.calls.zoneFindMany.push({ where, orderBy, take })
        const rows = state.zones.filter((z) => !where?.projectId || z.projectId === where.projectId).sort(byAsc)
        return (take !== undefined ? rows.slice(0, take) : rows).map((z) => ({ ...z }))
      },
    },
    photoComment: {
      async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row[]; take?: number } = {}) {
        state.calls.photoCommentFindMany.push({ where, orderBy, take })
        const rows = state.photoComments
          .filter((c) => !where?.projectId || c.projectId === where.projectId)
          .sort(byDesc)
        return (take !== undefined ? rows.slice(0, take) : rows).map((c) => ({ ...c }))
      },
    },
    purchaseOrder: {
      // Faithful twin: projectId scope, (createdAt DESC) order, take — the
      // include shape is recorded verbatim (the repository maps it).
      async findMany({ where, orderBy, take, include }: { where?: Row; orderBy?: Row[]; take?: number; include?: Row } = {}) {
        state.calls.purchaseOrderFindMany.push({ where, orderBy, take, include })
        const rows = state.purchaseOrders
          .filter((o) => !where?.projectId || o.projectId === where.projectId)
          .sort(byDesc)
        return (take !== undefined ? rows.slice(0, take) : rows).map((o) => ({ ...o }))
      },
    },
    supplier: { findMany: empty },
    materialRequest: { findMany: empty },
    approvalRule: { findMany: empty },
    approval: { findMany: empty },
    quote: { findMany: empty },
    savedSupplier: { findMany: async () => [] },
  }
  return { db }
})

// ---------------------------------------------------------------- guard fake

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

// ------------------------------------------------- payload slice-loader mocks
//
// importOriginal spreads keep every other export real; only the loaders are
// wrapped. The supply loader DELEGATES to the real implementation by default
// (captured for restore) so the repository half of this suite runs real
// code; the payload describe swaps it for a trivial slice.

const supplyActual = vi.hoisted(() => ({
  loadSupplySlice: (_projectId: string) => Promise.resolve({} as SupplySlice),
}))

vi.mock('@/backend/modules/supply/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/modules/supply/repository')>()
  supplyActual.loadSupplySlice = actual.loadSupplySlice
  return { ...actual, loadSupplySlice: vi.fn(actual.loadSupplySlice) }
})
vi.mock('@/backend/modules/land/repository', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadLandSlice: vi.fn(async () => ({ parcels: [] })),
}))
vi.mock('@/backend/modules/professionals/repository', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadProfessionalsSlice: vi.fn(async () => ({ professionals: [], assignments: [] })),
}))
vi.mock('@/backend/modules/invoices/repository', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadInvoicesSlice: vi.fn(async () => ({ invoices: [], transactions: [], escrow: null, milestones: [] })),
}))
vi.mock('@/backend/modules/intel/repository', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadIntelSlice: vi.fn(async () => ({ prices: [], suggestions: [], reliability: [], jobs: [] })),
}))
vi.mock('@/backend/modules/inventory/repository', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadInventorySlice: vi.fn(async () => ({ materials: [], stock: [] })),
  loadBoqSlice: vi.fn(async () => ({ rows: [] })),
}))
vi.mock('@/backend/modules/wallet/repository', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadFinanceSlice: vi.fn(async () => ({ paymentRequests: [], transactions: [], accounts: [] })),
}))
vi.mock('@/backend/modules/drawpack/service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadDrawPacks: vi.fn(async () => []),
}))

import { GET as projectsGet } from '@/app/api/projects/route'
import { loadSupplySlice as mockedLoadSupplySlice } from '@/backend/modules/supply/repository'

/** The db stub's recorded state. */
function state() {
  return (db as unknown as {
    __state: {
      projects: Row[]
      memberships: Row[]
      milestones: Row[]
      variations: Row[]
      zones: Row[]
      photoComments: Row[]
      purchaseOrders: Row[]
      calls: Record<string, Row[]>
      reset: () => void
    }
  }).__state
}

function sessionFor(role: string, opts: { projectId?: string | null; supplierId?: string | null; id?: string } = {}) {
  const id = opts.id ?? `u-${role}-${Math.random().toString(36).slice(2, 8)}`
  h.session = {
    user: {
      id,
      email: `${id}@test.dev`,
      name: role,
      role,
      projectId: opts.projectId ?? null,
      supplierId: opts.supplierId ?? null,
    },
  }
}

function getReq(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: { 'content-type': 'application/json' } })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

beforeEach(() => {
  state().reset()
  h.session = null
  vi.clearAllMocks()
  // The supply loader mock delegates to the REAL repository by default (the
  // payload describe overrides this per-test and restores in afterEach).
  vi.mocked(mockedLoadSupplySlice).mockImplementation(supplyActual.loadSupplySlice)
})

afterEach(() => {
  vi.mocked(mockedLoadSupplySlice).mockImplementation(supplyActual.loadSupplySlice)
})

// ------------------------------------------------- getProjectsList (service)

describe('getProjectsList — DB-level roster bound + keyset (issue #155)', () => {
  it('the project scan itself is take-capped at 500 with the (createdAt ASC, id ASC) keyset order', async () => {
    state().projects = [project(1, '2026-01-01T00:00:00Z'), project(2, '2026-01-02T00:00:00Z')]
    const list = await getProjectsList()
    expect(list.map((p) => p.id)).toEqual(['p-001', 'p-002'])
    expect(state().calls.projectFindMany).toHaveLength(1)
    expect(state().calls.projectFindMany[0].take).toBe(PROJECTS_LIST_TAKE) // 500
    expect(state().calls.projectFindMany[0].orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
  })

  it('over-cap seed → the read stops at the cap (503 projects → 500, oldest-first)', async () => {
    state().projects = Array.from({ length: 503 }, (_, i) =>
      project(i, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()),
    )
    const list = await getProjectsList()
    expect(list).toHaveLength(500)
    expect(list[0].id).toBe('p-000')
    expect(list[499].id).toBe('p-499')
    expect(list.map((p) => p.id)).toEqual([...new Set(list.map((p) => p.id))]) // no dupes
  })

  it('a cursor page pushes the boundary INTO the findMany — page 1 rows are never re-read at the DB level', async () => {
    // Two projects share a createdAt — the id tiebreak must keep the order
    // exact across the keyset boundary.
    state().projects = [
      project(1, '2026-01-01T00:00:00Z'),
      project(2, '2026-01-02T00:00:00Z'),
      project(3, '2026-01-02T00:00:00Z'), // tie with p-002, id ASC puts p-003 after
      project(4, '2026-01-03T00:00:00Z'),
      project(5, '2026-01-04T00:00:00Z'),
    ]
    const page1 = await getProjectsList({ take: 3 })
    expect(page1.map((p) => p.id)).toEqual(['p-001', 'p-002', 'p-003'])
    expect(state().calls.projectFindMany[0].where).toEqual({}) // no boundary on page 1

    const page2 = await getProjectsList({ cursor: 'p-003', take: 3 })
    expect(page2.map((p) => p.id)).toEqual(['p-004', 'p-005'])
    // The page-2 query carries p-003's (createdAt, id) boundary — the rows
    // before it (page 1) are excluded by the WHERE, not by an in-memory
    // slice over a full reload.
    expect(state().calls.projectFindMany[1].where).toEqual({
      OR: [
        { createdAt: { gt: d('2026-01-02T00:00:00Z') } },
        { createdAt: d('2026-01-02T00:00:00Z'), id: { gt: 'p-003' } },
      ],
    })
  })

  it('unknown cursor → the single-line Unknown-cursor error; an out-of-scope cursor is refused the same way', async () => {
    state().projects = [project(1, '2026-01-01T00:00:00Z'), project(2, '2026-01-02T00:00:00Z')]
    await expect(getProjectsList({ cursor: 'p-nope' })).rejects.toThrow(
      'Unknown cursor — it must be the id of a project in this list',
    )
    // p-002 exists but sits outside the requested scope → same refusal.
    await expect(getProjectsList({ cursor: 'p-002', projectIds: ['p-001'] })).rejects.toThrow(
      'Unknown cursor — it must be the id of a project in this list',
    )
  })

  it('the id scope is pushed INTO the query (client pin / SEC-6 memberships never depend on window position)', async () => {
    state().projects = [
      project(1, '2026-01-01T00:00:00Z'),
      project(2, '2026-01-02T00:00:00Z'),
      project(3, '2026-01-03T00:00:00Z'),
    ]
    const scoped = await getProjectsList({ projectIds: ['p-003', 'p-001'] })
    expect(scoped.map((p) => p.id)).toEqual(['p-001', 'p-003']) // roster order, only the scoped ids
    expect(state().calls.projectFindMany[0].where).toEqual({ id: { in: ['p-003', 'p-001'] } })

    // Empty scope = the honest empty roster, enforced by the query itself.
    const none = await getProjectsList({ projectIds: [] })
    expect(none).toEqual([])
  })
})

// ---------------------------------------------------- GET /api/projects (route)

describe('GET /api/projects — DB-level pagination contract (issue #155)', () => {
  const req = (qs = '') => getReq(`http://localhost/api/projects${qs}`)

  beforeEach(() => {
    state().projects = Array.from({ length: 7 }, (_, i) =>
      project(i + 1, new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString()),
    )
  })

  it('default page: the full roster within the bound + the additive nextCursor/hasMore fields', async () => {
    sessionFor('contractor')
    const res = await projectsGet(req())
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect((body.projects as Row[]).map((p) => p.id)).toEqual(['p-001', 'p-002', 'p-003', 'p-004', 'p-005', 'p-006', 'p-007'])
    expect(body.nextCursor).toBeNull()
    expect(body.hasMore).toBe(false)
    // The route asks for limit + 1 rows (the hasMore probe) at the DB.
    expect(state().calls.projectFindMany.at(-1)?.take).toBe(PROJECTS_LIST_TAKE + 1)
  })

  it('limit=3 pages walk all 7 projects with no overlap; hasMore/nextCursor are exact on every page', async () => {
    sessionFor('contractor')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const body = await bodyOf(await projectsGet(req(`?limit=3${cursor ? `&cursor=${cursor}` : ''}`)))
      seen.push(...(body.projects as Row[]).map((p) => p.id))
      pages++
      expect(body.hasMore).toBe(pages < 3)
      cursor = (body.nextCursor as string | null) ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual(['p-001', 'p-002', 'p-003', 'p-004', 'p-005', 'p-006', 'p-007'])
    // DB-level: each page query carried take = limit + 1 and (from page 2)
    // the previous page's last-row boundary — page 1 rows were never re-read.
    const calls = state().calls.projectFindMany
    expect(calls).toHaveLength(3)
    for (const c of calls) expect(c.take).toBe(4)
    expect(calls[0].where).toEqual({})
    expect(calls[1].where).toMatchObject({
      OR: [
        { createdAt: { gt: d(new Date(Date.UTC(2026, 0, 3)).toISOString()) } },
        { createdAt: d(new Date(Date.UTC(2026, 0, 3)).toISOString()), id: { gt: 'p-003' } },
      ],
    })
  })

  it('ill-typed limits → honest 400s (0, 501, non-numeric)', async () => {
    sessionFor('contractor')
    for (const bad of ['0', '501', 'abc']) {
      const res = await projectsGet(req(`?limit=${bad}`))
      expect(res.status).toBe(400)
      expect(await bodyOf(res)).toEqual({ error: `limit must be an integer between 1 and ${PROJECTS_LIST_TAKE}` })
    }
    expect(state().calls.projectFindMany).toHaveLength(0) // no roster build for a bad limit
  })

  it('unknown cursor → 400 with the house message; no page read', async () => {
    sessionFor('contractor')
    const res = await projectsGet(req('?cursor=p-nope'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown cursor — it must be the id of a project in this list' })
    expect(state().calls.projectFindMany).toHaveLength(0)
  })

  it('client pin: exactly their project, via the query id scope (never window position)', async () => {
    sessionFor('client', { projectId: 'p-005' })
    const body = await bodyOf(await projectsGet(req()))
    expect((body.projects as Row[]).map((p) => p.id)).toEqual(['p-005'])
    expect(body.hasMore).toBe(false)
    expect(state().calls.projectFindMany[0].where).toEqual({ id: { in: ['p-005'] } })
  })

  it('supplier: the honest empty roster — the query itself matches nothing (id IN ())', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const body = await bodyOf(await projectsGet(req()))
    expect(body).toEqual({ ok: true, projects: [], nextCursor: null, hasMore: false })
    expect(state().calls.projectFindMany).toHaveLength(1)
    expect(state().calls.projectFindMany[0].where).toEqual({ id: { in: [] } })
  })

  it('SEC-6 membership scope: exactly the membership projects, pushed into the query', async () => {
    state().memberships = [
      { userId: 'u-sup', projectId: 'p-002', role: 'member', createdAt: d('2026-01-01T00:00:00Z') },
      { userId: 'u-sup', projectId: 'p-006', role: 'member', createdAt: d('2026-01-02T00:00:00Z') },
    ]
    sessionFor('supervisor', { id: 'u-sup' })
    const body = await bodyOf(await projectsGet(req()))
    expect((body.projects as Row[]).map((p) => p.id)).toEqual(['p-002', 'p-006'])
    expect(state().calls.projectFindMany[0].where).toEqual({ id: { in: ['p-002', 'p-006'] } })
  })
})

// ------------------------------------------------- getProjectPayload (bounds)

describe('getProjectPayload — the four list reads carry explicit takes (issue #155)', () => {
  beforeEach(() => {
    // The payload's supply slice is swapped for a trivial one (the supply
    // repository is pinned separately below); every other slice loader is
    // already a trivial mock.
    vi.mocked(mockedLoadSupplySlice).mockImplementation(async () => ({ orders: [] }) as never)
    state().projects = [project(1, '2026-01-01T00:00:00Z')]
    const base = { projectId: 'p-001', phaseId: null }
    state().milestones = Array.from({ length: 250 }, (_, i) => ({
      ...base,
      id: `ms-${String(i).padStart(3, '0')}`,
      name: `Milestone ${i}`,
      amount: 100_000n,
      status: 'locked',
      evidencePhotoIds: '[]',
      requestedAt: null, decidedAt: null, decidedBy: null, decisionNote: null, releasedAt: null,
      createdAt: d(new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()),
    }))
    state().variations = Array.from({ length: 70 }, (_, i) => ({
      ...base,
      id: `vo-${String(i).padStart(3, '0')}`,
      title: `Variation ${i}`,
      description: 'Plan change',
      budgetImpact: 50_000n,
      status: 'submitted',
      submittedBy: 'contractor', decidedBy: null, decisionNote: null, decidedAt: null,
      createdAt: d(new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()),
    }))
    state().zones = Array.from({ length: 130 }, (_, i) => ({
      id: `sz-${String(i).padStart(3, '0')}`,
      projectId: 'p-001',
      name: `Zone ${i}`,
      x: 1, y: 1, w: 2, h: 2,
      createdAt: d(new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()),
    }))
    state().photoComments = Array.from({ length: 130 }, (_, i) => ({
      id: `pc-${String(i).padStart(3, '0')}`,
      photoId: `ph-${i % 10}`,
      projectId: 'p-001',
      author: 'client', role: 'client',
      message: 'Question',
      resolved: false,
      createdAt: d(new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()),
    }))
  })

  it('over-cap seeds → every list stops at its cap (milestones 200 / variations 60 / zones 120 / photoComments 120)', async () => {
    const payload = await getProjectPayload('p-001')
    expect(payload).not.toBeNull()
    expect(payload!.milestones).toHaveLength(200) // 250 seeded
    expect(payload!.milestones[0].id).toBe('ms-000') // createdAt ASC — the ladder order
    expect(payload!.variations).toHaveLength(60) // 70 seeded
    expect(payload!.zones).toHaveLength(120) // 130 seeded
    expect(payload!.photoComments).toHaveLength(120) // 130 seeded
  })

  it('the query shapes pin the bounds: take 200 / 60 / 120 / 120 with the documented orders', async () => {
    await getProjectPayload('p-001')
    const solo = (calls: Row[], table: string) => {
      expect(calls, `${table} should be read exactly once`).toHaveLength(1)
      return calls[0]
    }
    expect(solo(state().calls.milestoneFindMany, 'milestones')).toMatchObject({
      where: { projectId: 'p-001' },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    expect(solo(state().calls.variationFindMany, 'variations')).toMatchObject({
      where: { projectId: 'p-001' },
      orderBy: { createdAt: 'desc' },
      take: 60,
    })
    expect(solo(state().calls.zoneFindMany, 'zones')).toMatchObject({
      where: { projectId: 'p-001' },
      orderBy: { createdAt: 'asc' },
      take: 120,
    })
    expect(solo(state().calls.photoCommentFindMany, 'photoComments')).toMatchObject({
      where: { projectId: 'p-001' },
      orderBy: { createdAt: 'desc' },
      take: 120,
    })
  })
})

// ------------------------------------------------- supply repository (bounds)

describe('loadSupplyOrdersBounded — the v1 LIST-surface read (issue #155)', () => {
  it('ONE purchaseOrder.findMany with take 200 and the exact order/delivery includes — no N+1', async () => {
    state().purchaseOrders = [order(1, '2026-02-01T00:00:00Z'), order(2, '2026-02-02T00:00:00Z')]
    const orders = await loadSupplyOrdersBounded('p-001')
    expect(orders).toHaveLength(2)
    expect(state().calls.purchaseOrderFindMany).toHaveLength(1)
    const call = state().calls.purchaseOrderFindMany[0]
    expect(call.take).toBe(SUPPLY_ORDERS_LIST_TAKE) // 200
    expect(call.where).toEqual({ projectId: 'p-001' })
    expect(call.orderBy).toEqual({ createdAt: 'desc' })
    expect(call.include).toEqual({
      lines: true,
      supplier: true,
      request: true,
      deliveries: {
        include: { lines: true, photos: { include: { attachment: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      },
    })
  })

  it('over-cap seed → the read stops at the cap (205 orders → 200, newest-first)', async () => {
    state().purchaseOrders = Array.from({ length: 205 }, (_, i) =>
      order(i, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()),
    )
    const orders = await loadSupplyOrdersBounded('p-001')
    expect(orders).toHaveLength(200)
    expect(orders[0].id).toBe('po-204') // createdAt DESC — the newest within the window
    expect(orders[199].id).toBe('po-005')
  })

  it('the DTO is the slice contract: KSh money, supplierName/requestCode joins, raw relations stripped', async () => {
    state().purchaseOrders = [order(2, '2026-02-02T00:00:00Z')]
    const [bounded] = await loadSupplyOrdersBounded('p-001')
    expect(bounded).toMatchObject({
      id: 'po-002',
      orderCode: 'PO-2026-000002',
      supplierName: 'Supplier 3',
      requestCode: 'MR-2026-000002',
      subtotal: 1000.02, // 100_002n cents → KSh
      deliveryFee: 5,
      total: 1005.02,
    })
    expect(bounded.supplierName).toBe('Supplier 3')
    expect(bounded.requestCode).toBe('MR-2026-000002')
    expect(bounded.lines[0]).toMatchObject({ unitPrice: 7.5, lineTotal: 1500 }) // cents → KSh
    expect(bounded.deliveries).toHaveLength(1)
    // issue #122: the raw BigInt-bearing relations never reach the DTO.
    expect(bounded).not.toHaveProperty('supplier')
    expect(bounded).not.toHaveProperty('request')
  })

  it('the FULL loadSupplySlice (detail surfaces) stays uncapped and maps to the IDENTICAL orders DTO', async () => {
    state().purchaseOrders = [order(1, '2026-02-01T00:00:00Z'), order(2, '2026-02-02T00:00:00Z')]
    const slice = await loadSupplySlice('p-001')
    expect(state().calls.purchaseOrderFindMany.at(-1)?.take).toBeUndefined() // the detail read is uncapped BY DESIGN
    const bounded = await loadSupplyOrdersBounded('p-001')
    expect(slice.orders).toEqual(bounded) // one shared query + mapping — no drift possible
  })
})
