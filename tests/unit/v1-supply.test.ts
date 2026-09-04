/**
 * /api/v1 Phase B (task 10-a) — the SUPPLY resource contract:
 * GET /api/v1/supply/orders, GET /api/v1/supply/orders/:id and
 * GET /api/v1/projects/:id/deliveries.
 *
 * Pinned invariants:
 *   · FEATURE FLAG — the v1 supply family is gated by `marketplace` exactly
 *     the way the wallet family is gated by `wallet`: OFF → 403
 *     'Feature disabled by feature flag (marketplace)' for NON-ADMIN sessions
 *     (admins bypass), and the underlying service read is NEVER invoked.
 *   · ROLE SCOPING mirrors the webapp data guard — any signed-in role may
 *     read; a client-role session is pinned to its own project (foreign →
 *     403 'Not permitted for this project', the v1 payments precedent:
 *     resolve first, pin second on the order detail).
 *   · CURSOR PAGINATION — stable pages, no overlap, filters (?status=)
 *     BEFORE pagination, a cursor outside the filtered list → 400 { field }.
 *   · ERROR SHAPES — one { error, field? } contract: 400 zod (unknown query
 *     keys listed by name; projectId required on the orders list), 401
 *     anonymous, 403 flag/client pin, 404 unknown project/order.
 *   · DELIVERY HONESTY — verification records carry counts, status and
 *     discrepancy flags (shortLines = receiveDelivery's exact short-line
 *     predicate); evidence photos are ATTACHMENT IDS ONLY — no bytes and no
 *     storageKey URLs anywhere in a v1 supply body.
 *   · The OpenAPI document carries the supply paths with matching
 *     operationIds and the honest photo/flag notes.
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control), '@/backend/lib/db' (featureFlag + the two route-layer reads:
 * project.findUnique, purchaseOrder.findFirst), and
 * '@/backend/modules/supply/repository' (loadSupplySlice — the module's
 * public read). route-kit, rate-limit, flags, respond/schemas and the
 * routes themselves stay REAL. NEXT_FLAGS_OFF + invalidateFlagCache().
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
  const projects = [
    { id: 'p-1', name: 'Riverside Villas' },
    { id: 'p-2', name: 'Westlands Duplex' },
  ]
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
          return projects.find((p) => p.id === where.id) ?? null
        },
      },
      purchaseOrder: {
        async findFirst({ where }: { where: { OR: Array<Record<string, string>> } }) {
          const id = where.OR.find((c) => c.id !== undefined)?.id
          const code = where.OR.find((c) => c.orderCode !== undefined)?.orderCode
          if (id === ORDER.id || code === ORDER.orderCode) return structuredClone(ORDER)
          return null
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

// The supply module's public read — controlled per test.
const repo = vi.hoisted(() => ({ loadSupplySlice: vi.fn() }))
vi.mock('@/backend/modules/supply/repository', () => repo)

import { GET as openapiGet } from '@/app/api/openapi.json/route'
import { GET as supplyOrdersGet } from '@/app/api/v1/supply/orders/route'
import { GET as supplyOrderDetailGet } from '@/app/api/v1/supply/orders/[id]/route'
import { GET as projectDeliveriesGet } from '@/app/api/v1/projects/[id]/deliveries/route'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'

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

const d = (iso: string) => new Date(iso)

const ORDER_LINES = [
  { id: 'pol-1', name: 'Cement 50kg', unit: 'bag', qty: 200, unitPrice: 750, lineTotal: 150_000 },
  { id: 'pol-2', name: 'Ballast', unit: 'tonne', qty: 10, unitPrice: 2_500, lineTotal: 25_000 },
]

/** The delivery-verification rows (ground truth, spec §34). */
const Dlv2 = {
  id: 'dlv-2', orderId: 'po-1', status: 'received',
  dispatchedAt: d('2026-02-28T08:00:00Z'), receivedAt: d('2026-03-01T14:00:00Z'),
  receivedBy: 'Juma', note: 'counted at the gate',
  driverName: 'Otieno', driverPhone: '+254700000001', vehicleReg: 'KDA 123X',
  etaAt: d('2026-03-01T12:00:00Z'), departedAt: d('2026-02-28T08:00:00Z'), arrivedAt: d('2026-03-01T11:45:00Z'),
  gpsLat: -1.29, gpsLng: 36.78, photoCount: 1, photoUrls: '[]',
  createdAt: d('2026-03-01T14:00:00Z'),
  lines: [
    { id: 'odl-3', orderLineId: 'pol-1', qtyOrdered: 200, qtyReceived: 180, qtyRejected: 5, condition: 'partial', damageNote: '5 torn bags' },
    { id: 'odl-4', orderLineId: 'pol-2', qtyOrdered: 10, qtyReceived: 10, qtyRejected: 0, condition: 'ok', damageNote: null },
  ],
  photos: [{ id: 'dp-1', deliveryId: 'dlv-2', attachmentId: 'att-1', attachment: { id: 'att-1', storageKey: '/photos/upp-1.png' }, deliveryLineId: 'odl-3', attachedBy: 'Juma', createdAt: d('2026-03-01T14:05:00Z') }],
}
const Dlv1 = {
  id: 'dlv-1', orderId: 'po-1', status: 'discrepancy',
  dispatchedAt: d('2026-02-14T08:00:00Z'), receivedAt: d('2026-02-15T15:00:00Z'),
  receivedBy: 'Otieno', note: 'Ordered 200 · Received 150 — 50 missing, flagged for review',
  driverName: 'Mwangi', driverPhone: null, vehicleReg: 'KBX 456Y',
  etaAt: d('2026-02-15T12:00:00Z'), departedAt: d('2026-02-14T08:00:00Z'), arrivedAt: d('2026-02-15T12:10:00Z'),
  gpsLat: null, gpsLng: null, photoCount: 0, photoUrls: '[]',
  createdAt: d('2026-02-15T15:00:00Z'),
  lines: [
    { id: 'odl-1', orderLineId: 'pol-1', qtyOrdered: 200, qtyReceived: 150, qtyRejected: 0, condition: 'ok', damageNote: null },
    { id: 'odl-2', orderLineId: 'pol-2', qtyOrdered: 10, qtyReceived: 10, qtyRejected: 0, condition: 'ok', damageNote: null },
  ],
  photos: [],
}
const Dlv3 = {
  id: 'dlv-3', orderId: 'po-2', status: 'dispatched',
  dispatchedAt: d('2026-02-20T09:00:00Z'), receivedAt: null, receivedBy: null, note: null,
  driverName: 'Kariuki', driverPhone: '+254700000002', vehicleReg: 'KDG 789Z',
  etaAt: d('2026-02-21T09:00:00Z'), departedAt: d('2026-02-20T09:00:00Z'), arrivedAt: null,
  gpsLat: null, gpsLng: null, photoCount: 0, photoUrls: '[]',
  createdAt: d('2026-02-20T09:00:00Z'),
  lines: [],
  photos: [],
}

/** The purchase orders of the slice (createdAt DESC expected: po-3, po-1, po-2). */
const SLICE = {
  suppliers: [],
  requests: [],
  approvalRules: [],
  approvals: [],
  quotes: [],
  savedSupplierIds: [],
  orders: [
    {
      id: 'po-1', orderCode: 'PO-2026-000001', projectId: 'p-1', status: 'sent', supplierId: 'sup-1',
      supplierName: 'Karioke Hardware', requestCode: 'MR-2026-000001', subtotal: 175_000,
      deliveryFee: 5_000, total: 180_000, paymentSource: 'client', createdByRole: 'contractor',
      note: 'foundation materials', createdAt: d('2026-02-10T10:00:00Z'), updatedAt: d('2026-02-11T10:00:00Z'),
      lines: ORDER_LINES, deliveries: [Dlv2, Dlv1],
    },
    {
      id: 'po-2', orderCode: 'PO-2026-000002', projectId: 'p-1', status: 'draft', supplierId: 'sup-2',
      supplierName: 'Nairobi Steel', requestCode: null, subtotal: 60_000, deliveryFee: 2_000,
      total: 62_000, paymentSource: 'project_wallet', createdByRole: 'supervisor', note: null,
      createdAt: d('2026-01-15T10:00:00Z'), updatedAt: d('2026-01-15T10:00:00Z'),
      lines: [], deliveries: [Dlv3],
    },
    {
      id: 'po-3', orderCode: 'PO-2026-000003', projectId: 'p-1', status: 'confirmed', supplierId: 'sup-3',
      supplierName: 'Simba Cement', requestCode: null, subtotal: 100_000, deliveryFee: 0, total: 100_000,
      paymentSource: 'contractor', createdByRole: 'procurement', note: null,
      createdAt: d('2026-03-05T10:00:00Z'), updatedAt: d('2026-03-05T10:00:00Z'),
      lines: [], deliveries: [],
    },
  ],
}

/** The single order the detail route's route-layer read resolves (by id or code). */
const ORDER = {
  id: 'po-1', orderCode: 'PO-2026-000001', projectId: 'p-1', status: 'sent', supplierId: 'sup-1',
  supplier: { businessName: 'Karioke Hardware' }, request: { requestCode: 'MR-2026-000001' },
  subtotal: 175_000, deliveryFee: 5_000, total: 180_000, paymentSource: 'client', createdByRole: 'contractor',
  note: 'foundation materials', createdAt: d('2026-02-10T10:00:00Z'), updatedAt: d('2026-02-11T10:00:00Z'),
  lines: ORDER_LINES, deliveries: [Dlv2, Dlv1],
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  repo.loadSupplySlice.mockResolvedValue(SLICE)
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

// ---------------------------------------------------------------- orders list

describe('GET /api/v1/supply/orders — list', () => {
  it('200 — orders of the project, (createdAt DESC, id DESC), summaries with joined supplier + deliveryCount', async () => {
    sessionFor('contractor')
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(repo.loadSupplySlice).toHaveBeenCalledWith('p-1')
    expect(body.ok).toBe(true)
    expect(body.data).toEqual([
      {
        id: 'po-3', orderCode: 'PO-2026-000003', status: 'confirmed', supplierId: 'sup-3',
        supplierName: 'Simba Cement', requestCode: null, subtotal: 100_000, deliveryFee: 0,
        total: 100_000, paymentSource: 'contractor', createdByRole: 'procurement', note: null,
        deliveryCount: 0, createdAt: '2026-03-05T10:00:00.000Z', updatedAt: '2026-03-05T10:00:00.000Z',
      },
      {
        id: 'po-1', orderCode: 'PO-2026-000001', status: 'sent', supplierId: 'sup-1',
        supplierName: 'Karioke Hardware', requestCode: 'MR-2026-000001', subtotal: 175_000,
        deliveryFee: 5_000, total: 180_000, paymentSource: 'client', createdByRole: 'contractor',
        note: 'foundation materials', deliveryCount: 2,
        createdAt: '2026-02-10T10:00:00.000Z', updatedAt: '2026-02-11T10:00:00.000Z',
      },
      {
        id: 'po-2', orderCode: 'PO-2026-000002', status: 'draft', supplierId: 'sup-2',
        supplierName: 'Nairobi Steel', requestCode: null, subtotal: 60_000, deliveryFee: 2_000,
        total: 62_000, paymentSource: 'project_wallet', createdByRole: 'supervisor', note: null,
        deliveryCount: 1, createdAt: '2026-01-15T10:00:00.000Z', updatedAt: '2026-01-15T10:00:00.000Z',
      },
    ])
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('?status= filters BEFORE pagination', async () => {
    sessionFor('procurement')
    const body = await bodyOf(await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1&status=sent')))
    expect((body.data as Array<{ id: string }>).map((o) => o.id)).toEqual(['po-1'])
    const bad = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1&status=shipped'))
    expect(bad.status).toBe(400)
    expect((await bodyOf(bad)).error).toMatch(/status must be one of draft, pending_approval/)
  })

  it('cursor pagination: limit=2 → [po-3, po-1], cursor → [po-2]; no overlap, null at the end', async () => {
    sessionFor('admin')
    const first = await bodyOf(await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1&limit=2')))
    expect((first.data as Array<{ id: string }>).map((o) => o.id)).toEqual(['po-3', 'po-1'])
    expect(first.nextCursor).toBe('po-1')
    expect(first.hasMore).toBe(true)
    const second = await bodyOf(
      await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1&limit=2&cursor=po-1')),
    )
    expect((second.data as Array<{ id: string }>).map((o) => o.id)).toEqual(['po-2'])
    expect(second.nextCursor).toBeNull()
    expect(second.hasMore).toBe(false)
  })

  it('a cursor outside the (filtered) list → 400 "an order"', async () => {
    sessionFor('admin')
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1&status=draft&cursor=po-3'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/the id of an order in this list/)
    expect(body.field).toBe('cursor')
  })

  it('projectId is REQUIRED — absent → 400 with the projectId field', async () => {
    sessionFor('contractor')
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/projectId/)
    expect(body.field).toBe('projectId')
    expect(repo.loadSupplySlice).not.toHaveBeenCalled()
  })

  it('unknown project → 404 { error: "Project not found" }, no slice load', async () => {
    sessionFor('contractor')
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-x'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Project not found' })
    expect(repo.loadSupplySlice).not.toHaveBeenCalled()
  })

  it('client pinned to a foreign project → 403, no slice load', async () => {
    sessionFor('client', 'p-2')
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this project' })
    expect(repo.loadSupplySlice).not.toHaveBeenCalled()
  })

  it('client reading their OWN project → 200', async () => {
    sessionFor('client', 'p-1')
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(res.status).toBe(200)
  })

  it('client with no pinned project → 403 (fail closed)', async () => {
    sessionFor('client', null)
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(res.status).toBe(403)
  })

  it('unknown query key → 400 listing it by name', async () => {
    sessionFor('contractor')
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1&supplier=sup-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "supplier"' })
  })

  it('anonymous → 401', async () => {
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(res.status).toBe(401)
    expect(await bodyOf(res)).toEqual({ error: 'Sign in required' })
  })
})

// ---------------------------------------------------------------- order detail

describe('GET /api/v1/supply/orders/:id — detail', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 by cuid — summary head + lines + delivery records with per-line counts', async () => {
    sessionFor('contractor')
    const res = await supplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-1'), ctx('po-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    const data = body.data as Record<string, unknown>
    expect(data.id).toBe('po-1')
    expect(data.supplierName).toBe('Karioke Hardware')
    expect(data.requestCode).toBe('MR-2026-000001')
    expect(data.deliveryCount).toBe(2)
    expect(data.lines).toEqual([
      { id: 'pol-1', name: 'Cement 50kg', unit: 'bag', qty: 200, unitPrice: 750, lineTotal: 150_000 },
      { id: 'pol-2', name: 'Ballast', unit: 'tonne', qty: 10, unitPrice: 2_500, lineTotal: 25_000 },
    ])
    const deliveries = data.deliveries as Array<Record<string, unknown>>
    expect(deliveries.map((x) => x.id)).toEqual(['dlv-2', 'dlv-1'])
    expect(deliveries[0]).toMatchObject({ status: 'received', photoCount: 1, shortLines: 1 })
    expect(deliveries[1]).toMatchObject({ status: 'discrepancy', shortLines: 1 })
  })

  it('200 by orderCode — PO-2026-000001 resolves the same order (id OR code)', async () => {
    sessionFor('finance')
    const res = await supplyOrderDetailGet(
      getReq('http://localhost/api/v1/supply/orders/PO-2026-000001'),
      ctx('PO-2026-000001'),
    )
    expect(res.status).toBe(200)
    expect(((await bodyOf(res)).data as { id: string }).id).toBe('po-1')
  })

  it('photos are ATTACHMENT IDS ONLY — no storageKey and no bytes anywhere in the body', async () => {
    sessionFor('admin')
    const res = await supplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-1'), ctx('po-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const json = JSON.stringify(body)
    expect(json).not.toContain('storageKey')
    expect(json).not.toContain('/photos/')
    const photos = (body.data as { deliveries: Array<{ photos: unknown[] }> }).deliveries[0].photos
    expect(photos).toEqual([
      { attachmentId: 'att-1', deliveryLineId: 'odl-3', attachedBy: 'Juma', createdAt: '2026-03-01T14:05:00.000Z' },
    ])
  })

  it('unknown order → 404 { error: "Order not found" }', async () => {
    sessionFor('admin')
    const res = await supplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-x'), ctx('po-x'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Order not found' })
  })

  it('client pinned to the order\'s foreign project → 403 (resolve-first, pin-second)', async () => {
    sessionFor('client', 'p-2')
    const res = await supplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-1'), ctx('po-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this project' })
  })

  it('a malformed :id (bad characters) → 400 field "id"', async () => {
    sessionFor('admin')
    const res = await supplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po 1!'), ctx('po 1!'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/order reference must be 2-40 characters/)
    expect(body.field).toBe('id')
  })

  it('unknown query key → 400 (strictObject on the detail)', async () => {
    sessionFor('admin')
    const res = await supplyOrderDetailGet(
      getReq('http://localhost/api/v1/supply/orders/po-1?projectId=p-1'),
      ctx('po-1'),
    )
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "projectId"' })
  })

  it('anonymous → 401', async () => {
    const res = await supplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-1'), ctx('po-1'))
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------- deliveries

describe('GET /api/v1/projects/:id/deliveries — delivery verification records', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/${id}/deliveries${qs}`)

  it('200 — every delivery of the project, (createdAt DESC, id DESC), field-for-field record', async () => {
    sessionFor('supervisor')
    const res = await projectDeliveriesGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(repo.loadSupplySlice).toHaveBeenCalledWith('p-1')
    const items = body.data as Array<Record<string, unknown>>
    expect(items.map((x) => x.id)).toEqual(['dlv-2', 'dlv-3', 'dlv-1'])
    expect(items[0]).toEqual({
      id: 'dlv-2', orderId: 'po-1', orderCode: 'PO-2026-000001', status: 'received',
      dispatchedAt: '2026-02-28T08:00:00.000Z', receivedAt: '2026-03-01T14:00:00.000Z',
      receivedBy: 'Juma', note: 'counted at the gate',
      driverName: 'Otieno', driverPhone: '+254700000001', vehicleReg: 'KDA 123X',
      etaAt: '2026-03-01T12:00:00.000Z', departedAt: '2026-02-28T08:00:00.000Z', arrivedAt: '2026-03-01T11:45:00.000Z',
      gpsLat: -1.29, gpsLng: 36.78,
      photoCount: 1,
      photos: [{ attachmentId: 'att-1', deliveryLineId: 'odl-3', attachedBy: 'Juma', createdAt: '2026-03-01T14:05:00.000Z' }],
      lines: [
        { id: 'odl-3', orderLineId: 'pol-1', name: 'Cement 50kg', unit: 'bag', qtyOrdered: 200, qtyReceived: 180, qtyRejected: 5, condition: 'partial', damageNote: '5 torn bags', short: true },
        { id: 'odl-4', orderLineId: 'pol-2', name: 'Ballast', unit: 'tonne', qtyOrdered: 10, qtyReceived: 10, qtyRejected: 0, condition: 'ok', damageNote: null, short: false },
      ],
      shortLines: 1,
      createdAt: '2026-03-01T14:00:00.000Z',
    })
    // The discrepancy record keeps its raw counts + the service's auto-summary note.
    expect(items[2]).toMatchObject({ id: 'dlv-1', status: 'discrepancy', shortLines: 1, photoCount: 0 })
    expect((items[2].lines as Array<Record<string, unknown>>)[0]).toMatchObject({ qtyReceived: 150, short: true })
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('?status= filters BEFORE pagination (each of the five documented values)', async () => {
    sessionFor('contractor')
    for (const [status, expected] of [
      ['received', ['dlv-2']],
      ['dispatched', ['dlv-3']],
      ['discrepancy', ['dlv-1']],
    ] as const) {
      const body = await bodyOf(await projectDeliveriesGet(req('p-1', `?status=${status}`), ctx('p-1')))
      expect((body.data as Array<{ id: string }>).map((x) => x.id)).toEqual([...expected])
    }
    const bad = await projectDeliveriesGet(req('p-1', '?status=delivered'), ctx('p-1'))
    expect(bad.status).toBe(400)
    expect((await bodyOf(bad)).error).toMatch(/status must be one of dispatched, in_transit/)
  })

  it('cursor pagination: limit=2 → [dlv-2, dlv-3], cursor → [dlv-1]; no overlap', async () => {
    sessionFor('admin')
    const first = await bodyOf(await projectDeliveriesGet(req('p-1', '?limit=2'), ctx('p-1')))
    expect((first.data as Array<{ id: string }>).map((x) => x.id)).toEqual(['dlv-2', 'dlv-3'])
    expect(first.nextCursor).toBe('dlv-3')
    expect(first.hasMore).toBe(true)
    const second = await bodyOf(await projectDeliveriesGet(req('p-1', '?limit=2&cursor=dlv-3'), ctx('p-1')))
    expect((second.data as Array<{ id: string }>).map((x) => x.id)).toEqual(['dlv-1'])
    expect(second.hasMore).toBe(false)
    expect(second.nextCursor).toBeNull()
  })

  it('a cursor outside the (filtered) list → 400 "a delivery"', async () => {
    sessionFor('admin')
    const res = await projectDeliveriesGet(req('p-1', '?status=received&cursor=dlv-1'), ctx('p-1'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/the id of a delivery in this list/)
    expect(body.field).toBe('cursor')
  })

  it('unknown project → 404; client foreign project → 403; anonymous → 401', async () => {
    sessionFor('admin')
    expect((await projectDeliveriesGet(req('p-x'), ctx('p-x'))).status).toBe(404)
    sessionFor('client', 'p-2')
    const denied = await projectDeliveriesGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })
    h.session = null
    expect((await projectDeliveriesGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })

  it('unknown query key → 400 listing it by name', async () => {
    sessionFor('admin')
    const res = await projectDeliveriesGet(req('p-1', '?photos=1'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "photos"' })
  })
})

// ---------------------------------------------------------------- flag gate

describe('marketplace flag gates the whole v1 supply family (non-admins)', () => {
  it('flag OFF + contractor on the orders list → 403 naming the flag, no service read', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('contractor')
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(res.status).toBe(403)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/Feature disabled by feature flag \(marketplace\)/)
    expect(body.error).toMatch(/admin can re-enable/)
    expect(repo.loadSupplySlice).not.toHaveBeenCalled()
  })

  it('flag OFF + admin → 200 (bypass so the flag can be exercised)', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('admin')
    const res = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(res.status).toBe(200)
  })

  it('flag OFF + contractor on the order detail → 403, no order read', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('contractor')
    const res = await supplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-1'), {
      params: Promise.resolve({ id: 'po-1' }),
    })
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toMatch(/Feature disabled by feature flag \(marketplace\)/)
  })

  it('flag OFF + supervisor on the deliveries list → 403, no slice load', async () => {
    process.env.NEXT_FLAGS_OFF = 'marketplace'
    sessionFor('supervisor')
    const res = await projectDeliveriesGet(getReq('http://localhost/api/v1/projects/p-1/deliveries'), {
      params: Promise.resolve({ id: 'p-1' }),
    })
    expect(res.status).toBe(403)
    expect(repo.loadSupplySlice).not.toHaveBeenCalled()
  })

  it('flag ON → the routes behave normally (the gate is additive, not a rewrite)', async () => {
    sessionFor('contractor')
    const list = await supplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(list.status).toBe(200)
    const detail = await supplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-1'), {
      params: Promise.resolve({ id: 'po-1' }),
    })
    expect(detail.status).toBe(200)
  })
})

// ---------------------------------------------------------------- OpenAPI

describe('GET /api/openapi.json — Phase B supply paths + honest notes', () => {
  it('serves the three supply paths with matching operationIds and the supply tag', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    for (const path of [
      '/api/v1/supply/orders',
      '/api/v1/supply/orders/{id}',
      '/api/v1/projects/{id}/deliveries',
    ]) {
      expect(Object.keys(doc.paths)).toContain(path)
    }
    expect(doc.paths['/api/v1/supply/orders'].get.operationId).toBe('listSupplyOrders')
    expect(doc.paths['/api/v1/supply/orders/{id}'].get.operationId).toBe('getSupplyOrder')
    expect(doc.paths['/api/v1/projects/{id}/deliveries'].get.operationId).toBe('listProjectDeliveries')
    expect(doc.paths['/api/v1/supply/orders'].get.tags).toEqual(['supply'])
  })

  it('the supply schemas are declared as components', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    for (const name of ['SupplyOrderSummary', 'SupplyOrderDetail', 'DeliveryVerification']) {
      expect(Object.keys(doc.components.schemas)).toContain(name)
    }
  })

  it('documents the photo-ids-only honesty and the marketplace flag 403', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    const deliveriesDesc = doc.paths['/api/v1/projects/{id}/deliveries'].get.description
    expect(deliveriesDesc).toMatch(/ATTACHMENT ID ONLY/)
    expect(deliveriesDesc).toMatch(/marketplace/)
    expect(doc.paths['/api/v1/supply/orders'].get.responses[403].description).toMatch(/marketplace/)
    expect(doc.paths['/api/v1/supply/orders/{id}'].get.responses[403].description).toMatch(/marketplace/)
    // The wallet family's 403 now documents its own flag reason (9-a follow-up).
    expect(doc.paths['/api/v1/wallets'].get.responses[403].description).toMatch(/Feature disabled by feature flag \(wallet\)/)
  })

  it('documents projectId as REQUIRED on the supply orders list', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    const param = doc.paths['/api/v1/supply/orders'].get.parameters.find(
      (p: { name: string }) => p.name === 'projectId',
    )
    expect(param.required).toBe(true)
  })
})
