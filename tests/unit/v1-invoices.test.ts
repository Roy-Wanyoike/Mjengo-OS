/**
 * /api/v1 Phase C (W3-2) — the INVOICE read surface with 3-way-match
 * verdicts: GET /api/v1/projects/:id/invoices and GET /api/v1/invoices/:id.
 *
 * Pinned invariants:
 *   · ROLE SCOPING mirrors the v1 payments precedent — resolve first, pin
 *     second: any signed-in role may read; a client-role session is pinned
 *     to its own project (foreign → 403 'Not permitted for this project',
 *     indistinguishable for probes; own → 200); unknown project/invoice →
 *     404; anonymous → 401. The detail resolves id OR invoiceCode.
 *   · NO FEATURE FLAG gates these resources — even with every flag forced
 *     off (marketplace included), the reads still answer 200: flags.ts
 *     documents that invoice.* is not gated by marketplace (its own module
 *     sharing the Finder tab) and the wallet flag never applied to it.
 *   · CURSOR PAGINATION — stable pages, no overlap, ?status= (the six
 *     InvoiceStatus values) filters BEFORE pagination, a cursor outside the
 *     (filtered) list → 400 { field }.
 *   · LIFECYCLE HONESTY — disputed and paid states are represented exactly
 *     as stored (dispute fields decidedAt/decidedBy/note; payment fields
 *     paidAt/paidByRole/paymentMethod/paymentReference); lines + totals
 *     surface as stored (recomputed server-side at write time, never here).
 *   · 3-WAY VERDICT — the detail carries the report from the invoices
 *     module's OWN read-only threeWayCheck (one algorithm, one source of
 *     truth: the exact function /api/actions invoice.threeWayCheck runs);
 *     a thrown 'Invoice not found in this project' maps to 404 (the
 *     NOT_FOUND_MESSAGES family).
 *   · The OpenAPI document carries the new paths (19 /api/v1 total) with
 *     matching operationIds + the honest warn-only verdict notes.
 *
 * Mocks (flags-gating idioms): '@/backend/lib/guard' full fake (session
 * control), '@/backend/lib/db' (featureFlag rows + invoice.findFirst),
 * '@/backend/lib/mjengo' (getProjectPayload — the payload's invoices slice)
 * and '@/backend/modules/invoices/service' (threeWayCheck — the module's
 * read-only check, controlled here; the pure matchThreeWay math is pinned
 * by three-way.test.ts). route-kit, rate-limit, flags, respond/schemas and
 * the routes themselves stay REAL.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null } },
}))

const d = (iso: string) => new Date(iso)

// ---------------------------------------------------------------- fixtures (hoisted for the db factory)

/** Three lines of the INV-2026-000027 shape (paperwork side of the match). */
const LINES_27 = [
  { id: 'il-27-1', name: 'Cement 50kg (32.5N)', qty: 50, unitPrice: 795, lineTotal: 39_750 },
  { id: 'il-27-2', name: 'Ballast (screened)', qty: 10, unitPrice: 1_950, lineTotal: 19_500 },
  { id: 'il-27-3', name: 'Delivery — Industrial Area to Kitengela', qty: 1, unitPrice: 3_500, lineTotal: 3_500 },
]

const LINES_31 = [
  { id: 'il-31-1', name: 'Cement 50kg (32.5N)', qty: 50, unitPrice: 760, lineTotal: 38_000 },
  { id: 'il-31-2', name: 'Steel bar Y12 (12m length)', qty: 10, unitPrice: 9_800, lineTotal: 98_000 },
  { id: 'il-31-3', name: 'Delivery — Kiambi Road to Kitengela', qty: 1, unitPrice: 2_500, lineTotal: 2_500 },
]

const LINES_21 = [
  { id: 'il-21-1', name: 'Roofing sheet — box profile 30G (2m)', qty: 30, unitPrice: 1_150, lineTotal: 34_500 },
  { id: 'il-21-2', name: 'Delivery — Karen to Kitengela', qty: 1, unitPrice: 1_800, lineTotal: 1_800 },
]

const LINES_18 = [
  { id: 'il-18-1', name: 'Paint — silk emerald 20L', qty: 6, unitPrice: 4_200, lineTotal: 25_200 },
]

/**
 * Five invoices across the lifecycle (createdAt DESC list order expected:
 * inv-3, inv-2, inv-4, inv-5, inv-1).
 */
const INVOICES = [
  {
    id: 'inv-000021', invoiceCode: 'INV-2026-000021', projectId: 'p-1', orderId: null, supplierId: 'sup-1',
    status: 'paid', subtotal: 36_300, tax: 0, total: 46_000,
    dueDate: d('2026-01-28T12:00:00Z'), issuedAt: d('2026-01-20T11:00:00Z'), submittedAt: d('2026-01-21T09:00:00Z'),
    decidedAt: d('2026-01-22T18:00:00Z'), decidedBy: 'Amina (Client)', paidAt: d('2026-01-24T13:00:00Z'),
    paidByRole: 'client', paymentMethod: 'mpesa', paymentReference: 'MPESA-8HKT4Q2A',
    createdBy: 'Karen Timber & Hardware', note: 'Roofing package deposit — paid via M-Pesa.',
    createdAt: d('2026-01-20T11:00:00Z'), updatedAt: d('2026-01-24T13:00:00Z'),
    lines: LINES_21, supplier: { businessName: 'Karen Timber & Hardware' }, order: null,
  },
  {
    id: 'inv-000027', invoiceCode: 'INV-2026-000027', projectId: 'p-1', orderId: 'po-000009', supplierId: 'sup-2',
    status: 'approved', subtotal: 62_750, tax: 0, total: 62_750,
    dueDate: d('2026-02-24T12:00:00Z'), issuedAt: d('2026-02-07T11:00:00Z'), submittedAt: d('2026-02-08T09:00:00Z'),
    decidedAt: d('2026-02-09T16:00:00Z'), decidedBy: 'Amina (Client)', paidAt: null, paidByRole: null,
    paymentMethod: null, paymentReference: null,
    createdBy: 'Nairobi Hardware Centre', note: 'For PO-2026-000009. Approved pending shortfall reconciliation.',
    createdAt: d('2026-02-07T11:00:00Z'), updatedAt: d('2026-02-09T16:00:00Z'),
    lines: LINES_27, supplier: { businessName: 'Nairobi Hardware Centre' }, order: { orderCode: 'PO-2026-000009' },
  },
  {
    id: 'inv-000031', invoiceCode: 'INV-2026-000031', projectId: 'p-1', orderId: 'po-000012', supplierId: 'sup-3',
    status: 'submitted', subtotal: 136_000, tax: 0, total: 138_500,
    dueDate: d('2026-02-21T12:00:00Z'), issuedAt: d('2026-02-11T11:00:00Z'), submittedAt: d('2026-02-13T09:00:00Z'),
    decidedAt: null, decidedBy: null, paidAt: null, paidByRole: null, paymentMethod: null, paymentReference: null,
    createdBy: 'Kiambu Road Building Supplies', note: 'For PO-2026-000012. 3-way match PENDING — delivery not yet recorded.',
    createdAt: d('2026-02-11T11:00:00Z'), updatedAt: d('2026-02-13T09:00:00Z'),
    lines: LINES_31, supplier: { businessName: 'Kiambu Road Building Supplies' }, order: { orderCode: 'PO-2026-000012' },
  },
  {
    id: 'inv-000018', invoiceCode: 'INV-2026-000018', projectId: 'p-1', orderId: null, supplierId: 'sup-4',
    status: 'disputed', subtotal: 25_200, tax: 0, total: 25_200,
    dueDate: d('2026-02-10T12:00:00Z'), issuedAt: d('2026-02-02T11:00:00Z'), submittedAt: d('2026-02-03T09:00:00Z'),
    decidedAt: d('2026-02-05T10:00:00Z'), decidedBy: 'Amina (Client)', paidAt: null, paidByRole: null,
    paymentMethod: null, paymentReference: null,
    createdBy: 'Colourworks Kenya', note: 'Qty delivered (4) does not match the invoice (6) — reconcile before re-approval.',
    createdAt: d('2026-02-02T11:00:00Z'), updatedAt: d('2026-02-05T10:00:00Z'),
    lines: LINES_18, supplier: { businessName: 'Colourworks Kenya' }, order: null,
  },
  {
    id: 'inv-000012', invoiceCode: 'INV-2026-000012', projectId: 'p-1', orderId: null, supplierId: null,
    status: 'draft', subtotal: 9_800, tax: 0, total: 9_800,
    dueDate: null, issuedAt: null, submittedAt: null, decidedAt: null, decidedBy: null, paidAt: null,
    paidByRole: null, paymentMethod: null, paymentReference: null,
    createdBy: 'MjengoOS', note: null,
    createdAt: d('2026-02-01T11:00:00Z'), updatedAt: d('2026-02-01T11:00:00Z'),
    lines: [{ id: 'il-12-1', name: 'Scaffolding hire (week)', qty: 1, unitPrice: 9_800, lineTotal: 9_800 }],
    supplier: null, order: null,
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
      invoice: {
        async findFirst({ where }: { where: { OR: Array<Record<string, string>> } }) {
          const id = where.OR.find((c) => c.id !== undefined)?.id
          const code = where.OR.find((c) => c.invoiceCode !== undefined)?.invoiceCode
          const found = INVOICES.find((i) => i.id === id || i.invoiceCode === code)
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

// The payload seam the invoice LIST reuses (aggregations stay REAL in
// production — pinned by the app's own tests; here they are controlled).
const svc = vi.hoisted(() => ({
  getProjectPayload: vi.fn(),
}))

vi.mock('@/backend/lib/mjengo', () => svc)

// The invoices module's read-only 3-way check — controlled per test (the
// pure matchThreeWay math it delegates to is pinned by three-way.test.ts).
const invoiceSvc = vi.hoisted(() => ({ threeWayCheck: vi.fn() }))

vi.mock('@/backend/modules/invoices/service', () => invoiceSvc)

import { GET as openapiGet } from '@/app/api/openapi.json/route'
import { GET as projectInvoicesGet } from '@/app/api/v1/projects/[id]/invoices/route'
import { GET as invoiceDetailGet } from '@/app/api/v1/invoices/[id]/route'
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

// ---------------------------------------------------------------- payload + verdict fixtures

const PAYLOAD = {
  project: { id: 'p-1', name: 'Nyumba Yangu' },
  phases: [],
  // the payload's invoices slice: InvoiceWithLines rows + supplierName/orderCode flattened
  invoices: {
    invoices: INVOICES.map(({ supplier, order, ...rest }) => ({
      ...rest,
      supplierName: supplier?.businessName ?? null,
      orderCode: order?.orderCode ?? null,
    })),
    ledgerCheck: { consistent: true, drift: 0, breakdown: {}, note: 'not under test here' },
  },
}

const VERDICT_27 = {
  mode: 'three-way', hasOrder: true, hasDelivery: true,
  lines: [
    { name: 'Cement 50kg (32.5N)', poQty: 52, invQty: 50, deliveredQty: 50, feeLine: false },
    { name: 'Ballast (screened)', poQty: 10, invQty: 10, deliveredQty: 10, feeLine: false },
    { name: 'Delivery — Industrial Area to Kitengela', poQty: null, invQty: 1, deliveredQty: null, feeLine: true },
  ],
  mismatches: [
    { name: 'Cement 50kg (32.5N)', po: 52, inv: 50, delivered: 50, issue: 'purchase order has 52, invoice bills 50' },
  ],
  note: '3-way match against PO-2026-000009 — 1 open item(s)',
  invoiceCode: 'INV-2026-000027',
}

const VERDICT_31 = {
  mode: 'three-way', hasOrder: true, hasDelivery: false,
  lines: [
    { name: 'Cement 50kg (32.5N)', poQty: 50, invQty: 50, deliveredQty: null, feeLine: false },
    { name: 'Steel bar Y12 (12m length)', poQty: 10, invQty: 10, deliveredQty: null, feeLine: false },
    { name: 'Delivery — Kiambi Road to Kitengela', poQty: null, invQty: 1, deliveredQty: null, feeLine: true },
  ],
  mismatches: [
    { name: 'Cement 50kg (32.5N)', po: 50, inv: 50, delivered: null, issue: 'no delivery recorded yet — physical counts not verifiable' },
    { name: 'Steel bar Y12 (12m length)', po: 10, inv: 10, delivered: null, issue: 'no delivery recorded yet — physical counts not verifiable' },
  ],
  note: '3-way match against PO-2026-000012 — no delivery recorded yet, counts not verifiable',
  invoiceCode: 'INV-2026-000031',
}

const VERDICT_DEFAULT = {
  mode: 'two-way', hasOrder: false, hasDelivery: false, lines: [], mismatches: [],
  note: 'No purchase order linked — 2-way check (invoice vs project delivery records by name)',
  invoiceCode: 'INV-2026-000000',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  svc.getProjectPayload.mockResolvedValue(PAYLOAD)
  invoiceSvc.threeWayCheck.mockResolvedValue(VERDICT_DEFAULT)
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  vi.useRealTimers()
})

// ---------------------------------------------------------------- invoice list

describe('GET /api/v1/projects/:id/invoices — the lifecycle list', () => {
  const req = (id: string, qs = '') => getReq(`http://localhost/api/v1/projects/${id}/invoices${qs}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — every invoice, deterministic (createdAt DESC, id DESC) order, summary fields', async () => {
    sessionFor('contractor')
    const res = await projectInvoicesGet(req('p-1'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const items = body.data as Array<Record<string, unknown>>
    expect(items.map((i) => i.id)).toEqual(['inv-000031', 'inv-000027', 'inv-000018', 'inv-000012', 'inv-000021'])
    expect(items[1]).toEqual({
      id: 'inv-000027', invoiceCode: 'INV-2026-000027', status: 'approved',
      supplierId: 'sup-2', supplierName: 'Nairobi Hardware Centre',
      orderId: 'po-000009', orderCode: 'PO-2026-000009',
      subtotal: 62_750, tax: 0, total: 62_750, lineCount: 3,
      dueDate: '2026-02-24T12:00:00.000Z', issuedAt: '2026-02-07T11:00:00.000Z',
      submittedAt: '2026-02-08T09:00:00.000Z', decidedAt: '2026-02-09T16:00:00.000Z',
      decidedBy: 'Amina (Client)', paidAt: null, paidByRole: null,
      paymentMethod: null, paymentReference: null,
      createdBy: 'Nairobi Hardware Centre',
      createdAt: '2026-02-07T11:00:00.000Z', updatedAt: '2026-02-09T16:00:00.000Z',
    })
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
  })

  it('?status= filters BEFORE pagination — paid → 1 with its payment refs, disputed → 1', async () => {
    sessionFor('admin')
    const paid = await bodyOf(await projectInvoicesGet(req('p-1', '?status=paid'), ctx('p-1')))
    const paidItems = paid.data as Array<Record<string, unknown>>
    expect(paidItems.length).toBe(1)
    expect(paidItems[0]).toMatchObject({
      id: 'inv-000021', status: 'paid', paymentMethod: 'mpesa', paymentReference: 'MPESA-8HKT4Q2A',
      paidByRole: 'client', paidAt: '2026-01-24T13:00:00.000Z',
    })
    const disputed = await bodyOf(await projectInvoicesGet(req('p-1', '?status=disputed'), ctx('p-1')))
    const disputedItems = disputed.data as Array<Record<string, unknown>>
    expect(disputedItems.length).toBe(1)
    expect(disputedItems[0]).toMatchObject({
      id: 'inv-000018', status: 'disputed', decidedBy: 'Amina (Client)',
    })
  })

  it('an undocumented status value → honest 400 listing the six InvoiceStatus values', async () => {
    sessionFor('contractor')
    const res = await projectInvoicesGet(req('p-1', '?status=void'), ctx('p-1'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/status must be one of draft, submitted, approved, rejected, paid, disputed/)
    expect(body.field).toBe('status')
  })

  it('cursor pagination: limit=2 pages walk all 5 invoices with no overlap', async () => {
    sessionFor('admin')
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const url = `http://localhost/api/v1/projects/p-1/invoices?limit=2${cursor ? `&cursor=${cursor}` : ''}`
      const body = await bodyOf(await projectInvoicesGet(getReq(url), ctx('p-1')))
      seen.push(...(body.data as Array<{ id: string }>).map((i) => i.id))
      pages++
      expect(body.hasMore).toBe(pages < 3)
      cursor = (body.nextCursor as string | null) ?? undefined
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual(['inv-000031', 'inv-000027', 'inv-000018', 'inv-000012', 'inv-000021'])
  })

  it('a stale cursor (fell out of the filtered list) → 400 naming "an invoice"', async () => {
    sessionFor('admin')
    const res = await projectInvoicesGet(req('p-1', '?status=paid&cursor=inv-000031'), ctx('p-1'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/the id of an invoice in this list/)
    expect(body.field).toBe('cursor')
  })

  it('unknown query key → 400 (typo protection, strictObject)', async () => {
    sessionFor('admin')
    const res = await projectInvoicesGet(req('p-1', '?supplier=sup-1'), ctx('p-1'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Unknown field(s): "supplier"' })
  })

  it('scoping: unknown project → 404; foreign client → 403; own client → 200; anonymous → 401', async () => {
    svc.getProjectPayload.mockResolvedValueOnce(null)
    sessionFor('admin')
    expect((await projectInvoicesGet(req('p-x'), ctx('p-x'))).status).toBe(404)

    sessionFor('client', 'p-2')
    const denied = await projectInvoicesGet(req('p-1'), ctx('p-1'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })

    sessionFor('client', 'p-1')
    expect((await projectInvoicesGet(req('p-1'), ctx('p-1'))).status).toBe(200)

    h.session = null
    expect((await projectInvoicesGet(req('p-1'), ctx('p-1'))).status).toBe(401)
  })
})

// ---------------------------------------------------------------- invoice detail

describe('GET /api/v1/invoices/:id — lifecycle + lines + totals + 3-way verdict', () => {
  const req = (id: string) => getReq(`http://localhost/api/v1/invoices/${id}`)
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

  it('200 — resolves by cuid id, full body: lines, totals, refs + the verdict from the module', async () => {
    sessionFor('client', 'p-1')
    invoiceSvc.threeWayCheck.mockResolvedValueOnce(VERDICT_27)
    const res = await invoiceDetailGet(req('inv-000027'), ctx('inv-000027'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.data).toEqual({
      id: 'inv-000027', invoiceCode: 'INV-2026-000027', projectId: 'p-1', status: 'approved',
      supplierId: 'sup-2', supplierName: 'Nairobi Hardware Centre',
      orderId: 'po-000009', orderCode: 'PO-2026-000009',
      subtotal: 62_750, tax: 0, total: 62_750,
      lines: LINES_27.map((l) => ({ ...l })),
      dueDate: '2026-02-24T12:00:00.000Z', issuedAt: '2026-02-07T11:00:00.000Z',
      submittedAt: '2026-02-08T09:00:00.000Z', decidedAt: '2026-02-09T16:00:00.000Z',
      decidedBy: 'Amina (Client)', paidAt: null, paidByRole: null,
      paymentMethod: null, paymentReference: null,
      createdBy: 'Nairobi Hardware Centre',
      note: 'For PO-2026-000009. Approved pending shortfall reconciliation.',
      threeWayMatch: VERDICT_27,
      createdAt: '2026-02-07T11:00:00.000Z', updatedAt: '2026-02-09T16:00:00.000Z',
    })
    // the verdict is the module's own read — same project, same invoice id
    expect(invoiceSvc.threeWayCheck).toHaveBeenCalledWith('p-1', { id: 'inv-000027' })
  })

  it('resolves by human invoiceCode too (INV-2026-000027)', async () => {
    sessionFor('admin')
    invoiceSvc.threeWayCheck.mockResolvedValueOnce(VERDICT_27)
    const res = await invoiceDetailGet(req('INV-2026-000027'), ctx('INV-2026-000027'))
    expect(res.status).toBe(200)
    expect(((await bodyOf(res)).data as { id: string }).id).toBe('inv-000027')
  })

  it('the verdict carries open review items + the honest no-delivery note (never a silent pass)', async () => {
    sessionFor('client', 'p-1')
    invoiceSvc.threeWayCheck.mockResolvedValueOnce(VERDICT_31)
    const body = await bodyOf(await invoiceDetailGet(req('inv-000031'), ctx('inv-000031')))
    const verdict = (body.data as { threeWayMatch: typeof VERDICT_31 }).threeWayMatch
    expect(verdict.mode).toBe('three-way')
    expect(verdict.hasDelivery).toBe(false)
    expect(verdict.mismatches.length).toBe(2)
    expect(verdict.mismatches[0].issue).toMatch(/no delivery recorded yet/)
    expect(verdict.note).toMatch(/counts not verifiable/)
  })

  it('a PAID invoice carries its payment refs exactly as stored', async () => {
    sessionFor('admin')
    const data = (await bodyOf(await invoiceDetailGet(req('inv-000021'), ctx('inv-000021')))).data as Record<string, unknown>
    expect(data).toMatchObject({
      status: 'paid', paidAt: '2026-01-24T13:00:00.000Z', paidByRole: 'client',
      paymentMethod: 'mpesa', paymentReference: 'MPESA-8HKT4Q2A',
    })
  })

  it('a DISPUTED invoice is represented honestly — status + decision fields, nothing invented', async () => {
    sessionFor('admin')
    const data = (await bodyOf(await invoiceDetailGet(req('inv-000018'), ctx('inv-000018')))).data as Record<string, unknown>
    expect(data).toMatchObject({
      status: 'disputed', decidedBy: 'Amina (Client)',
      decidedAt: '2026-02-05T10:00:00.000Z',
      note: 'Qty delivered (4) does not match the invoice (6) — reconcile before re-approval.',
      paidAt: null, paymentMethod: null, paymentReference: null,
    })
  })

  it('a DRAFT invoice shows the not-yet-submitted state (nulls, not zeros)', async () => {
    sessionFor('contractor')
    const data = (await bodyOf(await invoiceDetailGet(req('inv-000012'), ctx('inv-000012')))).data as Record<string, unknown>
    expect(data).toMatchObject({
      status: 'draft', submittedAt: null, decidedAt: null, dueDate: null,
      supplierName: null, orderCode: null,
    })
  })

  it('the 404 mapping: unknown invoice → 404; a service "not found in this project" maps to 404 too', async () => {
    sessionFor('admin')
    const missing = await invoiceDetailGet(req('inv-99999999'), ctx('inv-99999999'))
    expect(missing.status).toBe(404)
    expect(await bodyOf(missing)).toEqual({ error: 'Invoice not found' })

    // the invoices module's own message family — NOT_FOUND_MESSAGES (respond.ts)
    invoiceSvc.threeWayCheck.mockRejectedValueOnce(new Error('Invoice not found in this project'))
    const vanished = await invoiceDetailGet(req('inv-000012'), ctx('inv-000012'))
    expect(vanished.status).toBe(404)
    expect(await bodyOf(vanished)).toEqual({ error: 'Invoice not found in this project' })
  })

  it('a business-rule message from the service maps to 400 (never a masquerading 404)', async () => {
    sessionFor('admin')
    invoiceSvc.threeWayCheck.mockRejectedValueOnce(new Error('Some honest business rule'))
    const res = await invoiceDetailGet(req('inv-000012'), ctx('inv-000012'))
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ error: 'Some honest business rule' })
  })

  it('scoping: foreign client → 403 (resolve-first, pin-second); anonymous → 401', async () => {
    sessionFor('client', 'p-2')
    const denied = await invoiceDetailGet(req('inv-000027'), ctx('inv-000027'))
    expect(denied.status).toBe(403)
    expect(await bodyOf(denied)).toEqual({ error: 'Not permitted for this project' })
    // the verdict is NEVER computed for a denied probe
    expect(invoiceSvc.threeWayCheck).not.toHaveBeenCalled()

    h.session = null
    expect((await invoiceDetailGet(req('inv-000027'), ctx('inv-000027'))).status).toBe(401)
  })

  it('a malformed :id (1 char) → 400 field "id"; unknown query key → 400', async () => {
    sessionFor('admin')
    const res = await invoiceDetailGet(req('x'), ctx('x'))
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toMatch(/invoice reference must be 2-40 characters/)
    expect(body.field).toBe('id')

    const bad = await invoiceDetailGet(getReq('http://localhost/api/v1/invoices/inv-000027?projectId=p-1'), ctx('inv-000027'))
    expect(bad.status).toBe(400)
    expect(await bodyOf(bad)).toEqual({ error: 'Unknown field(s): "projectId"' })
  })
})

// ---------------------------------------------------------------- no flag gate

describe('no feature flag gates the invoice reads', () => {
  it('every flag forced OFF (marketplace included) + contractor → both routes still answer 200', async () => {
    process.env.NEXT_FLAGS_OFF = 'ai_progress,ai_voice,wallet,marketplace,land_verification'
    invalidateFlagCache()
    sessionFor('contractor')
    const list = await projectInvoicesGet(getReq('http://localhost/api/v1/projects/p-1/invoices'), { params: Promise.resolve({ id: 'p-1' }) })
    expect(list.status).toBe(200)
    const detail = await invoiceDetailGet(getReq('http://localhost/api/v1/invoices/inv-000031'), { params: Promise.resolve({ id: 'inv-000031' }) })
    expect(detail.status).toBe(200)
  })
})

// ---------------------------------------------------------------- rate limit

describe('GET /api/v1/projects/:id/invoices — rate limit (120/min per principal)', () => {
  it('the 121st call within the window → 429 with Retry-After', async () => {
    // Fake timers freeze Date.now() so the continuous token refill cannot
    // mask the exhaustion (120 tokens at 120/min = 500ms per token).
    vi.useFakeTimers({ now: new Date('2026-02-14T10:00:00Z') })
    try {
      sessionFor('contractor')
      const withIp = () => getReq('http://localhost/api/v1/projects/p-1/invoices', { 'x-forwarded-for': '10.99.0.2' })
      const ctxP1 = { params: Promise.resolve({ id: 'p-1' }) }
      for (let i = 0; i < 120; i++) {
        const res = await projectInvoicesGet(withIp(), ctxP1)
        expect(res.status, `request ${i + 1} should pass`).toBe(200)
      }
      const blocked = await projectInvoicesGet(withIp(), ctxP1)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
      expect(await bodyOf(blocked)).toMatchObject({ error: 'Too many requests' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------- OpenAPI

describe('GET /api/openapi.json — Phase C invoice paths + verdict notes', () => {
  it('the two invoice paths exist with matching operationIds and the invoices tag', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    expect(doc.paths['/api/v1/projects/{id}/invoices'].get.operationId).toBe('listProjectInvoices')
    expect(doc.paths['/api/v1/invoices/{id}'].get.operationId).toBe('getInvoice')
    expect(doc.paths['/api/v1/projects/{id}/invoices'].get.tags).toEqual(['invoices'])
    expect(doc.paths['/api/v1/invoices/{id}'].get.tags).toEqual(['invoices'])
  })

  it('the detail documents the 3-way-match verdict (warn-only, warn language) field-for-field', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    const detail = doc.components.schemas.InvoiceDetail
    expect(detail.required).toContain('threeWayMatch')
    expect(detail.properties.threeWayMatch).toEqual(doc.components.schemas.ThreeWayMatch)
    expect(doc.components.schemas.ThreeWayMatch.description).toMatch(/WARN-ONLY/i)
    // the path description points at the module's own check + mutations on /api/actions
    expect(doc.paths['/api/v1/invoices/{id}'].get.description).toMatch(/threeWayCheck/)
    expect(doc.paths['/api/v1/invoices/{id}'].get.description).toMatch(/POST \/api\/actions/)
  })

  it('the lifecycle statuses (incl. disputed and paid) are documented on the summary schema', async () => {
    const doc = (await (await openapiGet()).json()) as Record<string, any>
    expect(doc.components.schemas.InvoiceSummary.properties.status.enum).toEqual([
      'draft', 'submitted', 'approved', 'rejected', 'paid', 'disputed',
    ])
  })

  it('SDK ROUND-TRIP: the documented required fields are exactly the response fields (no drift, no leaks)', async () => {
    sessionFor('contractor')
    invoiceSvc.threeWayCheck.mockResolvedValueOnce(VERDICT_27)
    const doc = (await (await openapiGet()).json()) as Record<string, any>

    // list item ↔ InvoiceSummary
    const listBody = await bodyOf(
      await projectInvoicesGet(getReq('http://localhost/api/v1/projects/p-1/invoices'), { params: Promise.resolve({ id: 'p-1' }) }),
    )
    const item = (listBody.data as Array<Record<string, unknown>>)[0]
    const summary = doc.components.schemas.InvoiceSummary as { required: string[]; properties: Record<string, unknown> }
    for (const key of summary.required) expect(item, `InvoiceSummary.${key}`).toHaveProperty(key)
    for (const key of Object.keys(item)) expect(summary.properties, `undocumented list key "${key}"`).toHaveProperty(key)

    // detail ↔ InvoiceDetail (incl. lines + the threeWayMatch verdict object)
    const detail = (await bodyOf(
      await invoiceDetailGet(getReq('http://localhost/api/v1/invoices/inv-000027'), { params: Promise.resolve({ id: 'inv-000027' }) }),
    )).data as Record<string, unknown>
    const detailSchema = doc.components.schemas.InvoiceDetail as { required: string[]; properties: Record<string, unknown> }
    for (const key of detailSchema.required) expect(detail, `InvoiceDetail.${key}`).toHaveProperty(key)
    for (const key of Object.keys(detail)) expect(detailSchema.properties, `undocumented detail key "${key}"`).toHaveProperty(key)

    const line = (detail.lines as Array<Record<string, unknown>>)[0]
    const lineSchema = (detailSchema.properties.lines as { items: { required: string[]; properties: Record<string, unknown> } }).items
    for (const key of lineSchema.required) expect(line, `InvoiceDetail.lines[].${key}`).toHaveProperty(key)
    for (const key of Object.keys(line)) expect(lineSchema.properties, `undocumented line key "${key}"`).toHaveProperty(key)

    const verdict = detail.threeWayMatch as Record<string, unknown>
    const verdictSchema = doc.components.schemas.ThreeWayMatch as { required: string[]; properties: Record<string, unknown> }
    for (const key of verdictSchema.required) expect(verdict, `ThreeWayMatch.${key}`).toHaveProperty(key)
    for (const key of Object.keys(verdict)) expect(verdictSchema.properties, `undocumented verdict key "${key}"`).toHaveProperty(key)

    const mismatch = (verdict.mismatches as Array<Record<string, unknown>>)[0]
    const mismatchSchema = (verdictSchema.properties.mismatches as { items: { required: string[]; properties: Record<string, unknown> } }).items
    for (const key of mismatchSchema.required) expect(mismatch, `ThreeWayMatch.mismatches[].${key}`).toHaveProperty(key)
    for (const key of Object.keys(mismatch)) expect(mismatchSchema.properties, `undocumented mismatch key "${key}"`).toHaveProperty(key)
  })
})
