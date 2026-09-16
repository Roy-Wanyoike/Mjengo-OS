/**
 * Issue #166 — the /api/search projects window is recent-first.
 *
 * The unpinned (portfolio) projects query loads at most MAX_SCAN (300) rows
 * before the in-memory LIKE filter, and the file's own window contract says
 * "recent-first where an order exists". Projects used to order createdAt ASC
 * — the window kept the OLDEST 300 projects, so with >300 rows every newly
 * created project was unfindable by exact-name search while stale ones stayed
 * searchable. Pinned here against a Prisma-faithful findMany (honors where /
 * orderBy / take exactly like the real client):
 *   · the query itself asks for createdAt DESC + take 300 (the sibling
 *     tables' posture — pinned via the captured call args);
 *   · with 320 seeded projects, the NEWEST one is inside the searchable
 *     window (found by exact name);
 *   · a name that exists ONLY on a row beyond the window (the oldest) is
 *     honestly missed — the S6 ceiling, not a regression;
 *   · a client-role session pinned to its own project still bypasses the
 *     window query entirely (the where: { id } path — ordering irrelevant).
 *
 * Mocks mirror tests/unit/search-rate-limit.test.ts: full fake guard
 * (session control) + the ten search tables stubbed (project.findMany is
 * Prisma-faithful; the rest return []). The route, route-kit, guard wrapper
 * and the REAL token-bucket store run.
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
          return NextResponse.json({ error: `Not permitted for role "${(session as { user: { role: string } }).user.role}` }, { status: 403 })
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

type ProjectArgs = {
  where?: { id?: string }
  orderBy?: { createdAt?: 'asc' | 'desc' }
  take?: number
}

const projectCalls: ProjectArgs[] = []

vi.mock('@/backend/lib/db', () => {
  // Prisma-faithful project.findMany: where.id filter, orderBy.createdAt
  // asc/desc, then take — the semantics the window contract rides on. Every
  // other source table returns [] (their ordering is pinned by production
  // code review; this file pins the projects regression only).
  const projectFindMany = async (args?: ProjectArgs) => {
    projectCalls.push(args ?? {})
    let rows: ProjectRow[] = PROJECTS
    if (args?.where?.id) rows = rows.filter((p) => p.id === args.where?.id)
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

describe('GET /api/search — the projects window is recent-first (issue #166)', () => {
  it('the unpinned projects query asks for createdAt DESC with take 300 (the sibling posture)', async () => {
    const res = await searchGet(searchReq('window', '10.9.5.1'))
    expect(res.status).toBe(200)
    expect(projectCalls).toHaveLength(1)
    expect(projectCalls[0]).toEqual({ orderBy: { createdAt: 'desc' }, take: 300 })
  })

  it('with 320 projects, the NEWEST is inside the searchable window (found by exact name)', async () => {
    // 300-limit window + desc order ⇒ rows 319..20 are searchable. The
    // newest (319) MUST be findable — with the pre-fix asc order it was the
    // FIRST to fall out of the window.
    const res = await searchGet(searchReq('window-project-319', '10.9.5.2'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean; groups?: Array<{ group: string; items: Array<{ id: string; title: string }> }> }
    expect(body.ok).toBe(true)
    const projectsGroup = body.groups?.find((g) => g.group === 'Projects')
    expect(projectsGroup).toBeDefined()
    expect(projectsGroup!.items.map((i) => i.id)).toContain('p-319')
  })

  it('a name that exists ONLY beyond the window (the oldest row) is honestly missed', async () => {
    // Row 0 is the oldest — outside the newest-300 window. The S6 ceiling is
    // the documented tradeoff; this pins that the fix changed WHICH rows the
    // window keeps, not the ceiling itself.
    const res = await searchGet(searchReq('window-project-000', '10.9.5.3'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups?: Array<{ group: string }> }
    expect(body.groups?.find((g) => g.group === 'Projects')).toBeUndefined()
  })

  it('a project just inside the window edge (row 20 of 320) is still searchable', async () => {
    const res = await searchGet(searchReq('window-project-020', '10.9.5.4'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { groups?: Array<{ group: string; items: Array<{ id: string }> }> }
    const projectsGroup = body.groups?.find((g) => g.group === 'Projects')
    expect(projectsGroup?.items.map((i) => i.id)).toContain('p-20')
  })

  it('a client-role session pinned to its project bypasses the window query (where: { id })', async () => {
    h.session = {
      user: { id: 'u-2', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p-319' },
    }
    const res = await searchGet(searchReq('window-project-319', '10.9.5.5'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scopedTo?: string | null; groups?: Array<{ group: string; items: Array<{ id: string }> }> }
    expect(body.scopedTo).toBe('p-319')
    expect(projectCalls).toHaveLength(1)
    expect(projectCalls[0]).toEqual({ where: { id: 'p-319' } }) // no orderBy/take on the pinned path
    const projectsGroup = body.groups?.find((g) => g.group === 'Projects')
    expect(projectsGroup?.items.map((i) => i.id)).toContain('p-319')
  })
})
