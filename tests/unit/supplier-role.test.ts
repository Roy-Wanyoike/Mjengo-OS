/**
 * W5-3 — the supplier-side portal's server-enforced scoping (the marketplace
 * promise gap: suppliers were rows, now they are users).
 *
 * THE CONTRACT (mirrors the client-role tenant pin, deliberately — every
 * client-pinning test idiom has a supplier twin here):
 *   · SESSION SHAPING: the supplier link (User.supplierId) is stamped onto
 *     the JWT/session exactly like the client's projectId (auth.ts callbacks)
 *     and re-read by guard.ts; sessionSupplierId is the pin EVERY route
 *     trusts (payload copies are never trusted).
 *   · ALLOWLIST: a supplier session may dispatch exactly SUPPLIER_ACTIONS
 *     through POST /api/actions (403 otherwise) — and lib/mjengo.applyAction
 *     re-checks it server-side (modules/supply/supplier-scope.ts) so no entry
 *     route can bypass. POST /api/sync 403s suppliers outright (no outbox).
 *   · ROW PIN: every id a supplier touches must resolve to a row whose
 *     supplierId is THEIRS — a foreign id answers with the EXACT single-line
 *     domain error an unknown id produces (indistinguishable from a miss);
 *     a supplier stamp with no link fails closed ('no supplier linked').
 *   · BUYER SURFACE CLOSED: suppliers never read the project/portfolio
 *     payloads (403 on /api/project before the share-token path; empty list
 *     on /api/projects; uniform 403 on the v1 project-scoped reads) — their
 *     read surface is GET /api/supplier, where the WHERE clause itself is
 *     the scoping (their catalog/quotes/orders/invoices only, cross-project).
 *   · DELIVERY-CONFIRM: order.dispatch by a supplier writes the SAME
 *     OrderDelivery rows the buyer path writes, with the audit row stamped
 *     role 'supplier' (the Bias-Free Ledger says the SUPPLIER acted).
 *   · MIGRATION additive-only, seed demo login, README demo row, en/sw keys.
 *
 * Mocks (the flags-gating / whatsapp-route idioms): '@/backend/lib/db' is an
 * in-memory stub (rows + write tracking); '@/backend/lib/guard' is the full
 * fake (session control, mirrors guard.ts 1:1 incl. sessionSupplierId);
 * '@/backend/lib/mjengo' keeps applyAction REAL (importOriginal) and stubs
 * only the getProjectPayload / getProjectsList read seams;
 * '@/backend/modules/supply/repository' (loadSupplySlice) is controlled for
 * the v1 supply reads. route-kit, rate-limit, flags, the audit AsyncLocalStorage
 * and every route under test stay REAL. Unique session emails keep the
 * in-process rate limiter out of the way.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string; role: string; projectId: string | null; supplierId: string | null }
  },
}))

// ---------------------------------------------------------------- db stub

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>
  const d = (iso: string) => new Date(iso)

  const SUP1 = { id: 'sup-1', businessName: 'Nairobi Hardware Centre', county: 'Nairobi', town: 'Nairobi', phone: '+254700000001', email: 'sales@nairobihardware.example', deliveryFeeBase: 2500, createdAt: d('2026-01-02T09:00:00Z') }
  const SUP2 = { id: 'sup-2', businessName: 'Karioke Hardware', county: 'Kiambu', town: 'Ruiru', phone: '+254700000002', email: 'sales@karioke.example', deliveryFeeBase: 1500, createdAt: d('2026-01-03T09:00:00Z') }

  const P1 = { id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', clientType: 'diaspora', location: 'Karen', status: 'active', budget: 2_000_000, shareToken: 'tok-1', startDate: d('2026-01-05T09:00:00Z'), createdAt: d('2026-01-04T09:00:00Z') }
  const P2 = { id: 'p-2', name: 'Westlands Duplex', client: 'Baba Otieno', clientType: 'local', location: 'Westlands', status: 'active', budget: 3_500_000, shareToken: 'tok-2', startDate: d('2026-02-01T09:00:00Z'), createdAt: d('2026-01-20T09:00:00Z') }

  const state = {
    flagRows: [
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
      { key: 'ai_voice', enabled: true, description: 'AI voice' },
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
    ],
    audits: [] as Row[],
    deliveries: [] as Row[],
    catalogCreated: [] as Row[],
    idemRows: [] as Row[],
    /** The where-clause the last notification.findMany rode (BE-3 pins). */
    lastNotifWhere: undefined as Row | undefined,
    /** Call counters — the "zero reads/writes" pins. searchScans counts the
     *  /api/search fan-out (all ten source tables); notificationFindMany /
     *  jobRecordFindMany count the BE-3 GET routes' reads. */
    calls: {
      purchaseOrderFindFirst: 0, quoteFindFirst: 0, catalogFindUnique: 0,
      searchScans: 0, notificationFindMany: 0, jobRecordFindMany: 0,
    },
    reset() {
      state.audits = []
      state.deliveries = []
      state.catalogCreated = []
      state.idemRows = [
        // A previously-recorded supplier replay (drives the replay-shape pin).
        { key: 'sup-replay-1', scope: 'order.dispatch', projectId: 'p-1', responseBody: '{"id":"po-1","status":"delivering","orderCode":"PO-2026-000013"}' },
      ]
      state.lastNotifWhere = undefined
      state.calls = {
        purchaseOrderFindFirst: 0, quoteFindFirst: 0, catalogFindUnique: 0,
        searchScans: 0, notificationFindMany: 0, jobRecordFindMany: 0,
      }
      seed()
    },
  }

  // ---- denormalized rows (relations carried inline, the v1-supply idiom) ----
  const REQUEST1 = {
    id: 'mr-1', requestCode: 'MR-2026-000003', projectId: 'p-1', status: 'approved',
    requestedByName: 'Wanjiru', requestedByRole: 'supervisor', createdAt: d('2026-03-01T09:00:00Z'),
    lines: [{ id: 'ml-1', requestId: 'mr-1', materialName: 'Machine-cut stones (9")', unit: 'piece', qty: 3000 }],
    project: { id: 'p-1', name: 'Riverside Villas' },
  }
  const REQUEST2 = {
    id: 'mr-2', requestCode: 'MR-2026-000004', projectId: 'p-1', status: 'approved',
    requestedByName: 'Wanjiru', requestedByRole: 'supervisor', createdAt: d('2026-03-02T09:00:00Z'),
    lines: [{ id: 'ml-2', requestId: 'mr-2', materialName: 'Ballast', unit: 'tonne', qty: 10 }],
    project: { id: 'p-1', name: 'Riverside Villas' },
  }

  let quotes: Row[]
  let orders: Row[]
  let catalog: Row[]
  let invoices: Row[]
  let notifRows: Row[]
  let jobRows: Row[]

  function seed() {
    quotes = [
      {
        id: 'q-1', requestCode: 'MR-2026-000003', supplierId: 'sup-1', status: 'requested',
        unitPrice: 0, deliveryFee: 0, transportFee: 0, fees: 0, totalLanded: 0,
        deliveryEta: null, stockOk: true, validUntil: null, terms: null, createdAt: d('2026-03-08T10:00:00Z'),
        request: REQUEST1, supplier: SUP1, lines: [],
      },
      {
        id: 'q-2', requestCode: 'MR-2026-000004', supplierId: 'sup-2', status: 'requested',
        unitPrice: 0, deliveryFee: 0, transportFee: 0, fees: 0, totalLanded: 0,
        deliveryEta: null, stockOk: true, validUntil: null, terms: null, createdAt: d('2026-03-09T10:00:00Z'),
        request: REQUEST2, supplier: SUP2, lines: [],
      },
    ]
    orders = [
      {
        id: 'po-1', orderCode: 'PO-2026-000013', projectId: 'p-1', requestId: null, supplierId: 'sup-1',
        subtotal: 181_500, deliveryFee: 3_500, total: 185_000, status: 'confirmed', paymentSource: 'client',
        createdByRole: 'contractor', note: 'Direct order — walling package', createdAt: d('2026-03-01T09:00:00Z'), updatedAt: d('2026-03-02T09:00:00Z'),
        lines: [{ id: 'pol-1', orderId: 'po-1', name: 'Machine-cut stones (9")', unit: 'piece', qty: 3000, unitPrice: 55, lineTotal: 165_000 }],
        supplier: SUP1, request: null, deliveries: [], project: { id: 'p-1', name: 'Riverside Villas' },
      },
      {
        id: 'po-2', orderCode: 'PO-2026-000014', projectId: 'p-1', requestId: null, supplierId: 'sup-2',
        subtotal: 60_000, deliveryFee: 2_000, total: 62_000, status: 'confirmed', paymentSource: 'project_wallet',
        createdByRole: 'supervisor', note: null, createdAt: d('2026-03-03T09:00:00Z'), updatedAt: d('2026-03-03T09:00:00Z'),
        lines: [{ id: 'pol-2', orderId: 'po-2', name: 'River sand', unit: 'tonne', qty: 30, unitPrice: 2000, lineTotal: 60_000 }],
        supplier: SUP2, request: null, deliveries: [], project: { id: 'p-1', name: 'Riverside Villas' },
      },
      {
        id: 'po-3', orderCode: 'PO-2026-000015', projectId: 'p-2', requestId: null, supplierId: 'sup-1',
        subtotal: 30_000, deliveryFee: 1_000, total: 31_000, status: 'sent', paymentSource: 'client',
        createdByRole: 'contractor', note: 'Westlands screed', createdAt: d('2026-03-04T09:00:00Z'), updatedAt: d('2026-03-04T09:00:00Z'),
        lines: [{ id: 'pol-3', orderId: 'po-3', name: 'Ballast', unit: 'tonne', qty: 10, unitPrice: 3000, lineTotal: 30_000 }],
        supplier: SUP1, request: null, deliveries: [], project: { id: 'p-2', name: 'Westlands Duplex' },
      },
    ]
    catalog = [
      { id: 'ci-1', supplierId: 'sup-1', name: 'Machine-cut stones (9")', unit: 'piece', unitPrice: 55, stockQty: 5000, minOrderQty: 100, category: 'walling', brand: null, createdAt: d('2026-01-05T09:00:00Z') },
      { id: 'ci-2', supplierId: 'sup-2', name: 'River sand', unit: 'tonne', unitPrice: 1800, stockQty: 40, minOrderQty: 5, category: 'aggregates', brand: null, createdAt: d('2026-01-06T09:00:00Z') },
    ]
    invoices = [
      {
        id: 'inv-1', invoiceCode: 'INV-2026-000027', projectId: 'p-1', supplierId: 'sup-1', orderId: null, orderCode: null,
        status: 'submitted', subtotal: 181_500, total: 185_000, dueDate: d('2026-04-01T00:00:00Z'), paidAt: null,
        paymentMethod: null, note: null, createdAt: d('2026-03-05T10:00:00Z'), updatedAt: d('2026-03-05T10:00:00Z'),
        supplier: SUP1, order: null, project: { id: 'p-1', name: 'Riverside Villas' },
        lines: [{ id: 'il-1', invoiceId: 'inv-1', name: 'Machine-cut stones (9")', unit: 'piece', qty: 3000, unitPrice: 55, lineTotal: 165_000 }],
      },
      {
        id: 'inv-2', invoiceCode: 'INV-2026-000028', projectId: 'p-1', supplierId: 'sup-2', orderId: null, orderCode: null,
        status: 'paid', subtotal: 60_000, total: 62_000, dueDate: d('2026-03-15T00:00:00Z'), paidAt: d('2026-03-12T14:00:00Z'),
        paymentMethod: 'mpesa', note: null, createdAt: d('2026-03-06T10:00:00Z'), updatedAt: d('2026-03-12T14:00:00Z'),
        supplier: SUP2, order: null, project: { id: 'p-1', name: 'Riverside Villas' }, lines: [],
      },
    ]
    // BE-3 (issue #104) pins: notification rows across both projects + one
    // GLOBAL row (projectId null) that must never leak into a supplier's
    // served-union read.
    notifRows = [
      { id: 'n-1', projectId: 'p-1', kind: 'milestone', title: 'Milestone approved', body: 'Foundation signed off', read: true, readAt: d('2026-03-02T10:00:00Z'), createdAt: d('2026-03-01T09:00:00Z') },
      { id: 'n-2', projectId: 'p-2', kind: 'share', title: 'Share link opened', body: 'Baba Otieno opened the link', read: false, readAt: null, createdAt: d('2026-03-02T09:00:00Z') },
      { id: 'n-g', projectId: null, kind: 'system', title: 'Weekly digest scheduled', body: 'System-wide notice', read: false, readAt: null, createdAt: d('2026-03-03T09:00:00Z') },
    ]
    jobRows = [
      { id: 'jr-1', type: 'digest.trust', status: 'done', projectId: 'p-1', payload: {}, result: { ok: true }, attempts: 1, lastError: null, runAt: d('2026-03-02T09:00:00Z'), startedAt: d('2026-03-02T09:00:01Z'), finishedAt: d('2026-03-02T09:00:02Z'), createdAt: d('2026-03-02T09:00:00Z'), maxAttempts: 3, lastAttemptAt: d('2026-03-02T09:00:02Z') },
      { id: 'jr-2', type: 'digest.trust', status: 'done', projectId: 'p-2', payload: {}, result: { ok: true }, attempts: 1, lastError: null, runAt: d('2026-03-03T09:00:00Z'), startedAt: d('2026-03-03T09:00:01Z'), finishedAt: d('2026-03-03T09:00:02Z'), createdAt: d('2026-03-03T09:00:00Z'), maxAttempts: 3, lastAttemptAt: d('2026-03-03T09:00:02Z') },
      { id: 'jr-g', type: 'anomaly.scan', status: 'done', projectId: null, payload: {}, result: { ok: true }, attempts: 1, lastError: null, runAt: d('2026-03-04T09:00:00Z'), startedAt: d('2026-03-04T09:00:01Z'), finishedAt: d('2026-03-04T09:00:02Z'), createdAt: d('2026-03-04T09:00:00Z'), maxAttempts: 3, lastAttemptAt: d('2026-03-04T09:00:02Z') },
    ]
  }
  state.reset()

  /** Just enough of Prisma's where: flat equality, nested one-level object
   *  filters ({ request: { projectId } }, { order: { projectId } }), { not },
   *  { in } and OR arrays. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Row
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
        if ('not' in c) {
          if (row[key] === c.not) return false
          continue
        }
        // Nested relation filter — recurse against the carried relation row.
        if (!matches((row[key] ?? {}) as Row, c)) return false
        continue
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  const byCreatedAtDesc = (rows: Row[]) =>
    [...rows].sort((a, b) => new Date(String(b.createdAt)).getTime() - new Date(String(a.createdAt)).getTime())

  /** The GET /api/notifications where-clause: projectId (id or { in }), kind,
   *  read and createdAt { lt } — exactly the shapes the route sends. */
  function notifMatches(row: Row, where: Row): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Row
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
        if ('lt' in c) {
          if (!(new Date(String(row.createdAt)).getTime() < new Date((c.lt as Date).getTime()).getTime())) return false
          continue
        }
        return false
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  const withOrder = (rows: Row[], orderBy?: Row): Row[] => {
    if (!orderBy) return rows
    const desc = Object.values(orderBy)[0] === 'desc'
    return desc ? byCreatedAtDesc(rows) : byCreatedAtDesc(rows).reverse()
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
      async findUnique({ where }: { where: Row }) {
        const rows = [P1, P2]
        if (where.id !== undefined) return rows.find((p) => p.id === where.id) ?? null
        if (where.shareToken !== undefined) return rows.find((p) => p.shareToken === where.shareToken) ?? null
        return null
      },
      async findFirst() { return { ...P1 } },
      async findMany({ where, select }: { where?: Row; select?: Row }) {
        state.calls.searchScans++ // /api/search source table #1
        const rows = [P1, P2].filter((p) => matches(p as Row, where ?? {}))
        if (select) {
          return rows.map((p) => {
            const out: Row = {}
            for (const k of Object.keys(select)) out[k] = (p as Row)[k]
            return out
          })
        }
        return rows.map((p) => ({ ...p }))
      },
    },
    supplier: {
      async findUnique({ where, include }: { where: Row; include?: Row }) {
        const row = where.id === 'sup-1' ? SUP1 : where.id === 'sup-2' ? SUP2 : null
        if (!row) return null
        if (include?.catalogItems) {
          return { ...row, catalogItems: catalog.filter((c) => c.supplierId === row.id).sort((a, b) => String(a.name).localeCompare(String(b.name))).map((c) => ({ ...c })) }
        }
        return { ...row }
      },
      async findMany() {
        state.calls.searchScans++ // /api/search source table #4
        return []
      },
    },
    catalogItem: {
      async findUnique({ where }: { where: Row }) {
        state.calls.catalogFindUnique++
        const row = catalog.find((c) => c.id === where.id)
        return row ? { ...row } : null
      },
      async findMany() {
        state.calls.searchScans++ // /api/search source table #5
        return []
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = catalog.find((c) => c.id === where.id) as Row
        Object.assign(row, data)
        return { ...row }
      },
      async create({ data }: { data: Row }) {
        const row = { id: `ci-new-${state.catalogCreated.length + 1}`, ...data }
        state.catalogCreated.push(row)
        catalog.push(row)
        return { ...row }
      },
    },
    quote: {
      async findFirst({ where }: { where: Row }) {
        state.calls.quoteFindFirst++
        return quotes.find((q) => matches(q, where)) ? structuredClone(quotes.find((q) => matches(q, where)) as Row) : null
      },
      async findMany({ where, orderBy }: { where?: Row; orderBy?: Row }) {
        return withOrder(quotes.filter((q) => matches(q, where ?? {})), orderBy).map((q) => structuredClone(q))
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = quotes.find((q) => q.id === where.id) as Row
        Object.assign(row, data)
        return structuredClone(row)
      },
    },
    quoteLine: {
      async deleteMany() { return { count: 0 } },
      async createMany() { return { count: 0 } },
    },
    purchaseOrder: {
      async findFirst({ where }: { where: Row }) {
        state.calls.purchaseOrderFindFirst++
        let row: Row | undefined
        if (Array.isArray(where.OR)) {
          const id = (where.OR as Row[]).find((c) => c.id !== undefined)?.id
          const code = (where.OR as Row[]).find((c) => c.orderCode !== undefined)?.orderCode
          row = orders.find((o) => o.id === id || o.orderCode === code)
        } else {
          row = orders.find((o) => matches(o, where))
        }
        return row ? structuredClone(row) : null
      },
      async findMany({ where, orderBy }: { where?: Row; orderBy?: Row }) {
        state.calls.searchScans++ // /api/search source table #7
        return withOrder(orders.filter((o) => matches(o, where ?? {})), orderBy).map((o) => structuredClone(o))
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = orders.find((o) => o.id === where.id) as Row
        Object.assign(row, data)
        return structuredClone(row)
      },
    },
    orderDelivery: {
      async findFirst({ where }: { where: Row }) {
        return state.deliveries.find((dl) => matches(dl, where)) ?? null
      },
      async create({ data }: { data: Row }) {
        const row = { id: `dlv-${state.deliveries.length + 1}`, ...data }
        state.deliveries.push(row)
        return { ...row }
      },
    },
    invoice: {
      async findFirst({ where }: { where: Row }) {
        let row: Row | undefined
        if (Array.isArray(where.OR)) {
          const id = (where.OR as Row[]).find((c) => c.id !== undefined)?.id
          const code = (where.OR as Row[]).find((c) => c.invoiceCode !== undefined)?.invoiceCode
          row = invoices.find((i) => i.id === id || i.invoiceCode === code)
        } else {
          row = invoices.find((i) => matches(i, where))
        }
        return row ? structuredClone(row) : null
      },
      async findMany({ where, orderBy }: { where?: Row; orderBy?: Row }) {
        state.calls.searchScans++ // /api/search source table #9
        return withOrder(invoices.filter((i) => matches(i, where ?? {})), orderBy).map((i) => structuredClone(i))
      },
    },
    // The /api/project 200 path (contractor contrast) reads the timeline's
    // eight tables — everything except the ones above returns empty.
    auditEvent: {
      async findMany() { return [] },
      async create({ data }: { data: Row }) {
        state.audits.push({ ...data })
        return { id: `audit-${state.audits.length}`, ...data }
      },
    },
    domainEvent: { async findMany() { return [] } },
    sitePhoto: { async findMany() { return [] } },
    milestone: { async findMany() { return [] } },
    // ---- /api/search-only source tables (empty rows; the counter is the pin) ----
    landParcel: {
      async findMany() { state.calls.searchScans++; return [] }, // source table #2
    },
    worker: {
      async findMany() { state.calls.searchScans++; return [] }, // source table #3
    },
    materialRequest: {
      async findMany() { state.calls.searchScans++; return [] }, // source table #6
    },
    transaction: {
      async findMany() { state.calls.searchScans++; return [] }, // source table #8
    },
    // ---- BE-3 (issue #104): the GET /api/notifications + /api/jobs/run reads ----
    notification: {
      async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number }) {
        state.calls.searchScans++ // /api/search source table #10
        state.calls.notificationFindMany++
        state.lastNotifWhere = where
        const rows = withOrder(notifRows.filter((n) => notifMatches(n, where ?? {})), orderBy)
        return rows.slice(0, take ?? rows.length).map((n) => ({ ...n }))
      },
      async create() { return {} },
    },
    user: {
      // GET /api/notifications reads the session user's prefs — always unset here.
      async findUnique() { return { notificationPrefs: null } },
    },
    jobRecord: {
      async findMany({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number }) {
        state.calls.jobRecordFindMany++
        const rows = withOrder(jobRows.filter((j) => matches(j, where ?? {})), orderBy)
        return rows.slice(0, Math.min(take ?? rows.length, 50)).map((j) => ({ ...j }))
      },
    },
    idempotencyRecord: {
      async findUnique({ where }: { where: { key: string } }) {
        return state.idemRows.find((r) => r.key === where.key) ?? null
      },
      async create({ data }: { data: Row }) {
        state.idemRows.push({ ...data })
        return { ...data }
      },
    },
  }
  return { db }
})

// ---------------------------------------------------------------- guard fake

// Full fake guard (the flags-gating idiom — mirrors guard.ts 1:1, INCLUDING
// the W5-3 sessionSupplierId pin; the real module's contract is pinned in
// guard.test.ts).
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const FINANCE_ROLES = ['finance', 'admin']
  const PAYMENT_ROLES = ['finance', 'admin', 'client']
  const KNOWN_ROLES = ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs', 'supplier']
  const OWNER_ROLES = ['contractor', 'admin', 'supervisor', 'procurement', 'qs', 'finance']
  const getSessionFromReq = vi.fn(async () => h.session)
  return {
    getSessionFromReq,
    unauthorized: () => NextResponse.json({ error: 'Sign in required' }, { status: 401 }),
    forbidden: (role?: string) =>
      NextResponse.json(
        { error: role ? `Not permitted for role "${role}"` : 'Not permitted' },
        { status: 403 },
      ),
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

// ---------------------------------------------------------------- seams

// applyAction stays REAL (importOriginal) — every dispatch in this file runs
// the exact production path, row pin and audit stamping included. Only the
// payload/list read seams are controlled.
vi.mock('@/backend/lib/mjengo', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  return {
    ...orig,
    getProjectPayload: vi.fn(async () => null),
    getProjectsList: vi.fn(async () => [
      { id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', status: 'active', dayCount: 1, budget: 2_000_000, spent: 0, progressPct: 0, workers: 0, openAlerts: 0, photos: 0 },
      { id: 'p-2', name: 'Westlands Duplex', client: 'Baba Otieno', status: 'active', dayCount: 1, budget: 3_500_000, spent: 0, progressPct: 0, workers: 0, openAlerts: 0, photos: 0 },
    ]),
  }
})

// The supply module's public read — controlled per test (v1-supply idiom).
const repo = vi.hoisted(() => ({ loadSupplySlice: vi.fn() }))
vi.mock('@/backend/modules/supply/repository', () => repo)

import { db } from '@/backend/lib/db'
import { getProjectPayload, getProjectsList } from '@/backend/lib/mjengo'
import { buildAuthOptions } from '@/backend/lib/auth'
import { assertSupplierScope, SUPPLIER_ACTION_REFUSED, SUPPLIER_UNLINKED } from '@/backend/modules/supply/supplier-scope'
import { SUPPLIER_ACTIONS } from '@/shared/supplier-actions'
import { CLIENT_ACTIONS } from '@/shared/client-actions'
import { SUPPLY_ACTIONS } from '@/backend/actions/supply'
import { TRUST_ACTIONS } from '@/backend/actions/trust'
import { MONEY_ACTIONS } from '@/backend/actions/money'
import { EVIDENCE_ACTIONS } from '@/backend/actions/evidence'
import { LAND_ACTIONS } from '@/backend/actions/land'
import { PROFESSIONALS_ACTIONS } from '@/backend/actions/professionals'
import { INVOICE_ACTIONS } from '@/backend/actions/invoices'
import { INTEL_ACTIONS } from '@/backend/actions/intel'
import { INVENTORY_ACTIONS } from '@/backend/actions/inventory'
import { WALLET_ACTIONS } from '@/backend/actions/wallet'
import { invalidateFlagCache } from '@/backend/modules/intel/flags'
import { POST as actionsPost } from '@/app/api/actions/route'
import { POST as syncPost } from '@/app/api/sync/route'
import { GET as projectGet } from '@/app/api/project/route'
import { GET as projectsGet } from '@/app/api/projects/route'
import { GET as searchGet } from '@/app/api/search/route'
import { GET as notificationsGet } from '@/backend/api/notifications'
import { GET as jobsRunGet } from '@/backend/api/jobs'
import { GET as supplierGet } from '@/app/api/supplier/route'
import { GET as v1ProjectsGet } from '@/app/api/v1/projects/route'
import { GET as v1ProjectDetailGet } from '@/app/api/v1/projects/[id]/route'
import { GET as v1ProjectTasksGet } from '@/app/api/v1/projects/[id]/tasks/route'
import { GET as v1ProjectMilestonesGet } from '@/app/api/v1/projects/[id]/milestones/route'
import { GET as v1ProjectEscrowGet } from '@/app/api/v1/projects/[id]/escrow/route'
import { GET as v1ProjectInvoicesGet } from '@/app/api/v1/projects/[id]/invoices/route'
import { GET as v1ProjectDeliveriesGet } from '@/app/api/v1/projects/[id]/deliveries/route'
import { GET as v1SupplyOrdersGet } from '@/app/api/v1/supply/orders/route'
import { GET as v1SupplyOrderDetailGet } from '@/app/api/v1/supply/orders/[id]/route'
import { GET as v1InvoiceDetailGet } from '@/app/api/v1/invoices/[id]/route'

// ---------------------------------------------------------------- helpers

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    audits: Array<Record<string, unknown>>
    deliveries: Array<Record<string, unknown>>
    catalogCreated: Array<Record<string, unknown>>
    idemRows: Array<Record<string, unknown>>
    lastNotifWhere: Record<string, unknown> | undefined
    calls: {
      purchaseOrderFindFirst: number
      quoteFindFirst: number
      catalogFindUnique: number
      searchScans: number
      notificationFindMany: number
      jobRecordFindMany: number
    }
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

let seq = 0 // monotonic across the file — unique principals keep the in-process rate limiter out of the way
function sessionFor(
  role: string,
  opts: { projectId?: string | null; supplierId?: string | null; email?: string } = {},
) {
  seq++
  h.session = {
    user: {
      id: `u-${role}-${seq}`,
      email: opts.email ?? `${role}.${seq}@test.dev`,
      name: role === 'supplier' ? 'Nairobi Hardware Centre' : role,
      role,
      projectId: opts.projectId ?? null,
      supplierId: opts.supplierId ?? null,
    },
  }
}

function jsonReq(url: string, method: 'GET' | 'POST', body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function getReq(url: string): NextRequest {
  return jsonReq(url, 'GET')
}

function actionReq(type: string, payload: unknown = {}, opts: { projectId?: string; headers?: Record<string, string>; shareToken?: string } = {}) {
  return jsonReq('http://localhost/api/actions', 'POST', { type, payload, projectId: opts.projectId, shareToken: opts.shareToken }, opts.headers)
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

/** Core (non-module) action ids, parsed from the ActionType union source. */
function coreActionIds(): string[] {
  const src = readFileSync(fileURLToPath(new URL('../../src/backend/lib/mjengo.ts', import.meta.url)), 'utf8')
  const union = src.slice(src.indexOf('export type ActionType'), src.indexOf('export async function applyAction'))
  return [...union.matchAll(/'([a-z]+[a-zA-Z]*\.[a-zA-Z]+)'/g)].map((m) => m[1])
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
  state.reset()
  // The payload read seam: a project-shaped payload for the seeded ids,
  // null for anything else (the 404 path). Supplier 403s happen BEFORE any
  // of this data matters — the stub exists so the routes resolve past 404.
  vi.mocked(getProjectPayload).mockImplementation(async (id?: string | null) =>
    (id === 'p-1' || id === 'p-2'
      ? { project: { id, name: id === 'p-1' ? 'Riverside Villas' : 'Westlands Duplex' } }
      : null) as never)
  repo.loadSupplySlice.mockReset()
})

afterEach(() => {
  delete process.env.NEXT_FLAGS_OFF
  invalidateFlagCache()
})

// ---------------------------------------------------------------- allowlist

describe('SUPPLIER_ACTIONS is a complete, dispatchable allowlist', () => {
  it('has no duplicate entries', () => {
    expect(new Set(SUPPLIER_ACTIONS).size).toBe(SUPPLIER_ACTIONS.length)
  })

  it('every entry is a real action id the dispatcher knows', () => {
    const registry = new Set<string>([
      ...coreActionIds(),
      ...TRUST_ACTIONS, ...MONEY_ACTIONS, ...EVIDENCE_ACTIONS, ...LAND_ACTIONS,
      ...PROFESSIONALS_ACTIONS, ...SUPPLY_ACTIONS, ...INVOICE_ACTIONS,
      ...INTEL_ACTIONS, ...INVENTORY_ACTIONS, ...WALLET_ACTIONS,
    ])
    for (const action of SUPPLIER_ACTIONS) {
      expect(registry.has(action), `"${action}" is not a dispatchable action id`).toBe(true)
    }
  })

  it('is exactly the supplier loop: answer quotes, confirm + dispatch orders, maintain the catalog', () => {
    expect([...SUPPLIER_ACTIONS]).toEqual([
      'quote.receive', 'quote.decline', 'order.confirm', 'order.dispatch', 'catalog.upsert',
    ])
  })

  it('no buyer-side mutation leaks into the supplier surface', () => {
    const buyerOnly = [
      'request.create', 'request.submit', 'request.decide', 'quote.request',
      'order.create', 'order.approve', 'order.send', 'order.cancel', 'order.close',
      'delivery.receive', 'delivery.dispatch', 'supplier.upsert',
      'rule.upsert', 'rule.delete',
      'invoice.create', 'invoice.submit', 'invoice.decide', 'invoice.pay',
      'payment.create', 'payment.decide', 'payment.pay',
      'escrow.topup', 'milestone.decide', 'milestone.create', 'variation.create',
      'team.add', 'team.update', 'team.remove', 'worker.create', 'wages.pay',
    ]
    for (const id of buyerOnly) {
      expect(SUPPLIER_ACTIONS, `buyer-only "${id}" leaked into SUPPLIER_ACTIONS`).not.toContain(id)
    }
  })

  it('is disjoint from CLIENT_ACTIONS — each seam action belongs to exactly one surface', () => {
    const overlap = SUPPLIER_ACTIONS.filter((a) => (CLIENT_ACTIONS as readonly string[]).includes(a))
    expect(overlap).toEqual([])
  })
})

// ------------------------------------------------------- session shaping

describe('session shaping mirrors the client projectId pin (auth callbacks)', () => {
  const options = buildAuthOptions(false)

  it('the jwt callback stamps token.supplierId from the authorize() result', async () => {
    const token = await options.callbacks.jwt({
      token: { email: 'supplier@mjengo.os' },
      user: { id: 'u-1', email: 'supplier@mjengo.os', name: 'Nairobi Hardware Centre', role: 'supplier', supplierId: 'sup-1' },
    } as never)
    expect(token.supplierId).toBe('sup-1')
    expect(token.role).toBe('supplier')
  })

  it('the session callback surfaces supplierId (and null-safes a token without one)', async () => {
    const withLink = await options.callbacks.session({
      session: {},
      token: { email: 'supplier@mjengo.os', name: 'Nairobi Hardware Centre', role: 'supplier', supplierId: 'sup-1' },
    } as never)
    expect(withLink.user.supplierId).toBe('sup-1')

    const noStamp = await options.callbacks.session({
      session: {},
      token: { email: 'old-token@mjengo.os', name: 'Old', role: 'contractor' },
    } as never)
    expect(noStamp.user.supplierId).toBe(null)
  })

  it('every role keeps the field: non-supplier users carry a null supplierId, never undefined', async () => {
    const session = await options.callbacks.session({
      session: {},
      token: { email: 'client@mjengo.os', name: 'Amina', role: 'client', projectId: 'p-1' },
    } as never)
    expect(session.user.supplierId).toBe(null)
    expect(session.user.projectId).toBe('p-1')
  })
})

// ------------------------------------------------- assertSupplierScope (unit)

describe('assertSupplierScope — the row pin (real fn, in-memory rows)', () => {
  it('refuses a non-allowlisted action BEFORE any lookup (fail closed)', async () => {
    await expect(assertSupplierScope('task.create', {}, 'p-1', 'sup-1')).rejects.toThrow(
      `${SUPPLIER_ACTION_REFUSED} (action: task.create)`,
    )
    expect(state.calls.purchaseOrderFindFirst).toBe(0)
    expect(state.calls.quoteFindFirst).toBe(0)
  })

  it('refuses a supplier stamp with no link, BEFORE any lookup', async () => {
    await expect(assertSupplierScope('quote.decline', { id: 'q-1' }, 'p-1', null)).rejects.toThrow(SUPPLIER_UNLINKED)
    expect(state.calls.quoteFindFirst).toBe(0)
  })

  it('quote foreign id → the EXACT error an unknown id produces', async () => {
    const foreign = assertSupplierScope('quote.decline', { id: 'q-2' }, 'p-1', 'sup-1')
    const unknown = assertSupplierScope('quote.decline', { id: 'q-x' }, 'p-1', 'sup-1')
    await expect(foreign).rejects.toThrow('Quote not found in this project')
    await expect(unknown).rejects.toThrow('Quote not found in this project')
  })

  it('quote own id → resolves (no throw)', async () => {
    await expect(assertSupplierScope('quote.decline', { id: 'q-1' }, 'p-1', 'sup-1')).resolves.toBeUndefined()
  })

  it('order foreign id → the EXACT error an unknown id produces (payload id OR orderId)', async () => {
    await expect(assertSupplierScope('order.dispatch', { orderId: 'po-2' }, 'p-1', 'sup-1')).rejects.toThrow('Purchase order not found in this project')
    await expect(assertSupplierScope('order.dispatch', { orderId: 'po-x' }, 'p-1', 'sup-1')).rejects.toThrow('Purchase order not found in this project')
    await expect(assertSupplierScope('order.confirm', { id: 'po-2' }, 'p-1', 'sup-1')).rejects.toThrow('Purchase order not found in this project')
  })

  it('order own id → resolves', async () => {
    await expect(assertSupplierScope('order.dispatch', { orderId: 'po-1' }, 'p-1', 'sup-1')).resolves.toBeUndefined()
  })

  it('catalog foreign id → the EXACT error an unknown id produces', async () => {
    await expect(assertSupplierScope('catalog.upsert', { id: 'ci-2' }, 'p-1', 'sup-1')).rejects.toThrow('Catalog item not found')
    await expect(assertSupplierScope('catalog.upsert', { id: 'ci-x' }, 'p-1', 'sup-1')).rejects.toThrow('Catalog item not found')
  })

  it('catalog.upsert REWRITES the payload supplierId to the session pin (a forged copy is ignored)', async () => {
    const payload: Record<string, unknown> = { id: 'ci-1', supplierId: 'sup-2', name: 'Machine-cut stones (9")', unit: 'piece', unitPrice: 60, stockQty: 4000 }
    await assertSupplierScope('catalog.upsert', payload, 'p-1', 'sup-1')
    expect(payload.supplierId).toBe('sup-1')
  })
})

// ---------------------------------------------------- POST /api/actions

describe('POST /api/actions — the supplier pin (REAL applyAction)', () => {
  it('401 anonymous (no session, no share token)', async () => {
    const res = await actionsPost(actionReq('quote.decline', { id: 'q-1' }))
    expect(res.status).toBe(401)
    expect(await bodyOf(res)).toEqual({ error: 'Sign in required' })
  })

  it('403 for a non-allowlisted action — with ZERO rows touched', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(actionReq('task.create', { title: 'x' }, { projectId: 'p-1' }))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for role "supplier"' })
    expect(state.audits).toHaveLength(0)
    expect(state.calls.purchaseOrderFindFirst).toBe(0)
  })

  it('403 for an unlinked supplier account (mirrors the client no-project pin)', async () => {
    sessionFor('supplier', { supplierId: null })
    const res = await actionsPost(actionReq('order.confirm', { id: 'po-3' }, { projectId: 'p-2' }))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ ok: false, error: 'Supplier account has no supplier linked' })
    expect(state.calls.purchaseOrderFindFirst).toBe(0)
  })

  it('order.dispatch on THEIR order → the SAME OrderDelivery row the buyer path writes, audit stamped __role supplier', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(actionReq('order.dispatch', { orderId: 'po-1' }, { projectId: 'p-1' }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    // Supplier response shape: the result ONLY — no buyer data/projects keys.
    expect(body.ok).toBe(true)
    expect(body.data).toBeUndefined()
    expect(body.projects).toBeUndefined()
    expect(body.result).toEqual({ id: 'po-1', deliveryId: 'dlv-1', status: 'delivering', orderCode: 'PO-2026-000013' })

    // The SAME delivery row the buyer path writes (dispatchOrder, unchanged).
    expect(state.deliveries).toHaveLength(1)
    expect(state.deliveries[0]).toMatchObject({ orderId: 'po-1', status: 'dispatched' })
    expect(state.deliveries[0].dispatchedAt).toBeInstanceOf(Date)
    expect(String(state.deliveries[0].note)).toContain('Truck dispatched')

    // The audit row says the SUPPLIER acted (Bias-Free Ledger, __role stamp).
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({
      projectId: 'p-1',
      actor: 'Nairobi Hardware Centre',
      role: 'supplier',
      meta: JSON.stringify({ type: 'order.dispatch' }),
    })
    // And the buyer payload seams were never even asked (the supplier branch).
    expect(getProjectPayload).not.toHaveBeenCalled()
    expect(getProjectsList).not.toHaveBeenCalled()
  })

  it('order.confirm on THEIR sent order (cross-project) → confirms + audits as supplier', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(actionReq('order.confirm', { id: 'po-3' }, { projectId: 'p-2' }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.result).toEqual({ id: 'po-3', status: 'confirmed', orderCode: 'PO-2026-000015' })
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({ projectId: 'p-2', role: 'supplier' })
  })

  it('order.dispatch on a FOREIGN order → the byte-identical error an unknown id produces, ZERO rows', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const foreign = await actionsPost(actionReq('order.dispatch', { orderId: 'po-2' }, { projectId: 'p-1' }))
    const unknown = await actionsPost(actionReq('order.dispatch', { orderId: 'po-x' }, { projectId: 'p-1' }))
    expect(foreign.status).toBe(400)
    expect(unknown.status).toBe(400)
    // Indistinguishable from a miss: same status, same body.
    const foreignBody = await bodyOf(foreign)
    const unknownBody = await bodyOf(unknown)
    expect(foreignBody).toEqual(unknownBody)
    expect(foreignBody).toEqual({ ok: false, error: 'Purchase order not found in this project' })
    // Nothing was written — no delivery row, no audit.
    expect(state.deliveries).toHaveLength(0)
    expect(state.audits).toHaveLength(0)
  })

  it('quote.decline on a FOREIGN quote → the byte-identical error an unknown id produces, ZERO rows', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const foreign = await actionsPost(actionReq('quote.decline', { id: 'q-2' }, { projectId: 'p-1' }))
    const unknown = await actionsPost(actionReq('quote.decline', { id: 'q-x' }, { projectId: 'p-1' }))
    expect(foreign.status).toBe(400)
    expect(unknown.status).toBe(400)
    const foreignBody = await bodyOf(foreign)
    const unknownBody = await bodyOf(unknown)
    expect(foreignBody).toEqual(unknownBody)
    expect(foreignBody).toEqual({ ok: false, error: 'Quote not found in this project' })
    expect(state.audits).toHaveLength(0)
  })

  it('quote.decline on THEIR quote → declined + audited as supplier', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(actionReq('quote.decline', { id: 'q-1', reason: 'no stock' }, { projectId: 'p-1' }))
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ ok: true, result: { id: 'q-1' } })
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({ role: 'supplier', actor: 'Nairobi Hardware Centre' })
  })

  it('quote.receive on THEIR quote → landed cost written + audited as supplier', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(
      actionReq('quote.receive', { id: 'q-1', unitPrice: 58, deliveryFee: 3500 }, { projectId: 'p-1' }),
    )
    expect(res.status).toBe(200)
    // 58 × 3000 + 3500 = 177 500 (receiveQuote's single-line math, unchanged).
    expect(await bodyOf(res)).toMatchObject({ ok: true, result: { id: 'q-1', totalLanded: 177_500 } })
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({ role: 'supplier' })
  })

  it('catalog.upsert with a FORGED payload supplierId → the row lands on THEIR catalog anyway (tenant pin)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(
      actionReq('catalog.upsert', { id: 'ci-1', supplierId: 'sup-2', name: 'Machine-cut stones (9")', unit: 'piece', unitPrice: 60, stockQty: 4200 }, { projectId: 'p-1' }),
    )
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toMatchObject({ ok: true, result: { id: 'ci-1' } })
    // The session pin won: the row is still sup-1's, with the new price/stock.
    const row = state.catalogCreated // (no creates)
    expect(row).toHaveLength(0)
    expect(state.calls.catalogFindUnique).toBeGreaterThan(0)
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({ role: 'supplier' })
  })

  it('catalog.upsert on a FOREIGN item id → the byte-identical error an unknown id produces, ZERO writes', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const foreign = await actionsPost(
      actionReq('catalog.upsert', { id: 'ci-2', unitPrice: 2000 }, { projectId: 'p-1' }),
    )
    const unknown = await actionsPost(
      actionReq('catalog.upsert', { id: 'ci-x', unitPrice: 2000 }, { projectId: 'p-1' }),
    )
    expect(foreign.status).toBe(400)
    expect(unknown.status).toBe(400)
    const foreignBody = await bodyOf(foreign)
    const unknownBody = await bodyOf(unknown)
    expect(foreignBody).toEqual(unknownBody)
    expect(foreignBody).toEqual({ ok: false, error: 'Catalog item not found' })
    expect(state.catalogCreated).toHaveLength(0)
    expect(state.audits).toHaveLength(0)
  })

  it('catalog.upsert NEW item with a forged supplierId → created on THEIR supplier (the pin rewrites it)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(
      actionReq('catalog.upsert', { supplierId: 'sup-2', name: 'Concrete blocks (6" hollow)', unit: 'block', unitPrice: 75, stockQty: 800 }, { projectId: 'p-1' }),
    )
    expect(res.status).toBe(200)
    expect(state.catalogCreated).toHaveLength(1)
    expect(state.catalogCreated[0]).toMatchObject({ supplierId: 'sup-1', name: 'Concrete blocks (6" hollow)', unitPrice: 75 })
  })

  it('payload stamp forgery (__role admin + __supplierId of another supplier) is overwritten by the session — the foreign row still refuses', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(
      actionReq('order.dispatch', { orderId: 'po-2', __role: 'admin', __supplierId: 'sup-2' }, { projectId: 'p-1' }),
    )
    expect(res.status).toBe(400)
    expect(await bodyOf(res)).toEqual({ ok: false, error: 'Purchase order not found in this project' })
    expect(state.deliveries).toHaveLength(0)
    expect(state.audits).toHaveLength(0)
  })

  it('supplier replay (Idempotency-Key) → the stored result ONLY — never the buyer payload keys', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(
      actionReq('order.dispatch', { orderId: 'po-1' }, { projectId: 'p-1', headers: { 'idempotency-key': 'sup-replay-1' } }),
    )
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body).toEqual({
      ok: true,
      replayed: true,
      scope: 'order.dispatch',
      result: { id: 'po-1', status: 'delivering', orderCode: 'PO-2026-000013' },
    })
    expect(getProjectPayload).not.toHaveBeenCalled()
    expect(getProjectsList).not.toHaveBeenCalled()
  })

  it('MIRROR: the same dispatch by a contractor DOES carry the buyer payload keys (the branch is supplier-specific)', async () => {
    sessionFor('contractor')
    const res = await actionsPost(actionReq('order.dispatch', { orderId: 'po-1' }, { projectId: 'p-1' }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect('data' in body).toBe(true)
    expect('projects' in body).toBe(true)
    expect(getProjectPayload).toHaveBeenCalled()
    expect(getProjectsList).toHaveBeenCalled()
    // And the audit row stamps the contractor (the same row, the other actor).
    expect(state.audits[0]).toMatchObject({ role: 'contractor' })
  })
})

// --------------------------------------------------------- POST /api/sync

describe('POST /api/sync — suppliers own no outbox (fail closed)', () => {
  it('403 for a supplier session — before any item is drained, ZERO rows', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await syncPost(jsonReq('http://localhost/api/sync', 'POST', {
      projectId: 'p-1',
      actions: [{ id: 'a1', type: 'order.confirm', payload: { id: 'po-3' }, projectId: 'p-2' }],
    }))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ ok: false, error: 'Not permitted for role "supplier"' })
    expect(state.audits).toHaveLength(0)
    expect(state.calls.purchaseOrderFindFirst).toBe(0)
  })

  it('MIRROR: the same flush by a contractor applies (the 403 is supplier-specific)', async () => {
    sessionFor('contractor')
    const res = await syncPost(jsonReq('http://localhost/api/sync', 'POST', {
      projectId: 'p-2',
      actions: [{ id: 'a1', type: 'order.confirm', payload: { id: 'po-3' }, projectId: 'p-2' }],
    }))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.results).toEqual([{ id: 'a1', ok: true }])
    expect(state.audits).toHaveLength(1)
    expect(state.audits[0]).toMatchObject({ role: 'contractor' })
  })
})

// ------------------------------------------- the buyer read surface is closed

describe('the buyer payload surfaces are closed to supplier sessions', () => {
  it('GET /api/project → 403 (before the share-token path — a signed-in supplier is not a share visitor)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await projectGet(getReq('http://localhost/api/project'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for role "supplier"' })
    expect(getProjectPayload).not.toHaveBeenCalled()
  })

  it('GET /api/project?share=tok-1 → still 403 (the session wins over the link)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await projectGet(getReq('http://localhost/api/project?share=tok-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for role "supplier"' })
  })

  it('GET /api/projects → the honest EMPTY list — never the portfolio', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await projectsGet(getReq('http://localhost/api/projects'))
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ ok: true, projects: [] })
    expect(getProjectsList).toHaveBeenCalledTimes(1)
  })

  it('MIRROR: a client pinned to their project sees exactly it (the pin family the supplier row joins)', async () => {
    sessionFor('client', { projectId: 'p-1' })
    const res = await projectsGet(getReq('http://localhost/api/projects'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.projects).toHaveLength(1)
    expect((body.projects as Array<{ id: string }>)[0].id).toBe('p-1')
  })
})

// --------------------------- BE-3 (issue #104): the three GET read holes closed

describe('GET /api/search — a supplier is not a portfolio reader (BE-3)', () => {
  it('supplier session → the honest W5-3 403, ZERO source tables touched', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await searchGet(getReq('http://localhost/api/search?q=westlands'), undefined)
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for role "supplier"' })
    // The fan-out never started — not one of the ten source tables was read.
    expect(state.calls.searchScans).toBe(0)
  })

  it('MIRROR: the same search by a contractor scans the source tables (the 403 is supplier-specific)', async () => {
    sessionFor('contractor')
    const res = await searchGet(getReq('http://localhost/api/search?q=westlands'), undefined)
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.scopedTo).toBeNull()
    expect(state.calls.searchScans).toBeGreaterThanOrEqual(10)
  })
})

describe('GET /api/notifications — the BE-12 supplier scope, on the GET half (BE-3)', () => {
  it('supplier role with NO linked supplierId → 403 fail closed, ZERO notification rows read', async () => {
    sessionFor('supplier', { supplierId: null })
    const res = await notificationsGet(getReq('http://localhost/api/notifications'), undefined)
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Supplier account has no supplier linked' })
    expect(state.calls.notificationFindMany).toBe(0)
  })

  it('supplier + an explicit project they DO NOT serve → 403, the POST copy, ZERO rows read', async () => {
    sessionFor('supplier', { supplierId: 'sup-2' }) // serves p-1 only (po-2)
    const res = await notificationsGet(getReq('http://localhost/api/notifications?projectId=p-2'), undefined)
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this project' })
    expect(state.calls.notificationFindMany).toBe(0)
  })

  it('supplier + an explicit project they SERVE → that project\'s rows only (POST parity)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' }) // po-3 lives in p-2
    const res = await notificationsGet(getReq('http://localhost/api/notifications?projectId=p-2'), undefined)
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect((body.notifications as Array<{ id: string }>).map((n) => n.id)).toEqual(['n-2'])
    expect(state.lastNotifWhere).toMatchObject({ projectId: 'p-2' })
  })

  it('supplier + NO project named → their SERVED projects\' union, never the default first project', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' }) // serves p-1 (po-1) AND p-2 (po-3)
    const res = await notificationsGet(getReq('http://localhost/api/notifications'), undefined)
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    // n-1 (p-1) + n-2 (p-2), newest first; the GLOBAL row (n-g, projectId
    // null) never leaks into the union.
    expect((body.notifications as Array<{ id: string }>).map((n) => n.id)).toEqual(['n-2', 'n-1'])
    expect(state.lastNotifWhere).toEqual({ projectId: { in: ['p-1', 'p-2'] } })
  })

  it('the union is per-session — the second supplier sees only the project THEY serve', async () => {
    sessionFor('supplier', { supplierId: 'sup-2' }) // serves p-1 only (po-2)
    const res = await notificationsGet(getReq('http://localhost/api/notifications'), undefined)
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.notifications as Array<{ id: string }>).map((n) => n.id)).toEqual(['n-1'])
    expect(state.lastNotifWhere).toEqual({ projectId: { in: ['p-1'] } })
  })

  it('unknown project → the same 404 everyone gets (resolve first, pin second — POST parity)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await notificationsGet(getReq('http://localhost/api/notifications?projectId=p-missing'), undefined)
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Project not found' })
    expect(state.calls.notificationFindMany).toBe(0)
  })

  it('MIRROR: a contractor with no project named still gets the default first project (unchanged)', async () => {
    sessionFor('contractor')
    const res = await notificationsGet(getReq('http://localhost/api/notifications'), undefined)
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.notifications as Array<{ id: string }>).map((n) => n.id)).toEqual(['n-1'])
    expect(state.lastNotifWhere).toMatchObject({ projectId: 'p-1' })
  })
})

describe('GET /api/jobs/run — a supplier has no jobs surface (BE-3)', () => {
  it('supplier session → the honest role 403, ZERO job rows read', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await jobsRunGet(getReq('http://localhost/api/jobs/run'), undefined)
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for role "supplier"' })
    expect(state.calls.jobRecordFindMany).toBe(0)
  })

  it('MIRROR: the same read by a contractor lists the recent jobs (the 403 is supplier-specific)', async () => {
    sessionFor('contractor')
    const res = await jobsRunGet(getReq('http://localhost/api/jobs/run'), undefined)
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.jobs as Array<{ id: string }>).map((j) => j.id).sort()).toEqual(['jr-1', 'jr-2', 'jr-g'])
  })
})

// ----------------------------------------------------- GET /api/supplier

describe('GET /api/supplier — the scoped portal read', () => {
  it('401 anonymous', async () => {
    const res = await supplierGet(getReq('http://localhost/api/supplier'))
    expect(res.status).toBe(401)
    expect(await bodyOf(res)).toEqual({ error: 'Sign in required' })
  })

  it('403 for every buyer-side role (they read the same domain through /api/project)', async () => {
    for (const role of ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs']) {
      sessionFor(role)
      const res = await supplierGet(getReq('http://localhost/api/supplier'))
      expect(res.status, `${role} must not read the supplier portal`).toBe(403)
      expect(await bodyOf(res)).toEqual({ error: `Not permitted for role "${role}"` })
    }
  })

  it('403 for a supplier account with no link', async () => {
    sessionFor('supplier', { supplierId: null })
    const res = await supplierGet(getReq('http://localhost/api/supplier'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Supplier account has no supplier linked' })
  })

  it('403 for a DANGLING link (supplierId that resolves to no Supplier row) — never an empty portal pretending', async () => {
    sessionFor('supplier', { supplierId: 'sup-x' })
    const res = await supplierGet(getReq('http://localhost/api/supplier'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Supplier account has no supplier linked' })
  })

  it('200 for the linked supplier — every family pinned by the query itself (their rows only)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await supplierGet(getReq('http://localhost/api/supplier'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.supplier).toMatchObject({ id: 'sup-1', businessName: 'Nairobi Hardware Centre' })
    // Catalog: exactly theirs (never sup-2's row).
    expect((body.catalog as Array<{ id: string }>).map((c) => c.id)).toEqual(['ci-1'])
    // Quotes: exactly theirs.
    expect((body.quotes as Array<{ id: string }>).map((q) => q.id)).toEqual(['q-1'])
    // Orders: exactly theirs, across BOTH buyer projects they serve
    // (createdAt DESC: the Westlands order is newer than the Riverside one).
    expect((body.orders as Array<{ id: string }>).map((o) => o.id)).toEqual(['po-3', 'po-1'])
    // Invoices: exactly theirs.
    expect((body.invoices as Array<{ id: string }>).map((i) => i.id)).toEqual(['inv-1'])
    // The buyer projects they serve (context rows, nothing more).
    expect(body.projects).toEqual([
      { id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri' },
      { id: 'p-2', name: 'Westlands Duplex', client: 'Baba Otieno' },
    ])
  })

  it('quote rows carry the RFQ context the supplier answers (project, lines, requester)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await supplierGet(getReq('http://localhost/api/supplier'))
    const body = await bodyOf(res)
    const quote = (body.quotes as Array<Record<string, unknown>>)[0]
    expect(quote).toMatchObject({
      id: 'q-1',
      projectId: 'p-1',
      projectName: 'Riverside Villas',
      requestedByName: 'Wanjiru',
      requestedByRole: 'supervisor',
    })
    expect(quote.requestLines).toEqual([{ id: 'ml-1', materialName: 'Machine-cut stones (9")', unit: 'piece', qty: 3000 }])
  })

  it('the second supplier sees THEIR rows — the pin is per-session, not per-request', async () => {
    sessionFor('supplier', { supplierId: 'sup-2' })
    const res = await supplierGet(getReq('http://localhost/api/supplier'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.catalog as Array<{ id: string }>).map((c) => c.id)).toEqual(['ci-2'])
    expect((body.quotes as Array<{ id: string }>).map((q) => q.id)).toEqual(['q-2'])
    expect((body.orders as Array<{ id: string }>).map((o) => o.id)).toEqual(['po-2'])
    expect((body.invoices as Array<{ id: string }>).map((i) => i.id)).toEqual(['inv-2'])
  })
})

// ------------------------------------------- v1: project-scoped reads closed

describe('v1 project-scoped reads — a supplier is not a project reader', () => {
  it('GET /api/v1/projects → the honest empty portfolio (never the buyer list)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await v1ProjectsGet(getReq('http://localhost/api/v1/projects'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.data).toEqual([])
    expect(body.nextCursor).toBe(null)
  })

  it('GET /api/v1/projects/:id → uniform 403 for an existing project (no project data returned)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await v1ProjectDetailGet(getReq('http://localhost/api/v1/projects/p-1'), ctx('p-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this supplier account' })
  })

  it('GET /api/v1/projects/:id/tasks → uniform 403 for an existing project', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await v1ProjectTasksGet(getReq('http://localhost/api/v1/projects/p-1/tasks'), ctx('p-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this supplier account' })
  })

  it('GET /api/v1/projects/:id/milestones → uniform 403 for an existing project', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await v1ProjectMilestonesGet(getReq('http://localhost/api/v1/projects/p-1/milestones'), ctx('p-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this supplier account' })
  })

  it('GET /api/v1/projects/:id/escrow → uniform 403 for an existing project', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await v1ProjectEscrowGet(getReq('http://localhost/api/v1/projects/p-1/escrow'), ctx('p-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for this supplier account' })
  })

  it('GET /api/v1/projects/:id with an unknown id → the same 404 everyone gets (resolve first, pin second)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await v1ProjectDetailGet(getReq('http://localhost/api/v1/projects/p-x'), ctx('p-x'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Project not found' })
  })

  it('GET /api/v1/projects/:id/invoices → row-pinned: their invoices in the project only', async () => {
    vi.mocked(getProjectPayload).mockResolvedValueOnce({
      project: { id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', clientType: 'diaspora', location: 'Karen', status: 'active', budget: 2_000_000, startDate: new Date('2026-01-05T09:00:00Z'), targetDate: null, createdAt: new Date('2026-01-04T09:00:00Z'), updatedAt: new Date('2026-02-01T09:00:00Z') },
      invoices: { invoices: [
        { id: 'inv-1', invoiceCode: 'INV-2026-000027', projectId: 'p-1', supplierId: 'sup-1', status: 'submitted', total: 185_000, subtotal: 181_500, dueDate: new Date('2026-04-01T00:00:00Z'), paidAt: null, paymentMethod: null, note: null, createdAt: new Date('2026-03-05T10:00:00Z'), updatedAt: new Date('2026-03-05T10:00:00Z'), lines: [] },
        { id: 'inv-2', invoiceCode: 'INV-2026-000028', projectId: 'p-1', supplierId: 'sup-2', status: 'paid', total: 62_000, subtotal: 60_000, dueDate: new Date('2026-03-15T00:00:00Z'), paidAt: new Date('2026-03-12T14:00:00Z'), paymentMethod: 'mpesa', note: null, createdAt: new Date('2026-03-06T10:00:00Z'), updatedAt: new Date('2026-03-12T14:00:00Z'), lines: [] },
      ] },
    } as never)
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await v1ProjectInvoicesGet(getReq('http://localhost/api/v1/projects/p-1/invoices'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.data as Array<{ id: string }>).map((i) => i.id)).toEqual(['inv-1'])
  })

  it('GET /api/v1/projects/:id/invoices with no link → 403 fail closed', async () => {
    vi.mocked(getProjectPayload).mockResolvedValueOnce({
      project: { id: 'p-1' },
      invoices: { invoices: [] },
    } as never)
    sessionFor('supplier', { supplierId: null })
    const res = await v1ProjectInvoicesGet(getReq('http://localhost/api/v1/projects/p-1/invoices'), ctx('p-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Supplier account has no supplier linked' })
  })
})

// --------------------------------------------- v1: supplier-owned row pins

describe('v1 supplier-owned families — row-pinned, indistinguishable from a miss', () => {
  const dlv = (id: string, orderId: string, status: string) => ({
    id, orderId, status,
    dispatchedAt: new Date('2026-03-05T08:00:00Z'), receivedAt: null, receivedBy: null,
    note: 'counted at the gate', driverName: 'Otieno', driverPhone: '+254700000001', vehicleReg: 'KDA 123X',
    etaAt: null, departedAt: null, arrivedAt: null, gpsLat: null, gpsLng: null,
    photoCount: 0, photos: [], createdAt: new Date('2026-03-05T14:00:00Z'),
    lines: [],
  })
  const SLICE = {
    suppliers: [], requests: [], approvalRules: [], approvals: [], quotes: [], savedSupplierIds: [],
    orders: [
      {
        id: 'po-1', orderCode: 'PO-2026-000013', projectId: 'p-1', status: 'confirmed', supplierId: 'sup-1',
        supplierName: 'Nairobi Hardware Centre', requestCode: null, subtotal: 181_500, deliveryFee: 3_500,
        total: 185_000, paymentSource: 'client', createdByRole: 'contractor', note: 'direct order',
        createdAt: new Date('2026-03-01T09:00:00Z'), updatedAt: new Date('2026-03-02T09:00:00Z'),
        lines: [], deliveries: [dlv('dlv-1', 'po-1', 'received')],
      },
      {
        id: 'po-2', orderCode: 'PO-2026-000014', projectId: 'p-1', status: 'confirmed', supplierId: 'sup-2',
        supplierName: 'Karioke Hardware', requestCode: null, subtotal: 60_000, deliveryFee: 2_000,
        total: 62_000, paymentSource: 'project_wallet', createdByRole: 'supervisor', note: null,
        createdAt: new Date('2026-03-03T09:00:00Z'), updatedAt: new Date('2026-03-03T09:00:00Z'),
        lines: [], deliveries: [dlv('dlv-2', 'po-2', 'dispatched')],
      },
      {
        id: 'po-3', orderCode: 'PO-2026-000015', projectId: 'p-2', status: 'sent', supplierId: 'sup-1',
        supplierName: 'Nairobi Hardware Centre', requestCode: null, subtotal: 30_000, deliveryFee: 1_000,
        total: 31_000, paymentSource: 'client', createdByRole: 'contractor', note: 'Westlands screed',
        createdAt: new Date('2026-03-04T09:00:00Z'), updatedAt: new Date('2026-03-04T09:00:00Z'),
        lines: [], deliveries: [],
      },
    ],
  }

  beforeEach(() => {
    // The real repo scopes by project — the stub mirrors that honestly.
    repo.loadSupplySlice.mockImplementation(async (projectId: string) => ({
      ...SLICE,
      orders: SLICE.orders.filter((o) => o.projectId === projectId),
    }))
  })

  it('GET /api/v1/supply/orders?projectId=p-1 → exactly THEIR orders in the project', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await v1SupplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.data as Array<{ id: string }>).map((o) => o.id)).toEqual(['po-1'])
    expect((body.data as Array<{ supplierId: string }>)[0].supplierId).toBe('sup-1')
  })

  it('the pin is per-session — the second supplier sees the other row, never both', async () => {
    sessionFor('supplier', { supplierId: 'sup-2' })
    const res = await v1SupplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.data as Array<{ id: string }>).map((o) => o.id)).toEqual(['po-2'])
  })

  it('a project they have never sold to → the honest empty page', async () => {
    sessionFor('supplier', { supplierId: 'sup-2' })
    const res = await v1SupplyOrdersGet(getReq('http://localhost/api/v1/supply/orders?projectId=p-2'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.data).toEqual([])
  })

  it('GET /api/v1/supply/orders/:id foreign → the BYTE-IDENTICAL 404 an unknown id produces', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const foreign = await v1SupplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-2'), ctx('po-2'))
    const unknown = await v1SupplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-x'), ctx('po-x'))
    expect(foreign.status).toBe(404)
    expect(unknown.status).toBe(404)
    const foreignBody = await bodyOf(foreign)
    const unknownBody = await bodyOf(unknown)
    expect(foreignBody).toEqual(unknownBody)
    expect(foreignBody).toEqual({ error: 'Order not found' })
  })

  it('GET /api/v1/supply/orders/:id with no link → 403 fail closed', async () => {
    sessionFor('supplier', { supplierId: null })
    const res = await v1SupplyOrderDetailGet(getReq('http://localhost/api/v1/supply/orders/po-1'), ctx('po-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Supplier account has no supplier linked' })
  })

  it('GET /api/v1/projects/:id/deliveries → only the deliveries against THEIR orders', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await v1ProjectDeliveriesGet(getReq('http://localhost/api/v1/projects/p-1/deliveries'), ctx('p-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.data as Array<{ id: string; orderId: string }>).map((r) => r.id)).toEqual(['dlv-1'])
  })

  it('GET /api/v1/projects/:id/deliveries with no link → 403 fail closed', async () => {
    sessionFor('supplier', { supplierId: null })
    const res = await v1ProjectDeliveriesGet(getReq('http://localhost/api/v1/projects/p-1/deliveries'), ctx('p-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Supplier account has no supplier linked' })
  })

  it('GET /api/v1/invoices/:id foreign → the BYTE-IDENTICAL 404 an unknown id produces (probe by id AND code)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const foreign = await v1InvoiceDetailGet(getReq('http://localhost/api/v1/invoices/inv-2'), ctx('inv-2'))
    const unknown = await v1InvoiceDetailGet(getReq('http://localhost/api/v1/invoices/inv-x'), ctx('inv-x'))
    expect(foreign.status).toBe(404)
    expect(unknown.status).toBe(404)
    const foreignBody = await bodyOf(foreign)
    const unknownBody = await bodyOf(unknown)
    expect(foreignBody).toEqual(unknownBody)
    expect(foreignBody).toEqual({ error: 'Invoice not found' })

    const byCode = await v1InvoiceDetailGet(getReq('http://localhost/api/v1/invoices/INV-2026-000028'), ctx('INV-2026-000028'))
    expect(byCode.status).toBe(404)
    expect(await bodyOf(byCode)).toEqual({ error: 'Invoice not found' })
  })

  it('GET /api/v1/invoices/:id with no link → 403 fail closed', async () => {
    sessionFor('supplier', { supplierId: null })
    const res = await v1InvoiceDetailGet(getReq('http://localhost/api/v1/invoices/inv-1'), ctx('inv-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Supplier account has no supplier linked' })
  })
})

// --------------------------------------------------------- migration + seed

describe('the migration is additive-only (house rule for the shared DB)', () => {
  // 4_ — the web-push branch (merging first) takes 3_push_subscription; this
  // one lands after it in the sequence.
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/4_supplier_user_link/migration.sql', import.meta.url)),
    'utf8',
  )

  it('is exactly ONE ALTER TABLE ADD COLUMN — no CREATE INDEX, no constraint, no data mutation', () => {
    // Strip the explanatory comments first — they legitimately SAY what the
    // migration deliberately does NOT do.
    const code = sql.replace(/--.*$/gm, '').trim()
    const statements = code.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toBe('ALTER TABLE "User" ADD COLUMN "supplierId" TEXT')
    for (const forbidden of ['DROP', 'UPDATE', 'INSERT', 'DELETE', 'CREATE INDEX', 'ADD CONSTRAINT', 'REFERENCES', 'NOT NULL']) {
      expect(code.toUpperCase()).not.toContain(forbidden)
    }
  })

  it('the column is nullable (every existing row = NULL = not a supplier account — fails closed)', () => {
    expect(sql).toContain('ADD COLUMN "supplierId" TEXT')
  })

  it('schema.prisma declares the same additive column (scalar link, no FK relation)', () => {
    const schema = readFileSync(fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)), 'utf8')
    expect(schema).toContain('supplierId   String?')
    // No relation added — the migration stays a plain column.
    expect(schema).not.toContain('supplierId  Supplier?')
    expect(schema).not.toContain('supplier    Supplier?')
  })
})

describe('the demo journey is seeded (supplier login, PO awaiting confirmation, README row)', () => {
  it('users seed: supplier@mjengo.os / supplier2026, role supplier, linked to the seeded Supplier', () => {
    const src = readFileSync(fileURLToPath(new URL('../../prisma/seed-extras/users.ts', import.meta.url)), 'utf8')
    expect(src).toContain('supplier@mjengo.os')
    expect(src).toContain("hashPassword('supplier2026')")
    expect(src).toContain("role: 'supplier'")
    expect(src).toContain('supplierId: nairobiHardware.id')
    // Looked up by NAME, never a hard id (the house seed rule).
    expect(src).toContain("businessName: { contains: 'Nairobi Hardware' }")
  })

  it('supply seed: PO-2026-000013 SENT to Nairobi Hardware — the portal demo journey', () => {
    const src = readFileSync(fileURLToPath(new URL('../../prisma/seed-extras/supply.ts', import.meta.url)), 'utf8')
    expect(src).toContain("'PO-2026-000013'")
    expect(src).toContain('supplierId: nairobiHardware.id')
    expect(src).toContain("status: 'sent'")
  })

  it('README demo table carries the supplier row', () => {
    const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
    expect(readme).toContain('`supplier@mjengo.os`')
    expect(readme).toContain('`supplier2026`')
  })

  it('login screen demo list gets the supplier row', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/frontend/auth/login-screen.tsx', import.meta.url)), 'utf8')
    expect(src).toContain("email: 'supplier@mjengo.os'")
    expect(src).toContain("password: 'supplier2026'")
    expect(src).toContain("role: 'supplier'")
    expect(src).toContain("hintKey: 'login.demo.supplier'")
  })
})

// ---------------------------------------------------------------- i18n block

describe('i18n — the "# W5-3 supplier" end-append block ships en + sw together', () => {
  const dictSrc = (which: 'en' | 'sw') =>
    readFileSync(fileURLToPath(new URL(`../../src/frontend/i18n/dicts/${which}.ts`, import.meta.url)), 'utf8')

  const keysAfterMarker = (src: string): string[] => {
    const marker = src.indexOf('# W5-3 supplier')
    expect(marker).toBeGreaterThan(-1)
    return [...src.slice(marker).matchAll(/^  '([a-zA-Z0-9.]+)':/gm)].map((m) => m[1])
  }

  it('both dicts carry the end-append marker', () => {
    expect(keysAfterMarker(dictSrc('en')).length).toBeGreaterThan(80)
    expect(keysAfterMarker(dictSrc('sw')).length).toBeGreaterThan(80)
  })

  it('the two blocks have IDENTICAL key sets (per-wave parity, on the day the feature merges)', () => {
    expect(keysAfterMarker(dictSrc('sw'))).toEqual(keysAfterMarker(dictSrc('en')))
  })

  it('the dynamic role + nav keys the matrix and login hint need exist in both', () => {
    for (const src of [dictSrc('en'), dictSrc('sw')]) {
      expect(src).toContain("'nav.supplier'")
      expect(src).toContain("'nav.short.supplier'")
      expect(src).toContain("'role.supplier'")
      expect(src).toContain("'login.demo.supplier'")
    }
  })
})
