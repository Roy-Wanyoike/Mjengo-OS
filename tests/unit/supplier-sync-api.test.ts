/**
 * #128 — the SUPPLIER-scoped half of POST /api/sync, pinned on the REAL route
 * (same conventions as outbox-versions.test.ts: @/backend/lib/db swapped for
 * an in-memory stub, route-kit's route() a pass-through — here with a
 * MUTABLE session so supplier/contractor sessions can be swapped per test —
 * and mjengo's payload loaders stubbed while applyAction stays REAL, so the
 * full chain route → session stamp → assertSupplierScope → supply appliers
 → audit runs exactly as in production).
 *
 * The authz contract (the supply-side mirror of the client pin):
 *   · a supplier session drains ONLY SUPPLIER_ACTIONS — a buyer type fails
 *     per-item with the role refusal and the batch continues;
 *   · every id is pinned to the session's OWN supplier link (assertSupplierScope
 *     inside applyAction — the same server-enforced guard /api/actions uses);
 *     a foreign id answers with the exact miss-error, never foreign data;
 *   · the session stamps __role 'supplier' + __supplierId from the SESSION —
 *     payload copies (a forged __supplierId / __actor) are overwritten;
 *   · §57 idempotency: a re-flushed item id short-circuits ok without
 *     re-applying; a NEW id against already-moved state fails with the
 *     applier's honest message;
 *   · the response NEVER carries buyer payloads (data null, projects []) —
 *     the portal re-reads GET /api/supplier (the /api/actions posture);
 *   · a supplier account with no linked supplier drains nothing (403);
 *   · the owner (contractor) path is unchanged — the supplier branch did not
 *     break the site team's flush of the same action family.
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The mutable route session: tests swap between the supplier and contractor
// postures (vi.hoisted — the route-kit mock factory closes over this).
const sessionHolder = vi.hoisted(() => ({
  session: {
    user: {
      id: 'u-sup', email: 'amani@test.dev', name: 'Amani Suppliers',
      role: 'supplier', projectId: null, supplierId: 'sup-1',
    },
  },
}))

vi.mock('@/backend/modules/wallet/session', () => ({
  currentActor: vi.fn(async () => ({ role: 'contractor', name: 'Foreman' })),
}))

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    requests: new Map<string, Row>(),
    requestLines: [] as Row[],
    quotes: new Map<string, Row>(),
    quoteLines: [] as Row[],
    orders: new Map<string, Row>(),
    orderLines: [] as Row[],
    orderDeliveries: [] as Row[],
    catalogItems: new Map<string, Row>(),
    suppliers: new Map<string, Row>(),
    idempotency: new Map<string, Row>(),
    auditEvents: [] as Row[],
    notifications: [] as Row[],
    reset() {
      state.seq = 0
      state.projects.clear()
      state.requests.clear()
      state.requestLines = []
      state.quotes.clear()
      state.quoteLines = []
      state.orders.clear()
      state.orderLines = []
      state.orderDeliveries = []
      state.catalogItems.clear()
      state.suppliers.clear()
      state.idempotency.clear()
      state.auditEvents = []
      state.notifications = []
    },
  }

  /** Just enough of Prisma's where for the supplier sync path (equality + the request relation filter). */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'request') {
        const request = state.requests.get(row.requestId as string)
        if (!request || !matches(request, cond as Row)) return false
        continue
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: Row }) { return state.projects.get(String(where.id)) ?? null },
      async findFirst() { return [...state.projects.values()][0] ?? null },
    },
    featureFlag: {
      // The marketplace flag defaults ON — upsert/findMany no-ops keep it so.
      async upsert() { return {} },
      async findMany() { return [] },
    },
    quote: {
      async findFirst({ where, select }: { where: Row; select?: Row }) {
        const row = [...state.quotes.values()].find((r) => matches(r, where)) ?? null
        if (!row) return null
        const request = state.requests.get(row.requestId as string) ?? null
        const full = {
          ...row,
          request: request
            ? { ...request, lines: state.requestLines.filter((l) => l.requestId === request.id).map((l) => ({ ...l })) }
            : undefined,
          supplier: state.suppliers.get(row.supplierId as string) ?? undefined,
        }
        if (select) {
          const out: Row = {}
          for (const k of Object.keys(select)) out[k] = full[k]
          return out
        }
        return full
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = state.quotes.get(String(where.id))
        if (!row) throw new Error(`stub: quote ${String(where.id)} not found`)
        Object.assign(row, data)
        return { ...row }
      },
    },
    quoteLine: {
      async deleteMany({ where }: { where: Row }) {
        const before = state.quoteLines.length
        state.quoteLines = state.quoteLines.filter((l) => !matches(l, where))
        return { count: before - state.quoteLines.length }
      },
      async createMany({ data }: { data: Row[] }) {
        for (const d of data) state.quoteLines.push({ id: `ql_${++state.seq}`, ...d })
        return { count: data.length }
      },
    },
    purchaseOrder: {
      async findFirst({ where }: { where: Row }) {
        const row = [...state.orders.values()].find((r) => matches(r, where)) ?? null
        if (!row) return null
        return {
          ...row,
          lines: state.orderLines.filter((l) => l.orderId === row.id).map((l) => ({ ...l })),
          supplier: state.suppliers.get(row.supplierId as string) ?? undefined,
          request: state.requests.get((row.requestId as string) ?? '') ?? undefined,
          deliveries: state.orderDeliveries.filter((d) => d.orderId === row.id).map((d) => ({ ...d })),
        }
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = state.orders.get(String(where.id))
        if (!row) throw new Error(`stub: order ${String(where.id)} not found`)
        Object.assign(row, data)
        return { ...row }
      },
    },
    orderDelivery: {
      async findFirst({ where }: { where: Row }) {
        return state.orderDeliveries.find((d) => matches(d, where)) ?? null
      },
      async create({ data }: { data: Row }) {
        const row = { id: `od_${++state.seq}`, ...data }
        state.orderDeliveries.push(row)
        return { ...row }
      },
    },
    catalogItem: {
      async findUnique({ where }: { where: Row }) { return state.catalogItems.get(String(where.id)) ?? null },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = state.catalogItems.get(String(where.id))
        if (!row) throw new Error(`stub: catalog item ${String(where.id)} not found`)
        Object.assign(row, data)
        return { ...row }
      },
      async create({ data }: { data: Row }) {
        const row = { id: `ci_${++state.seq}`, ...data }
        state.catalogItems.set(String(row.id), row)
        return { ...row }
      },
    },
    supplier: {
      async findUnique({ where }: { where: Row }) { return state.suppliers.get(String(where.id)) ?? null },
    },
    idempotencyRecord: {
      async findUnique({ where }: { where: Row }) { return state.idempotency.get(String(where.key)) ?? null },
      async create({ data }: { data: Row }) {
        const row = { id: `idem_${++state.seq}`, ...data }
        state.idempotency.set(String(row.key), row)
        return { ...row }
      },
    },
    auditEvent: {
      async create({ data }: { data: Row }) {
        const row = { id: `audit_${++state.seq}`, ...data }
        state.auditEvents.push(row)
        return { ...row }
      },
    },
    notification: {
      async create({ data }: { data: Row }) {
        const row = { id: `ntf_${++state.seq}`, ...data }
        state.notifications.push(row)
        return { ...row }
      },
      async findMany() { return state.notifications.map((n) => ({ ...n })) },
    },
  }
  return { db }
})

vi.mock('@/backend/lib/route-kit', () => ({
  // Pass-through: parse the JSON body, hand the handler the CURRENT holder
  // session (the guard + rate-limit contracts are pinned elsewhere).
  route: (
    _opts: unknown,
    handler: (req: Request, session: unknown, body: unknown, ctx?: unknown) => Promise<Response>,
  ) =>
    async (req: Request, ctx?: unknown): Promise<Response> => {
      let body: unknown
      try { body = await req.json() } catch { body = undefined }
      return handler(req, sessionHolder.session, body, ctx)
    },
  genericError: () => async () => new Response(JSON.stringify({ error: 'Sync failed' }), { status: 500 }),
}))

vi.mock('@/backend/lib/mjengo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/lib/mjengo')>()
  return {
    ...actual,
    // The payload refresh is out of scope for the supplier contract (the
    // supplier response carries data:null/projects:[]); applyAction stays REAL.
    getProjectPayload: async () => null,
    getProjectsList: async () => [],
  }
})

import { db } from '@/backend/lib/db'
import { POST } from '@/app/api/sync/route'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    projects: Map<string, Record<string, unknown>>
    requests: Map<string, Record<string, unknown>>
    requestLines: Record<string, unknown>[]
    quotes: Map<string, Record<string, unknown>>
    orders: Map<string, Record<string, unknown>>
    orderLines: Record<string, unknown>[]
    orderDeliveries: Record<string, unknown>[]
    catalogItems: Map<string, Record<string, unknown>>
    suppliers: Map<string, Record<string, unknown>>
    idempotency: Map<string, Record<string, unknown>>
    auditEvents: Record<string, unknown>[]
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

interface Queued {
  id: string
  type: string
  payload: Record<string, unknown>
  projectId: string
  force?: boolean
}

function syncReq(actions: Queued[]): NextRequest {
  return new NextRequest('http://localhost/api/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actions }),
  })
}

async function flush(actions: Queued[]): Promise<Record<string, any>> {
  const res = await POST(syncReq(actions), undefined)
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, any>
}

const supplierSession = () => ({
  user: { id: 'u-sup', email: 'amani@test.dev', name: 'Amani Suppliers', role: 'supplier', projectId: null, supplierId: 'sup-1' },
})
const contractorSession = () => ({
  user: { id: 'u-con', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null, supplierId: null },
})

beforeEach(() => {
  state.reset()
  sessionHolder.session = supplierSession()
  state.projects.set('proj-1', { id: 'proj-1', name: 'Test Build', client: 'Client', createdAt: new Date('2026-01-01') })
  state.suppliers.set('sup-1', { id: 'sup-1', businessName: 'Amani Suppliers', county: 'Nairobi' })
  state.suppliers.set('sup-2', { id: 'sup-2', businessName: 'Pwani Hardware', county: 'Mombasa' })
  state.requests.set('req-1', { id: 'req-1', projectId: 'proj-1', requestCode: 'MR-1001', status: 'approved' })
  state.requestLines.push({ id: 'rl-1', requestId: 'req-1', materialName: 'Cement', unit: 'bag', qty: 100 })
  state.quotes.set('q_own', {
    id: 'q_own', requestId: 'req-1', supplierId: 'sup-1', status: 'requested',
    unitPrice: 0n, deliveryFee: 0n, transportFee: 0n, fees: 0n, totalLanded: 0n,
    deliveryEta: null, stockOk: true, validUntil: null, terms: null,
  })
  state.quotes.set('q_foreign', {
    id: 'q_foreign', requestId: 'req-1', supplierId: 'sup-2', status: 'requested',
    unitPrice: 0n, deliveryFee: 0n, transportFee: 0n, fees: 0n, totalLanded: 0n,
    deliveryEta: null, stockOk: true, validUntil: null, terms: null,
  })
  state.orders.set('po_own', {
    id: 'po_own', projectId: 'proj-1', requestId: 'req-1', supplierId: 'sup-1',
    orderCode: 'PO-2026-000001', status: 'sent', total: 5_000_000n, note: null,
  })
  state.orderLines.push({ id: 'pol-1', orderId: 'po_own', name: 'Cement', unit: 'bag', qty: 100, unitPrice: 12_000n, lineTotal: 1_200_000n })
  state.orders.set('po_foreign', {
    id: 'po_foreign', projectId: 'proj-1', requestId: 'req-1', supplierId: 'sup-2',
    orderCode: 'PO-2026-000002', status: 'sent', total: 1_000_000n, note: null,
  })
  state.catalogItems.set('c_own', { id: 'c_own', supplierId: 'sup-1', name: 'Cement', unit: 'bag', unitPrice: 75_000n, stockQty: 50, minOrderQty: 1 })
  state.catalogItems.set('c_foreign', { id: 'c_foreign', supplierId: 'sup-2', name: 'Steel', unit: 'rod', unitPrice: 90_000n, stockQty: 10, minOrderQty: 1 })
})

const quoteRow = (id: string) => state.quotes.get(id) as Record<string, unknown>
const orderRow = (id: string) => state.orders.get(id) as Record<string, unknown>

// ---------------- the allowlist + apply ----------------

describe('POST /api/sync (supplier session) — allowlist, apply, idempotency', () => {
  it('quote.receive applies to the supplier\'s OWN quote, records §57 idempotency, and the response carries NO buyer payload', async () => {
    const json = await flush([{
      id: 'sq-1', type: 'quote.receive',
      payload: { id: 'q_own', unitPrice: 120, deliveryFee: 500 },
      projectId: 'proj-1',
    }])

    expect(json.ok).toBe(true)
    expect(json.results[0]).toMatchObject({ id: 'sq-1', ok: true })
    expect(json.synced).toBe(1)
    // The quote landed: KSh payload → integer-cents rows (#122 discipline).
    expect(quoteRow('q_own')).toMatchObject({ status: 'received', unitPrice: 12_000n, deliveryFee: 50_000n })
    // §57: the item id is recorded once applied.
    expect(state.idempotency.get('sync:proj-1:sq-1')).toBeDefined()
    // The audit actor is the SESSION identity.
    expect(state.auditEvents).toHaveLength(1)
    expect(state.auditEvents[0]).toMatchObject({ actor: 'Amani Suppliers', role: 'supplier' })
    // #128: a supplier response NEVER carries buyer payloads.
    expect(json.data).toBeNull()
    expect(json.projects).toEqual([])
  })

  it('a buyer type in the batch fails per-item with the role refusal — the supplier item beside it still applies', async () => {
    const json = await flush([
      { id: 'sq-1', type: 'task.complete', payload: { id: 't-1' }, projectId: 'proj-1' },
      { id: 'sq-2', type: 'quote.decline', payload: { id: 'q_own', reason: 'Out of stock' }, projectId: 'proj-1' },
    ])

    expect(json.results[0]).toEqual({ id: 'sq-1', ok: false, error: 'Not permitted for role "supplier"' })
    expect(json.results[1]).toMatchObject({ id: 'sq-2', ok: true })
    expect(quoteRow('q_own')).toMatchObject({ status: 'declined' }) // the batch continued
    expect(state.idempotency.get('sync:proj-1:sq-1')).toBeUndefined() // nothing was written for the refusal
  })

  it('§57 idempotency: a re-flushed item id short-circuits ok without re-applying', async () => {
    await flush([{ id: 'sq-1', type: 'quote.receive', payload: { id: 'q_own', unitPrice: 120 }, projectId: 'proj-1' }])
    expect(state.auditEvents).toHaveLength(1)

    // The same item id flushes again (double tap / retry after a timeout).
    const json = await flush([{ id: 'sq-1', type: 'quote.receive', payload: { id: 'q_own', unitPrice: 999 }, projectId: 'proj-1' }])

    expect(json.results[0]).toMatchObject({ id: 'sq-1', ok: true })
    expect(quoteRow('q_own').unitPrice).toBe(12_000n) // the first apply stands — no double-apply
    expect(state.auditEvents).toHaveLength(1)
  })

  it('a NEW item id against already-moved state fails with the applier\'s honest message (no silent drop, no double-apply)', async () => {
    await flush([{ id: 'sq-1', type: 'quote.receive', payload: { id: 'q_own', unitPrice: 120 }, projectId: 'proj-1' }])

    const json = await flush([{ id: 'sq-2', type: 'quote.receive', payload: { id: 'q_own', unitPrice: 130 }, projectId: 'proj-1' }])

    expect(json.results[0]).toEqual({ id: 'sq-2', ok: false, error: 'Quote is already RECEIVED' })
    expect(quoteRow('q_own').unitPrice).toBe(12_000n)
    expect(state.idempotency.get('sync:proj-1:sq-2')).toBeUndefined() // nothing applied → re-flush is still possible
  })
})

// ---------------- the row pin (assertSupplierScope through the REAL applyAction) ----------------

describe('POST /api/sync (supplier session) — every id is pinned to the session\'s own rows', () => {
  it('a FOREIGN quote answers the exact miss-error and writes nothing', async () => {
    const json = await flush([{
      id: 'sq-1', type: 'quote.receive',
      payload: { id: 'q_foreign', unitPrice: 120 },
      projectId: 'proj-1',
    }])

    expect(json.results[0]).toEqual({ id: 'sq-1', ok: false, error: 'Quote not found in this project' })
    expect(quoteRow('q_foreign')).toMatchObject({ status: 'requested' }) // untouched
    expect(state.idempotency.get('sync:proj-1:sq-1')).toBeUndefined()
    expect(state.auditEvents).toHaveLength(0)
  })

  it('order.confirm applies to the own SENT order; a foreign order is a miss', async () => {
    const json = await flush([
      { id: 'sq-1', type: 'order.confirm', payload: { id: 'po_own' }, projectId: 'proj-1' },
      { id: 'sq-2', type: 'order.confirm', payload: { id: 'po_foreign' }, projectId: 'proj-1' },
    ])

    expect(json.results[0]).toMatchObject({ id: 'sq-1', ok: true })
    expect(orderRow('po_own')).toMatchObject({ status: 'confirmed' })
    expect(json.results[1]).toEqual({ id: 'sq-2', ok: false, error: 'Purchase order not found in this project' })
    expect(orderRow('po_foreign')).toMatchObject({ status: 'sent' })
  })

  it('order.dispatch writes the SAME OrderDelivery row the buyer path writes', async () => {
    orderRow('po_own').status = 'confirmed'

    const json = await flush([{ id: 'sq-1', type: 'order.dispatch', payload: { orderId: 'po_own' }, projectId: 'proj-1' }])

    expect(json.results[0]).toMatchObject({ id: 'sq-1', ok: true })
    expect(orderRow('po_own')).toMatchObject({ status: 'delivering' })
    expect(state.orderDeliveries).toHaveLength(1)
    expect(state.orderDeliveries[0]).toMatchObject({ orderId: 'po_own', status: 'dispatched' })
  })

  it('catalog.upsert: the payload supplierId copy is IGNORED — the session pin wins; a foreign item id is a miss', async () => {
    const json = await flush([
      {
        id: 'sq-1', type: 'catalog.upsert',
        // A forged supplierId copy naming ANOTHER supplier…
        payload: { supplierId: 'sup-2', id: 'c_own', name: 'Cement', unit: 'bag', unitPrice: 800, stockQty: 60 },
        projectId: 'proj-1',
      },
      {
        id: 'sq-2', type: 'catalog.upsert',
        // …and a foreign item id.
        payload: { supplierId: 'sup-1', id: 'c_foreign', unitPrice: 100 },
        projectId: 'proj-1',
      },
    ])

    expect(json.results[0]).toMatchObject({ id: 'sq-1', ok: true })
    const own = state.catalogItems.get('c_own') as Record<string, unknown>
    expect(own.unitPrice).toBe(80_000n) // KSh → cents
    expect(own.supplierId).toBe('sup-1') // the TENANT PIN forced the session supplier
    expect(json.results[1]).toEqual({ id: 'sq-2', ok: false, error: 'Catalog item not found' })
    expect((state.catalogItems.get('c_foreign') as Record<string, unknown>).unitPrice).toBe(90_000n) // untouched
  })

  it('forged __supplierId/__actor/__role payload copies are overwritten by the SESSION stamps', async () => {
    const json = await flush([{
      id: 'sq-1', type: 'quote.receive',
      payload: {
        id: 'q_own', unitPrice: 120,
        __supplierId: 'sup-2', __actor: 'Mallory', __role: 'contractor',
      },
      projectId: 'proj-1',
    }])

    // The quote belongs to sup-1: had the forged __supplierId been trusted,
    // assertSupplierScope would have refused it as a foreign row.
    expect(json.results[0]).toMatchObject({ id: 'sq-1', ok: true })
    expect(quoteRow('q_own')).toMatchObject({ status: 'received' })
    // The audit actor is the SESSION name — the payload copy never lands.
    expect(state.auditEvents[0]).toMatchObject({ actor: 'Amani Suppliers', role: 'supplier' })
  })
})

// ---------------- the unlinked-supplier + owner-path boundaries ----------------

describe('POST /api/sync (supplier session) — fail-closed boundaries', () => {
  it('a supplier account with NO linked supplier drains nothing (403, the /api/actions posture)', async () => {
    sessionHolder.session = {
      user: { id: 'u-sup', email: 'sup@test.dev', name: 'Unlinked', role: 'supplier', projectId: null, supplierId: null },
    }

    const res = await POST(syncReq([{ id: 'sq-1', type: 'quote.receive', payload: { id: 'q_own', unitPrice: 120 }, projectId: 'proj-1' }]), undefined)

    expect(res.status).toBe(403)
    const json = (await res.json()) as { error?: string }
    expect(json.error).toBe('Supplier account has no supplier linked')
    expect(quoteRow('q_own')).toMatchObject({ status: 'requested' }) // nothing applied
    expect(state.auditEvents).toHaveLength(0)
  })

  it('the OWNER path is unchanged: a contractor session flushes the same supply family without a supplier pin', async () => {
    sessionHolder.session = contractorSession()

    const json = await flush([{ id: 'oq-1', type: 'quote.receive', payload: { id: 'q_own', unitPrice: 120 }, projectId: 'proj-1' }])

    expect(json.results[0]).toMatchObject({ id: 'oq-1', ok: true })
    expect(quoteRow('q_own')).toMatchObject({ status: 'received' })
    expect(state.auditEvents[0]).toMatchObject({ actor: 'Foreman', role: 'contractor' })
  })
})
