/**
 * Issue #163 / audit API-12 — the /api/search LIKE is pushed DOWN into the
 * Prisma queries (`contains` → SQLite LIKE), replacing the in-memory filter
 * over a pre-fetched 300-raw-row window. This file pins the ROUTE-LEVEL
 * contract of the pushdown against Prisma-faithful stubs:
 *
 *   · every one of the ten source queries carries the pushed-down where
 *     clause (the SAME fields the old in-memory filter scanned), keeps
 *     `take: 300` and the recent-first order (createdAt DESC — worker has
 *     no timestamp column and stays bare-take);
 *   · sanitize() is load-bearing: % and _ are stripped BEFORE they reach a
 *     contains value (Prisma does NOT escape LIKE wildcards on SQLite —
 *     pinned on the real engine in search-pushdown-realdb.test.ts — so an
 *     unstripped wildcard would act as a pattern);
 *   · the response shape is unchanged (ok / q / scopedTo / groups) and gains
 *     `note` ONLY when a source table's 300-match window truncated (the
 *     honesty seam — a capped result is never silent);
 *   · client-role pinning: projectId rides the where clause of every scoped
 *     table (and the project query is by id);
 *   · case: the query is lowercased and the stub mirrors SQLite's ASCII
 *     case-insensitive LIKE (real-engine pin in the realdb file).
 *
 * The full parity story (old in-memory algorithm vs the pushdown on a
 * shared fixture set, real engine) lives in search-pushdown-realdb.test.ts.
 *
 * Mocks mirror tests/unit/search-rate-limit.test.ts: full fake guard
 * (session control) + the ten search tables stubbed (findMany is
 * Prisma-faithful for where.OR contains / where.<field> contains / where.id
 * / where.projectId / orderBy / take). The route, route-kit, guard wrapper
 * and the REAL token-bucket store run.
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  session: {
    user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null },
  } as unknown as Record<string, unknown> | null,
}))

// Full fake guard (the search-rate-limit idiom — mirrors guard.ts 1:1, so the
// mocked getSessionFromReq IS the one withGuard consults).
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const KNOWN_ROLES = ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs', 'supplier']
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
        if (opts?.roles && !opts.roles.includes((session as { user: { role: string } }).user.role)) {
          return NextResponse.json({ error: `Not permitted for role "${(session as { user: { role: string } }).user.role}"` }, { status: 403 })
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

// ------------------------------------------------------------------ fixtures

type Row = Record<string, unknown>
type ContainsTerm = { contains?: string }
type FindManyArgs = {
  where?: { id?: string; projectId?: string; OR?: Array<Record<string, ContainsTerm>> } & Row
  orderBy?: { createdAt?: 'asc' | 'desc' }
  take?: number
}

/** The captured call args, per table (the pushdown shape pins). */
const calls: Record<string, FindManyArgs[]> = {}

/** The fixture rows, per table (mutable — the cap tests swap the project set). */
const SEED: Record<string, Row[]> = {
  project: [
    { id: 'prj-1', name: 'AbC vIlLaS', client: 'Alpha Client', location: 'Westlands', status: 'active', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'prj-2', name: 'Harbour Court', client: 'Beta Client', location: 'Mombasa', status: 'completed', createdAt: '2026-01-01T00:00:00Z' },
  ],
  landParcel: [{ id: 'par-1', plotNumber: 'LR 209/123', county: 'Nairobi', town: 'Westlands', status: 'verified', project: { name: 'Pushdown Estate' }, createdAt: '2026-01-02T00:00:00Z' }],
  worker: [
    { id: 'wrk-1', name: 'evil master fundi', role: 'Foreman', active: true, project: { name: 'Pushdown Estate' } },
    { id: 'wrk-2', name: 'evilXmasterX drill operator', role: 'Driller', active: false, project: { name: 'Pushdown Estate' } },
  ],
  supplier: [{ id: 'sup-1', businessName: 'Westlands Hardware', county: 'Nairobi', town: null, verificationState: 3, createdAt: '2026-01-02T00:00:00Z' }],
  catalogItem: [{ id: 'cat-1', name: 'Cement 50kg', brand: 'Simba', specification: '42.5N', unit: 'bag', supplier: { businessName: 'Westlands Hardware', county: 'Nairobi' }, createdAt: '2026-01-02T00:00:00Z' }],
  materialRequest: [{ id: 'req-1', requestCode: 'MR-1042', status: 'submitted', lines: [], project: { name: 'Pushdown Estate' }, createdAt: '2026-01-02T00:00:00Z' }],
  purchaseOrder: [{ id: 'po-1', orderCode: 'PO-2026-000012', status: 'sent', supplier: { businessName: 'Westlands Hardware' }, project: { name: 'Pushdown Estate' }, createdAt: '2026-01-02T00:00:00Z' }],
  transaction: [{ id: 'txn-1', reference: 'MPESA-ABC123', note: 'Cement delivery', type: 'material', amount: 6500050n, project: { name: 'Pushdown Estate' }, createdAt: '2026-01-02T00:00:00Z' }],
  invoice: [{ id: 'inv-1', invoiceCode: 'INV-2026-000031', status: 'submitted', total: 6500050n, project: { name: 'Pushdown Estate' }, createdAt: '2026-01-02T00:00:00Z' }],
  notification: [{ id: 'ntf-1', title: 'Cement delivered', body: 'The cement delivery arrived on site', project: { name: 'Pushdown Estate' }, createdAt: '2026-01-02T00:00:00Z' }],
}

/** SQLite-LIKE-faithful contains: substring, ASCII case-insensitive
 *  (function declaration — hoisted, so the vi.mock factory below can build
 *  its closures before the module body runs; SEED/calls are only deref'd
 *  at CALL time, when tests run). */
function faithfulFindMany(table: string) {
  return async (args?: FindManyArgs) => {
    if (!calls[table]) calls[table] = []
    calls[table].push(args ?? {})
    let out = SEED[table] ?? []
    const where = args?.where ?? {}
    if (where.id !== undefined) out = out.filter((r) => r.id === where.id)
    if (where.projectId !== undefined) out = out.filter((r) => r.projectId === where.projectId)
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'id' || key === 'projectId' || key === 'OR') continue
      const needle = (cond as ContainsTerm)?.contains
      if (typeof needle === 'string') {
        out = out.filter((r) => typeof r[key] === 'string' && String(r[key]).toLowerCase().includes(needle.toLowerCase()))
      }
    }
    if (Array.isArray(where.OR)) {
      out = out.filter((r) =>
        where.OR!.some((term) =>
          Object.entries(term).some(
            ([field, cond]) =>
              typeof r[field] === 'string' &&
              String(r[field]).toLowerCase().includes(String((cond as ContainsTerm)?.contains ?? '').toLowerCase()),
          ),
        ),
      )
    }
    if (args?.orderBy?.createdAt) {
      const dir = args.orderBy.createdAt === 'desc' ? -1 : 1
      out = [...out].sort((a, b) => dir * (new Date(String(a.createdAt)).getTime() - new Date(String(b.createdAt)).getTime()))
    }
    return (args?.take ? out.slice(0, args.take) : out).map((r) => ({ ...r }))
  }
}

vi.mock('@/backend/lib/db', () => ({
  db: {
    project: { findMany: faithfulFindMany('project') },
    landParcel: { findMany: faithfulFindMany('landParcel') },
    worker: { findMany: faithfulFindMany('worker') },
    supplier: { findMany: faithfulFindMany('supplier') },
    catalogItem: { findMany: faithfulFindMany('catalogItem') },
    materialRequest: { findMany: faithfulFindMany('materialRequest') },
    purchaseOrder: { findMany: faithfulFindMany('purchaseOrder') },
    transaction: { findMany: faithfulFindMany('transaction') },
    invoice: { findMany: faithfulFindMany('invoice') },
    notification: { findMany: faithfulFindMany('notification') },
  },
}))

import { GET as searchGet } from '@/app/api/search/route'

function searchGetReq(q: string): NextRequest {
  return new NextRequest(`http://localhost/api/search?q=${encodeURIComponent(q)}`)
}

beforeEach(() => {
  for (const t of Object.keys(calls)) calls[t].length = 0
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
  h.session = {
    user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null },
  }
})

describe('GET /api/search — the #163 SQL pushdown (API-12)', () => {
  it('every one of the ten source queries carries the pushed-down LIKE, take 300, recent-first order', async () => {
    const res = await searchGet(searchGetReq('needle'))
    expect(res.status).toBe(200)
    // one findMany per table
    for (const t of Object.keys(calls)) expect(calls[t], `table ${t}`).toHaveLength(1)

    const contains = (q: string) => ({ contains: q })
    expect(calls.project[0]).toEqual({
      where: { OR: [{ name: contains('needle') }, { client: contains('needle') }, { location: contains('needle') }] },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })
    expect(calls.landParcel[0]).toEqual({
      where: { OR: [{ plotNumber: contains('needle') }, { county: contains('needle') }, { town: contains('needle') }] },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { project: { select: { name: true } } },
    })
    expect(calls.worker[0]).toEqual({
      where: { OR: [{ name: contains('needle') }, { role: contains('needle') }] },
      take: 300, // Worker has no createdAt column — bare take, no orderBy
      include: { project: { select: { name: true } } },
    })
    expect(calls.worker[0]!.orderBy).toBeUndefined()
    expect(calls.supplier[0]).toEqual({
      where: { OR: [{ businessName: contains('needle') }, { county: contains('needle') }, { town: contains('needle') }] },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })
    expect(calls.catalogItem[0]).toEqual({
      where: { OR: [{ name: contains('needle') }, { brand: contains('needle') }, { specification: contains('needle') }] },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { supplier: { select: { businessName: true, county: true } } },
    })
    expect(calls.materialRequest[0]).toEqual({
      where: { requestCode: contains('needle') },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { project: { select: { name: true } }, lines: true },
    })
    expect(calls.purchaseOrder[0]).toEqual({
      where: { orderCode: contains('needle') },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { project: { select: { name: true } }, supplier: { select: { businessName: true } } },
    })
    expect(calls.transaction[0]).toEqual({
      where: { OR: [{ reference: contains('needle') }, { note: contains('needle') }] },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { project: { select: { name: true } } },
    })
    expect(calls.invoice[0]).toEqual({
      where: { invoiceCode: contains('needle') },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { project: { select: { name: true } } },
    })
    expect(calls.notification[0]).toEqual({
      where: { OR: [{ title: contains('needle') }, { body: contains('needle') }] },
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { project: { select: { name: true } } },
    })
  })

  it("sanitize is load-bearing: a user's % and _ never reach a contains value", async () => {
    // Prisma does NOT escape LIKE wildcards on SQLite (probe-pinned on the
    // real engine) — sanitize() is what keeps them literal. 'a%b_c' must
    // arrive at EVERY table as 'a b c'.
    const res = await searchGet(searchGetReq('a%b_c'))
    expect(res.status).toBe(200)
    expect(Object.keys(calls)).toHaveLength(10)
    for (const [table, tableCalls] of Object.entries(calls)) {
      for (const c of tableCalls) {
        const serialized = JSON.stringify(c.where ?? {})
        expect(serialized, `table ${table}: no raw % reaches the LIKE`).not.toContain('%')
        expect(serialized, `table ${table}: no raw _ reaches a contains value`).not.toMatch(/"contains":"[^"]*_/)
        expect(serialized, `table ${table}: sanitized needle`).toContain('"contains":"a b c"')
      }
    }
  })

  it("a wildcard needle is treated literally: 'evil%master' matches only literal 'evil master' data", async () => {
    // Worker rows: 'evil master fundi' (literal space) vs 'evilXmasterX'
    // (would match an unstripped % pattern). The sanitized needle
    // 'evil master' finds only the literal row.
    const res = await searchGet(searchGetReq('evil%master'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups?: Array<{ group: string; items: Array<{ id: string }> }> }
    const workers = body.groups?.find((g) => g.group === 'Workers')
    expect(workers?.items.map((i) => i.id)).toEqual(['wrk-1'])
  })

  it('response shape unchanged (ok/q/scopedTo/groups, no note) when the cap never bites', async () => {
    const res = await searchGet(searchGetReq('westlands'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['groups', 'ok', 'q', 'scopedTo'])
    expect(body.ok).toBe(true)
    expect(body.q).toBe('westlands')
    expect(body.scopedTo).toBeNull()
    // the fixture's Westlands hits: the project (location), the parcel
    // (town), the supplier (businessName) — grouped, ≤5 each
    const groups = (body.groups as Array<{ group: string }>).map((g) => g.group)
    expect(groups).toContain('Projects')
    expect(groups).toContain('Land parcels')
    expect(groups).toContain('Suppliers')
  })

  it('ASCII case-insensitivity through the lowercased needle (q folds to the row, not the reverse)', async () => {
    // Row 'AbC vIlLaS', query 'ABC VILLAS' → sanitized+lowercased 'abc
    // villas' → SQLite LIKE (ASCII case-insensitive) finds it. The stub
    // mirrors the engine; the real-engine pin lives in the realdb file.
    const res = await searchGet(searchGetReq('ABC VILLAS'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups?: Array<{ group: string; items: Array<{ id: string; title: string }> }> }
    const projects = body.groups?.find((g) => g.group === 'Projects')
    expect(projects?.items.map((i) => i.id)).toEqual(['prj-1'])
    expect(projects?.items[0]?.title).toBe('AbC vIlLaS')
  })

  it('the honesty seam: exactly 300 matches → note; 299 → no note', async () => {
    // 300 projects all matching 'caprow' — the take bound truncates the
    // match set (or exactly meets it): the note MUST say so.
    SEED.project = Array.from({ length: 300 }, (_, i) => ({
      id: `cap-${i}`, name: `caprow project ${i}`, client: 'C', location: 'L', status: 'active',
      createdAt: new Date(Date.now() + i).toISOString(),
    }))
    try {
      const res = await searchGet(searchGetReq('caprow'))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { note?: string; groups?: Array<{ group: string; items: unknown[] }> }
      expect(body.note).toBe('Match cap reached — at least one table has 300+ matches for this query; refine it to see older matches')
      expect(body.groups?.[0]?.items).toHaveLength(5) // MAX_PER_GROUP still bounds the payload
    } finally {
      SEED.project = [
        { id: 'prj-1', name: 'AbC vIlLaS', client: 'Alpha Client', location: 'Westlands', status: 'active', createdAt: '2026-01-02T00:00:00Z' },
        { id: 'prj-2', name: 'Harbour Court', client: 'Beta Client', location: 'Mombasa', status: 'completed', createdAt: '2026-01-01T00:00:00Z' },
      ]
    }

    // 299 matches → the cap did not truncate → no note (silent-free cut both ways)
    SEED.project = Array.from({ length: 299 }, (_, i) => ({
      id: `und-${i}`, name: `undercap project ${i}`, client: 'C', location: 'L', status: 'active',
      createdAt: new Date(Date.now() + i).toISOString(),
    }))
    try {
      const res = await searchGet(searchGetReq('undercap'))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { note?: string }
      expect(body.note).toBeUndefined()
    } finally {
      SEED.project = [
        { id: 'prj-1', name: 'AbC vIlLaS', client: 'Alpha Client', location: 'Westlands', status: 'active', createdAt: '2026-01-02T00:00:00Z' },
        { id: 'prj-2', name: 'Harbour Court', client: 'Beta Client', location: 'Mombasa', status: 'completed', createdAt: '2026-01-01T00:00:00Z' },
      ]
    }
  })

  it('client-role pinning: projectId rides the where clause of every scoped table', async () => {
    h.session = {
      user: { id: 'u-2', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p-pin' },
    }
    const res = await searchGet(searchGetReq('needle'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scopedTo?: string | null }
    expect(body.scopedTo).toBe('p-pin')

    // the project query is by id (+ the pushed-down LIKE); every scoped
    // sibling carries projectId: 'p-pin'; the two global tables don't
    expect(calls.project[0]!.where).toEqual({
      id: 'p-pin',
      OR: [
        { name: { contains: 'needle' } },
        { client: { contains: 'needle' } },
        { location: { contains: 'needle' } },
      ],
    })
    for (const t of ['landParcel', 'worker', 'materialRequest', 'purchaseOrder', 'transaction', 'invoice', 'notification']) {
      expect(calls[t][0]!.where?.projectId, `table ${t} scoped`).toBe('p-pin')
    }
    for (const t of ['supplier', 'catalogItem']) {
      expect(calls[t][0]!.where?.projectId, `table ${t} is global (not project-scoped)`).toBeUndefined()
    }
  })
})
