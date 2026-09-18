/**
 * Issue #166 + issue #163 — the /api/search projects window is recent-first,
 * and since #163 the LIKE runs INSIDE the query (SQL pushdown).
 *
 * #166 (the bug): the unpinned projects query used to order createdAt ASC —
 * the window kept the OLDEST 300 raw rows, so with >300 rows every newly
 * created project was unfindable by exact-name search. Pinned: the query
 * asks createdAt DESC + take 300 (the sibling posture), and the NEWEST row
 * is inside the searchable window.
 *
 * #163 (the structural fix, API-12): the window is now pushed down as a
 * Prisma `contains` WHERE clause with the SAME take bound — so it caps
 * MATCHES per table (≤300 most-recent matches), not raw rows. Consequences
 * pinned here:
 *   · the query itself carries the OR-of-contains where (name/client/
 *     location — the fields the old in-memory filter scanned);
 *   · a name that exists ONLY on the OLDEST row — beyond ANY 300-recent-raw
 *     window — is now FOUND (the pre-#163 "honestly missed" ceiling on row
 *     recency is gone; exact-name search finds rows of any age);
 *   · the ceiling that remains: a query matching ALL 320 seeded rows hits
 *     the 300-match cap — the oldest matches are honestly missed AND the
 *     response says so via `note` (no silent truncation);
 *   · a client-role session pinned to its own project still bypasses the
 *     window query entirely (where: { id, OR } — no orderBy/take).
 *
 * Mocks mirror tests/unit/search-rate-limit.test.ts: full fake guard
 * (session control) + the ten search tables stubbed (project.findMany is
 * Prisma-faithful — honors where.id, where.OR contains, orderBy, take;
 * the rest return []). The route, route-kit, guard wrapper and the REAL
 * token-bucket store run.
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

/** One seeded project row — createdAt strictly increasing with the index. */
interface ProjectRow {
  id: string
  name: string
  client: string
  location: string
  status: string
  createdAt: Date
}

const BASE = new Date('2025-01-01T00:00:00Z').getTime()

/** 320 projects: index 0 is the OLDEST, 319 the NEWEST (distinct timestamps). */
const PROJECTS: ProjectRow[] = Array.from({ length: 320 }, (_, i) => ({
  id: `p-${i}`,
  name: `window-project-${String(i).padStart(3, "0")}`,
  client: `Client ${i}`,
  location: 'Kenya',
  status: 'active',
  createdAt: new Date(BASE + i * 60_000),
}))

type ContainsTerm = { contains?: string }
type ProjectArgs = {
  where?: { id?: string; OR?: Array<Record<string, ContainsTerm>> }
  orderBy?: { createdAt?: 'asc' | 'desc' }
  take?: number
}

const projectCalls: ProjectArgs[] = []

vi.mock('@/backend/lib/db', () => {
  // Prisma-faithful project.findMany — the semantics the #166/#163 window
  // contract rides on:
  //   · where.id (the pinned-client path);
  //   · where.OR of { field: { contains } } — SQLite-LIKE-faithful: substring,
  //     ASCII case-insensitive (mirrors the engine behavior pinned on the
  //     real DB in search-pushdown-realdb.test.ts);
  //   · orderBy.createdAt asc/desc, then take.
  // Every other source table returns [] (their clause shapes are pinned in
  // search-pushdown.test.ts; this file pins the projects regression only).
  const projectFindMany = async (args?: ProjectArgs) => {
    projectCalls.push(args ?? {})
    let rows: ProjectRow[] = PROJECTS
    if (args?.where?.id) rows = rows.filter((p) => p.id === args.where?.id)
    const or = args?.where?.OR
    if (or) {
      rows = rows.filter((p) =>
        or.some((term) =>
          Object.entries(term).some(([field, cond]) => {
            const value = (p as unknown as Record<string, string>)[field]
            return Boolean(cond.contains && value.toLowerCase().includes(cond.contains.toLowerCase()))
          }),
        ),
      )
    }
    if (args?.orderBy?.createdAt) {
      const dir = args.orderBy.createdAt === 'desc' ? -1 : 1
      rows = [...rows].sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()))
    }
    return args?.take ? rows.slice(0, args.take) : rows
  }
  const empty = async () => []
  return {
    db: {
      project: { findMany: projectFindMany },
      landParcel: { findMany: empty },
      worker: { findMany: empty },
      supplier: { findMany: empty },
      catalogItem: { findMany: empty },
      materialRequest: { findMany: empty },
      purchaseOrder: { findMany: empty },
      transaction: { findMany: empty },
      invoice: { findMany: empty },
      notification: { findMany: empty },
    },
  }
})

import { GET as searchGet } from '@/app/api/search/route'

function searchReq(q: string, principalIp?: string): NextRequest {
  return new NextRequest(`http://localhost/api/search?q=${encodeURIComponent(q)}`, {
    headers: principalIp ? { 'x-forwarded-for': principalIp } : undefined,
  })
}

const T0 = new Date('2026-01-05T09:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  projectCalls.length = 0
  process.env.NEXTAUTH_SECRET = 'unit-test-secret'
  h.session = {
    user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null },
  }
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.NEXTAUTH_SECRET
})

describe('GET /api/search — the projects window is recent-first (#166) and the LIKE is pushed down (#163)', () => {
  it('the unpinned projects query pushes the LIKE down (OR of contains) with createdAt DESC + take 300', async () => {
    const res = await searchGet(searchReq('window', '10.9.5.1'))
    expect(res.status).toBe(200)
    expect(projectCalls).toHaveLength(1)
    expect(projectCalls[0]).toEqual({
      where: {
        OR: [
          { name: { contains: 'window' } },
          { client: { contains: 'window' } },
          { location: { contains: 'window' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    })
  })

  it('with 320 projects, the NEWEST is inside the searchable window (found by exact name)', async () => {
    // The 300-match window + desc order ⇒ the 300 NEWEST matches come back.
    // The newest (319) MUST be findable — with the pre-#166 asc order it was
    // the FIRST to fall out of the window.
    const res = await searchGet(searchReq('window-project-319', '10.9.5.2'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean; groups?: Array<{ group: string; items: Array<{ id: string; title: string }> }> }
    expect(body.ok).toBe(true)
    const projectsGroup = body.groups?.find((g) => g.group === 'Projects')
    expect(projectsGroup).toBeDefined()
    expect(projectsGroup!.items.map((i) => i.id)).toContain('p-319')
  })

  it('#163: a name that exists ONLY on the OLDEST row — beyond any 300-recent-raw window — is now FOUND', async () => {
    // Row 0 is the oldest. Pre-#163 the route loaded the 300 newest RAW rows
    // and filtered in memory, so this exact-name search honestly missed it
    // (the API-12 ceiling). The pushdown removed the recency window: the
    // LIKE runs over the whole table, so the unique match is found at any
    // age. This is the headline behavior change of the pushdown.
    const res = await searchGet(searchReq('window-project-000', '10.9.5.3'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups?: Array<{ group: string; items: Array<{ id: string }> }>; note?: string }
    const projectsGroup = body.groups?.find((g) => g.group === 'Projects')
    expect(projectsGroup?.items.map((i) => i.id)).toContain('p-0')
    expect(body.note).toBeUndefined() // one match — the cap never bit
  })

  it('the ceiling that REMAINS: a query matching all 320 rows hits the 300-match cap — oldest missed, note honest', async () => {
    // 'window-project' matches every seeded row. The take: 300 bound now
    // caps MATCHES (not raw rows): the 320 matches truncate to the newest
    // 300 (rows 319..20), the oldest 20 are honestly missed — and the
    // response SAYS so (the note seam — no silent truncation).
    const res = await searchGet(searchReq('window-project', '10.9.5.4'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups?: Array<{ group: string; items: Array<{ id: string }> }>; note?: string }
    const projectsGroup = body.groups?.find((g) => g.group === 'Projects')
    expect(projectsGroup?.items.map((i) => i.id)).toContain('p-319') // newest 5 shown
    expect(projectsGroup?.items.map((i) => i.id)).not.toContain('p-0') // beyond the 300-match cap
    expect(body.note).toBe('Match cap reached — at least one table has 300+ matches for this query; refine it to see older matches')
  })

  it('a project just inside the match-window edge (row 20 of 320) is still searchable', async () => {
    const res = await searchGet(searchReq('window-project-020', '10.9.5.5'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups?: Array<{ group: string; items: Array<{ id: string }> }> }
    const projectsGroup = body.groups?.find((g) => g.group === 'Projects')
    expect(projectsGroup?.items.map((i) => i.id)).toContain('p-20')
  })

  it('a client-role session pinned to its project bypasses the window query (where: { id, OR })', async () => {
    h.session = {
      user: { id: 'u-2', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p-319' },
    }
    const res = await searchGet(searchReq('window-project-319', '10.9.5.6'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scopedTo?: string | null; groups?: Array<{ group: string; items: Array<{ id: string }> }> }
    expect(body.scopedTo).toBe('p-319')
    expect(projectCalls).toHaveLength(1)
    // no orderBy/take on the pinned path — the single project by id, with the
    // pushed-down LIKE as the only other term
    expect(projectCalls[0]).toEqual({
      where: {
        id: 'p-319',
        OR: [
          { name: { contains: 'window-project-319' } },
          { client: { contains: 'window-project-319' } },
          { location: { contains: 'window-project-319' } },
        ],
      },
    })
    const projectsGroup = body.groups?.find((g) => g.group === 'Projects')
    expect(projectsGroup?.items.map((i) => i.id)).toContain('p-319')
  })
})
