/**
 * /api/v1 Phase D (task 7-b) — the SUPPLIERS + PARCELS read surfaces:
 * GET /api/v1/projects/:id/suppliers and GET /api/v1/projects/:id/parcels.
 *
 * Pinned invariants:
 *   · FEATURE FLAGS mirror the webapp exactly: suppliers is gated by
 *     `marketplace` (the v1 supply-family gate — OFF → 403 'Feature disabled
 *     by feature flag (marketplace)' for non-admins, admins bypass); parcels
 *     is gated by `land_verification` (the flag's enforcement map closes
 *     "the parcels section of the Land tab" — same uniform rule).
 *   · ROLE SCOPING: any signed-in role may read; a client-role session is
 *     pinned to its own project (foreign → 403 'Not permitted for this
 *     project'); unknown project → 404; anonymous → 401. W5-3: supplier
 *     sessions are not project readers — uniform 403 (their own catalog is
 *     the /api/supplier portal, never this buyer directory).
 *   · HONEST SCOPE (suppliers): Supplier rows are a GLOBAL directory — the
 *     project relationship rides per row (savedByProject, orderCount,
 *     orderTotal from THIS project's orders), never a silent filter.
 *   · HONEST LANGUAGE (parcels): "verified" is a record state produced by
 *     the ladder, NEVER a government certification claim; "flagged" is an
 *     anomaly state for human review, never an accusation.
 *   · KEYSET PAGINATION — deterministic (createdAt ASC, id ASC) total order;
 *     ?q= (suppliers) and ?status= (parcels) filter BEFORE pagination; a
 *     cursor outside the (filtered) list → 400 { field }.
 *   · The OpenAPI document carries the two new paths (27 /api/v1 total) with
 *     matching operationIds + tags + the SupplierCatalogSummary/ParcelSummary
 *     schemas.
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control), '@/backend/lib/db' (featureFlag rows — the flag gates) and
 * '@/backend/lib/mjengo' (getProjectPayload — the payload's supply + land
 * slices). route-kit, rate-limit, flags, respond/schemas and the routes stay
 * REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

const d = (iso: string) => new Date(iso)

// ---------------------------------------------------------------- fixtures (hoisted for the payload factory)

const CATALOG_NHC = [
  {
    id: 'cat-00000001', supplierId: 'sup-1', name: 'Cement 50kg (32.5N)', category: 'cement', brand: 'Bamburi',
    specification: '32.5N 50kg bag', unit: 'bag', unitPrice: 760, stockQty: 400, minOrderQty: 10,
    createdAt: d('2026-01-05T09:00:00Z'), updatedAt: d('2026-02-10T09:00:00Z'),
  },
  {
    id: 'cat-00000002', supplierId: 'sup-1', name: 'Ballast (screened)', category: 'ballast', brand: null,
    specification: '3/4 inch', unit: 'tonne', unitPrice: 1950, stockQty: 60, minOrderQty: 5,
    createdAt: d('2026-01-05T09:05:00Z'), updatedAt: d('2026-02-10T09:05:00Z'),
  },
  {
    id: 'cat-00000003', supplierId: 'sup-1', name: 'Delivery — Industrial Area to Kitengela', category: null,
    brand: null, specification: null, unit: 'trip', unitPrice: 3500, stockQty: 1, minOrderQty: 1,
    createdAt: d('2026-01-05T09:10:00Z'), updatedAt: d('2026-02-10T09:10:00Z'),
  },
]

/** Three suppliers of the global directory (createdAt ASC: sup-1, sup-2, sup-3). */
const SUPPLIERS = [
  {
    id: 'sup-1', businessName: 'Nairobi Hardware Centre', county: 'Nairobi', town: 'Industrial Area',
    lat: -1.3, lng: 36.8, phone: '+254711000001', email: 'sales@nairobihardware.example',
    warehouseLocation: 'Godown 12, Lunga Lunga Rd', deliveryZones: 'Nairobi,Kiambu,Machakos',
    deliveryFeeBase: 3500, freeDeliveryOver: 200_000, minimumOrder: 5000,
    verificationState: 4, reliabilityScore: 78, responseHours: 12, operatingHours: 'Mon-Sat 07:00-18:00',
    catalogItems: CATALOG_NHC, createdAt: d('2026-01-05T09:00:00Z'), updatedAt: d('2026-02-20T09:00:00Z'),
  },
  {
    id: 'sup-2', businessName: 'Kiambu Road Building Supplies', county: 'Kiambu', town: 'Kiambu',
    lat: null, lng: null, phone: null, email: null,
    warehouseLocation: null, deliveryZones: 'Kiambu', deliveryFeeBase: 1500, freeDeliveryOver: null,
    minimumOrder: 0, verificationState: 3, reliabilityScore: 65, responseHours: 24, operatingHours: null,
    catalogItems: [], createdAt: d('2026-01-12T09:00:00Z'), updatedAt: d('2026-02-18T09:00:00Z'),
  },
  {
    id: 'sup-3', businessName: 'Karen Timber & Hardware', county: 'Nairobi', town: 'Karen',
    lat: null, lng: null, phone: '+254733000003', email: null,
    warehouseLocation: null, deliveryZones: 'Nairobi', deliveryFeeBase: 2000, freeDeliveryOver: 100_000,
    minimumOrder: 2500, verificationState: 2, reliabilityScore: 50, responseHours: 48, operatingHours: 'Mon-Fri 08:00-17:00',
    catalogItems: [], createdAt: d('2026-01-20T09:00:00Z'), updatedAt: d('2026-02-22T09:00:00Z'),
  },
]

/** This project's purchase orders (the per-supplier relationship marks). */
const ORDERS = [
  { id: 'po-000009', supplierId: 'sup-1', orderCode: 'PO-2026-000009', total: 62_750 },
  { id: 'po-000010', supplierId: 'sup-1', orderCode: 'PO-2026-000010', total: 39_000 },
  { id: 'po-000012', supplierId: 'sup-3', orderCode: 'PO-2026-000012', total: 46_000 },
]

/** Three parcels of p-1 (createdAt ASC: par-1, par-2, par-3). */
const PARCELS = [
  {
    id: 'par-00000001', projectId: 'p-1', plotNumber: 'LR No. 2090/1234', county: 'Kiambu', town: 'Kitengela',
    lat: -1.44, lng: 36.98, approxArea: '0.25 ha', tenureType: 'freehold', status: 'verified',
    createdAt: d('2026-01-02T09:00:00Z'), updatedAt: d('2026-01-30T09:00:00Z'),
    documents: [
      { id: 'pdoc-1', kind: 'title_deed', createdAt: d('2026-01-03T09:00:00Z') },
      { id: 'pdoc-2', kind: 'search_cert', createdAt: d('2026-01-28T09:00:00Z') },
    ],
    searches: [
      {
        id: 'srch-2', searchRef: 'RS-2026-000118', status: 'reviewed', transcriptionMatch: 'consistent',
        requestedAt: d('2026-01-10T09:00:00Z'), receivedAt: d('2026-01-27T09:00:00Z'), reviewedAt: d('2026-01-30T09:00:00Z'),
        resultSummary: 'Registered proprietor matches the deed.', createdAt: d('2026-01-10T09:00:00Z'),
      },
      {
        id: 'srch-1', searchRef: 'RS-2026-000090', status: 'received', transcriptionMatch: 'pending',
        requestedAt: d('2026-01-04T09:00:00Z'), receivedAt: d('2026-01-06T09:00:00Z'), reviewedAt: null,
        resultSummary: null, createdAt: d('2026-01-04T09:00:00Z'),
      },
    ],
    assignments: [
      {
        id: 'asg-1', professionalName: 'Surveyor Kimani', professionalCategory: 'surveyor',
        role: 'surveyor', status: 'active', createdAt: d('2026-01-05T09:00:00Z'),
      },
    ],
  },
  {
    id: 'par-00000002', projectId: 'p-1', plotNumber: 'LR No. 2090/5678', county: 'Kiambu', town: null,
    lat: null, lng: null, approxArea: null, tenureType: 'leasehold', status: 'flagged',
    createdAt: d('2026-01-15T09:00:00Z'), updatedAt: d('2026-02-08T09:00:00Z'),
    documents: [],
    searches: [
      {
        id: 'srch-3', searchRef: 'RS-2026-000211', status: 'received', transcriptionMatch: 'mismatch',
        requestedAt: d('2026-02-01T09:00:00Z'), receivedAt: d('2026-02-07T09:00:00Z'), reviewedAt: null,
        resultSummary: 'Registry shows a different proprietor than the deed transcription.',
        createdAt: d('2026-02-01T09:00:00Z'),
      },
    ],
    assignments: [],
  },
  {
    id: 'par-00000003', projectId: 'p-1', plotNumber: 'LR No. 2090/9012', county: 'Machakos', town: 'Athi River',
    lat: null, lng: null, approxArea: '50x100 ft', tenureType: null, status: 'searching',
    createdAt: d('2026-02-10T09:00:00Z'), updatedAt: d('2026-02-10T09:00:00Z'),
    documents: [],
    searches: [],
    assignments: [],
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

// The payload seam both routes reuse (supply + land slices — controlled here;
// pinned by the app's own tests).
const svc = vi.hoisted(() => ({
  getProjectPayload: vi.fn(),
}))

vi.mock('@/backend/lib/mjengo', () => svc)

import { GET as openapiGet } from '@/app/api/openapi.json/route'
import { GET as projectSuppliersGet } from '@/app/api/v1/projects/[id]/suppliers/route'
import { GET as projectParcelsGet } from '@/app/api/v1/projects/[id]/parcels/route'
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
  supply: {
    suppliers: SUPPLIERS.map((s) => ({ ...s, catalogItems: s.catalogItems.map((c) => ({ ...c })) })),
    orders: ORDERS.map((o) => ({ ...o })),
    savedSupplierIds: ['sup-2'],
  },
  land: { parcels: PARCELS.map((p) => ({ ...p })) },
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

// ---------------------------------------------------------------- suppliers

describe('GET /api/v1/projects/:id/suppliers — the catalog summary', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/p-1/suppliers${qs}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — the global directory in (createdAt ASC, id ASC) order with THIS project\'s relationship marks per row', async () => {
    sessionFor('contractor')
    const res = await projectSuppliersGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const items = body.data as Array<Record<string, unknown>>
    expect(items.map((s) => s.id)).toEqual(['sup-1', 'sup-2', 'sup-3'])
    expect(items[0]).toEqual({
      id: 'sup-1', businessName: 'Nairobi Hardware Centre', county: 'Nairobi', town: 'Industrial Area',
      phone: '+254711000001', email: 'sales@nairobihardware.example',
      verificationState: 4, reliabilityScore: 78, responseHours: 12,
      deliveryFeeBase: 3500, minimumOrder: 5000, freeDeliveryOver: 200_000,
      deliveryZones: 'Nairobi,Kiambu,Machakos', operatingHours: 'Mon-Sat 07:00-18:00',
      savedByProject: false, orderCount: 2, orderTotal: 101_750,
      catalogCount: 3,
      catalog: CATALOG_NHC.map((c) => ({
        id: c.id, name: c.name, category: c.category, brand: c.brand, specification: c.specification,
        unit: c.unit, unitPrice: c.unitPrice, stockQty: c.stockQty, minOrderQty: c.minOrderQty,
        updatedAt: c.updatedAt.toISOString(),
      })),
      createdAt: '2026-01-05T09:00:00.000Z', updatedAt: '2026-02-20T09:00:00.000Z',
    })
    // the saved mark + a supplier with no orders of this project
    expect(items[1]).toMatchObject({ id: 'sup-2', savedByProject: true, orderCount: 0, orderTotal: 0, catalogCount: 0 })
    expect(items[2]).toMatchObject({ id: 'sup-3', savedByProject: false, orderCount: 1, orderTotal: 46_000 })
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('?q= filters BEFORE pagination — "hardware" matches two; a filtered-out cursor → 400', async () => {
    sessionFor('admin')
    const hits = await bodyOf(await projectSuppliersGet(req('p-1', '?q=hardware'), ctx('p-1')))
    expect((hits.data as Array<{ id: string }>).map((s) => s.id)).toEqual(['sup-1', 'sup-3'])

    const stale = await projectSuppliersGet(req('p-1', '?q=kiambu&cursor=sup-1'), ctx('p-1'))
    expect(stale.status).toBe(400)
    const body = await bodyOf(stale)
    expect(body.error).toMatch(/the id of a supplier in this list/)
    expect(body.field).toBe('cursor')
  })

  it('cursor pagination: limit=2 pages walk all 3 suppliers with no overlap', async () => {
    sessionFor('admin')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const url = `http://localhost/api/v1/projects/p-1/suppliers?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await bodyOf(await projectSuppliersGet(getReq(url), ctx('p-1')))
      seen.push(...(body.data as Array<{ id: string }>).map((s) => s.id))
      pages++
      expect(body.hasMore).toBe(pages < 2)
      cursor = (body.nextCursor as string | null) ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(2)
    expect(seen).toEqual(['sup-1', 'sup-2', 'sup-3'])
  })

  it('FEATURE FLAG: marketplace OFF → 403 for non-admins; admin bypasses; flag ON → 200', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    invalidateFlagCache()
    sessionFor('contractor')
    const denied = await projectSuppliersGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect((await bodyOf(denied)).error).toMatch(/Feature disabled by feature flag \(marketplace\)/)

    sessionFor('admin')
    expect((await projectSuppliersGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    delete process.env.NEXT_FLAGS_OFF
    invalidateFlagCache()
    sessionFor('contractor')
    expect((await projectSuppliersGet(req('p-1'), ctx('p-1'))).status).toBe(200)
  })

  it('scoping: unknown project → 404; foreign client → 403; own client → 200; supplier → uniform 403; anonymous → 401', async () => {
    svc.getProjectPayload.mockResolvedValueOnce(null)
    sessionFor('admin')
    expect((await projectSuppliersGet(req('p-x'), ctx('p-x'))).status).toBe(404)

    sessionFor('client', 'p-2')
    const denied = await projectSuppliersGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    sessionFor('client', 'p-1')
    expect((await projectSuppliersGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    sessionFor('supplier')
    const supplierDenied = await projectSuppliersGet(req('p-1'), ctx('p-1'))
    expect(supplierDenied.status).toBe(403)
    expect(await bodyOf(supplierDenied)).toEqual({ error: 'Not permitted for this supplier account' })

    h.session = null
    expect((await projectSuppliersGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })

  it('unknown query key → 400 (typo protection, strictObject)', async () => {
    sessionFor('admin')
    const res = await projectSuppliersGet(req('p-1', '?county=Nairobi'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "county"' })
  })
})

// ---------------------------------------------------------------- parcels

describe('GET /api/v1/projects/:id/parcels — the verification ladder summary', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/p-1/parcels${qs}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — every parcel, deterministic (createdAt ASC, id ASC), counts + the latest search + assignments', async () => {
    sessionFor('contractor')
    const res = await projectParcelsGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const items = body.data as Array<Record<string, unknown>>
    expect(items.map((p) => p.id)).toEqual(['par-00000001', 'par-00000002', 'par-00000003'])
    expect(items[0]).toEqual({
      id: 'par-00000001', projectId: 'p-1', plotNumber: 'LR No. 2090/1234', county: 'Kiambu', town: 'Kitengela',
      lat: -1.44, lng: 36.98, approxArea: '0.25 ha', tenureType: 'freehold', status: 'verified',
      documentCount: 2, searchCount: 2, assignmentCount: 1,
      latestSearch: {
        id: 'srch-2', searchRef: 'RS-2026-000118', status: 'reviewed', transcriptionMatch: 'consistent',
        requestedAt: '2026-01-10T09:00:00.000Z', receivedAt: '2026-01-27T09:00:00.000Z', reviewedAt: '2026-01-30T09:00:00.000Z',
      },
      assignments: [
        {
          id: 'asg-1', professionalName: 'Surveyor Kimani', professionalCategory: 'surveyor',
          roleOnParcel: 'surveyor', status: 'active', createdAt: '2026-01-05T09:00:00.000Z',
        },
      ],
      createdAt: '2026-01-02T09:00:00.000Z', updatedAt: '2026-01-30T09:00:00.000Z',
    })
    // a parcel with no searches → honest null latestSearch, never fabricated
    expect(items[2]).toMatchObject({ status: 'searching', latestSearch: null, documentCount: 0, assignments: [] })
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('?status= filters BEFORE pagination — flagged → 1 (the mismatch flag state); a filtered-out cursor → 400', async () => {
    sessionFor('admin')
    const flagged = await bodyOf(await projectParcelsGet(req('p-1', '?status=flagged'), ctx('p-1')))
    expect((flagged.data as Array<{ id: string }>).map((p) => p.id)).toEqual(['par-00000002'])
    expect((flagged.data as Array<Record<string, unknown>>)[0].latestSearch).toMatchObject({ transcriptionMatch: 'mismatch' })

    const stale = await projectParcelsGet(req('p-1', '?status=flagged&cursor=par-00000001'), ctx('p-1'))
    expect(stale.status).toBe(400)
    const body = await bodyOf(stale)
    expect(body.error).toMatch(/the id of a parcel in this list/)
    expect(body.field).toBe('cursor')
  })

  it('a bogus status → honest 400 listing the three documented values', async () => {
    sessionFor('admin')
    const res = await projectParcelsGet(req('p-1', '?status=sold'), ctx('p-1'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/status must be one of searching, verified, flagged/)
    expect(body.field).toBe('status')
  })

  it('FEATURE FLAG: land_verification OFF → 403 for non-admins; admin bypasses; flag ON → 200', async () => {
    process.env.NEXT_FLAGS_OFF = 'land_verification'
    invalidateFlagCache()
    sessionFor('contractor')
    const denied = await projectParcelsGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect((await bodyOf(denied)).error).toMatch(/Feature disabled by feature flag \(land_verification\)/)

    sessionFor('admin')
    expect((await projectParcelsGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    delete process.env.NEXT_FLAGS_OFF
    invalidateFlagCache()
    sessionFor('contractor')
    expect((await projectParcelsGet(req('p-1'), ctx('p-1'))).status).toBe(200)
  })

  it('scoping: unknown project → 404; foreign client → 403; own client → 200; supplier → uniform 403; anonymous → 401', async () => {
    svc.getProjectPayload.mockResolvedValueOnce(null)
    sessionFor('admin')
    expect((await projectParcelsGet(req('p-x'), ctx('p-x'))).status).toBe(404)

    sessionFor('client', 'p-2')
    const denied = await projectParcelsGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    sessionFor('client', 'p-1')
    expect((await projectParcelsGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    sessionFor('supplier')
    const supplierDenied = await projectParcelsGet(req('p-1'), ctx('p-1'))
    expect(supplierDenied.status).toBe(403)
    expect(await bodyOf(supplierDenied)).toEqual({ error: 'Not permitted for this supplier account' })

    h.session = null
    expect((await projectParcelsGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })

  it('unknown query key → 400 (typo protection, strictObject)', async () => {
    sessionFor('admin')
    const res = await projectParcelsGet(req('p-1', '?county=Kiambu'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "county"' })
  })
})

// ---------------------------------------------------------------- rate limit

describe('GET /api/v1/projects/:id/suppliers — rate limit (120/min per principal)', () => {
  it('the 121st call within the window → 429 with Retry-After', async () => {
    vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
    try {
      sessionFor('contractor')
      const withIp = () => getReq('http://localhost/api/v1/projects/p-1/suppliers', { 'x-forwarded-for': '10.99.0.6' })
      const ctxP1 = { params: Promise.resolve({ id: 'p-1' }) }
      for (let i = 0; i < 120; i++) {
        const res = await projectSuppliersGet(withIp(), ctxP1)
        expect(res.status, `request ${i + 1} should pass`).toBe(200)
      }
      const blocked = await projectSuppliersGet(withIp(), ctxP1)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
      expect(await bodyOf(blocked)).toMatchObject({ error: 'Too many requests' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------- OpenAPI

describe('GET /api/openapi.json — Phase D supplier + parcel paths', () => {
  it('serves the two paths with matching operationIds + tags; /api/v1 counts 27 paths', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    expect(Object.keys(doc.paths)).toContain('/api/v1/projects/{id}/suppliers')
    expect(Object.keys(doc.paths)).toContain('/api/v1/projects/{id}/parcels')
    expect(doc.paths['/api/v1/projects/{id}/suppliers'].get.operationId).toBe('listProjectSuppliers')
    expect(doc.paths['/api/v1/projects/{id}/parcels'].get.operationId).toBe('listProjectParcels')
    expect(doc.paths['/api/v1/projects/{id}/suppliers'].get.tags).toEqual(['supply'])
    expect(doc.paths['/api/v1/projects/{id}/parcels'].get.tags).toEqual(['land'])
    const v1Paths = Object.keys(doc.paths).filter((p) => p.startsWith('/api/v1'))
    expect(v1Paths.length).toBe(27)
  })

  it('the SupplierCatalogSummary/ParcelSummary schemas are declared and carry the honest notes', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    for (const name of ['SupplierCatalogSummary', 'ParcelSummary']) {
      expect(Object.keys(doc.components.schemas)).toContain(name)
    }
    expect(doc.components.schemas.SupplierCatalogSummary.description).toMatch(/GLOBAL directory/i)
    expect(doc.components.schemas.ParcelSummary.description).toMatch(/NEVER a government certification claim/i)
  })

  it('SDK ROUND-TRIP: the documented required fields are exactly the response fields (no drift, no leaks)', async () => {
    sessionFor('contractor')
    // Unique IP: a fresh rate-limit principal for these requests.
    const withIp = (url: string) => getReq(url, { 'x-forwarded-for': '10.99.0.7' })
    const doc = (await (await openapiGet()).json()) as Record<string, any>

    const suppliers = (await bodyOf(
      await projectSuppliersGet(withIp('http://localhost/api/v1/projects/p-1/suppliers'), { params: Promise.resolve({ id: 'p-1' }) }),
    )).data as Array<Record<string, unknown>>
    const supplier = suppliers[0]
    const supplierSchema = doc.components.schemas.SupplierCatalogSummary as { required: string[]; properties: Record<string, unknown> }
    for (const key of supplierSchema.required) expect(supplier, `SupplierCatalogSummary.${key}`).toHaveProperty(key)
    for (const key of Object.keys(supplier)) expect(supplierSchema.properties, `undocumented supplier key "${key}"`).toHaveProperty(key)
    const catalogRow = (supplier.catalog as Array<Record<string, unknown>>)[0]
    const catalogSchema = (supplierSchema.properties.catalog as { items: { required: string[]; properties: Record<string, unknown> } }).items
    for (const key of catalogSchema.required) expect(catalogRow, `catalog.${key}`).toHaveProperty(key)
    for (const key of Object.keys(catalogRow)) expect(catalogSchema.properties, `undocumented catalog key "${key}"`).toHaveProperty(key)

    const parcels = (await bodyOf(
      await projectParcelsGet(withIp('http://localhost/api/v1/projects/p-1/parcels'), { params: Promise.resolve({ id: 'p-1' }) }),
    )).data as Array<Record<string, unknown>>
    const parcel = parcels[0]
    const parcelSchema = doc.components.schemas.ParcelSummary as { required: string[]; properties: Record<string, unknown> }
    for (const key of parcelSchema.required) expect(parcel, `ParcelSummary.${key}`).toHaveProperty(key)
    for (const key of Object.keys(parcel)) expect(parcelSchema.properties, `undocumented parcel key "${key}"`).toHaveProperty(key)
    const latestSearch = parcel.latestSearch as Record<string, unknown>
    const searchSchema = parcelSchema.properties.latestSearch as { required: string[]; properties: Record<string, unknown> }
    for (const key of searchSchema.required) expect(latestSearch, `latestSearch.${key}`).toHaveProperty(key)
    for (const key of Object.keys(latestSearch)) expect(searchSchema.properties, `undocumented latestSearch key "${key}"`).toHaveProperty(key)
    const assignmentRow = (parcel.assignments as Array<Record<string, unknown>>)[0]
    const assignmentSchema = (parcelSchema.properties.assignments as { items: { required: string[]; properties: Record<string, unknown> } }).items
    for (const key of assignmentSchema.required) expect(assignmentRow, `assignments.${key}`).toHaveProperty(key)
    for (const key of Object.keys(assignmentRow)) expect(assignmentSchema.properties, `undocumented assignments key "${key}"`).toHaveProperty(key)
  })
})
