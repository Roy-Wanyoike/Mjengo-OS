/**
 * BE-12 (issue #77) — supplier sessions can only mark notifications read for
 * projects they SERVE.
 *
 * POST /api/notifications guarded only the client pin: a supplier-role
 * session could mark notifications read for ANY project (a cross-tenant
 * write every other route family already refuses — projects.ts gives
 * suppliers an empty list, actions.ts allowlists SUPPLIER_ACTIONS, sync.ts
 * 403s outright). The mutation is now scoped to supplier-visible projects —
 * the projects the session's supplier has purchase orders in (the same
 * visibility /api/supplier's `projects` slice carries; the row-pin idiom of
 * modules/supply/supplier-scope.ts applied at the route). Pinned here:
 *   · supplier + orders in the target project → 200, markRead RUNS;
 *   · supplier + NO orders of theirs in the target project → 403 'Not
 *     permitted for this project', markRead NEVER called;
 *   · supplier role with no linked supplierId → 403 fail-closed copy;
 *   · the historical branches are untouched: client pin cross-project → 403,
 *     unknown project → 404, site team (contractor) → 200.
 *
 * guard and the notify service are stubbed (the v1-projects fake-guard
 * idiom); the route + route-kit pipeline + the real rate limiter run.
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  session: {
    user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null, supplierId: null },
  } as unknown as Record<string, unknown> | null,
}))

// Full fake guard (the v1-projects idiom — mirrors guard.ts 1:1, so the
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
    sessionSupplierId: (session: { user?: { supplierId?: string | null } }) => session.user?.supplierId ?? null,
    KNOWN_ROLES,
    OWNER_ROLES,
    FINANCE_ROLES,
    PAYMENT_ROLES,
  }
})

const notifySvc = vi.hoisted(() => ({
  markRead: vi.fn(async () => ({ updated: 2 })),
}))

vi.mock('@/backend/modules/notify/service', () => ({
  markRead: notifySvc.markRead,
}))

vi.mock('@/backend/lib/db', () => {
  const state = {
    /** purchaseOrder.findFirst's answer — set per test. */
    servedOrder: { id: 'po-1' } as { id: string } | null,
    /** The where-clause the scoping query rode (asserted in tests). */
    lastWhere: undefined as { supplierId?: string; projectId?: string } | undefined,
  }
  return {
    db: {
      project: {
        async findUnique({ where }: { where: { id: string } }) {
          return where?.id === 'p-1' ? { id: 'p-1', name: 'Riverside Villas' } : null
        },
      },
      purchaseOrder: {
        async findFirst({ where }: { where: { supplierId?: string; projectId?: string } }) {
          // The scoping query itself is pinned: the supplier pin and the
          // project pin must BOTH ride the where-clause.
          state.lastWhere = where
          return state.servedOrder
        },
      },
      user: { async findUnique() { return { notificationPrefs: null } } },
      notification: { async findMany() { return [] } },
      __state: state,
    },
  }
})

import { POST as notificationsPost } from '@/backend/api/notifications'
import { db } from '@/backend/lib/db'

const dbState = (db as unknown as {
  __state: { servedOrder: { id: string } | null; lastWhere?: { supplierId?: string; projectId?: string } }
}).__state

function postReq(projectId: string, ip = '10.9.9.1'): NextRequest {
  return new NextRequest('http://localhost/api/notifications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ projectId, ids: 'all' }),
  })
}

const contractor = () => {
  h.session = { user: { id: 'u-1', email: 'foreman@test.dev', name: 'Foreman', role: 'contractor', projectId: null, supplierId: null } }
}
const supplier = (supplierId: string | null) => {
  h.session = { user: { id: 'u-s', email: 'karioke@test.dev', name: 'Karioke', role: 'supplier', projectId: null, supplierId } }
}

beforeEach(() => {
  notifySvc.markRead.mockClear()
  dbState.servedOrder = { id: 'po-1' }
  dbState.lastWhere = undefined
  contractor()
})

describe('POST /api/notifications — supplier scoping (BE-12)', () => {
  it('supplier + orders in the target project → 200 and markRead RUNS', async () => {
    supplier('sup-1')
    const res = await notificationsPost(postReq('p-1'), undefined)
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok?: boolean }).toMatchObject({ ok: true })
    expect(notifySvc.markRead).toHaveBeenCalledTimes(1)
    // the scoping query pins BOTH the supplier and the project
    expect(dbState.lastWhere).toMatchObject({ supplierId: 'sup-1', projectId: 'p-1' })
  })

  it('supplier + NO orders of theirs in the target project → 403, markRead NEVER called', async () => {
    supplier('sup-2')
    dbState.servedOrder = null // purchaseOrder.findFirst → miss
    const res = await notificationsPost(postReq('p-1'), undefined)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error?: string }).error).toBe('Not permitted for this project')
    expect(notifySvc.markRead).not.toHaveBeenCalled()
  })

  it('supplier role with NO linked supplierId → 403 fail-closed (no probe possible)', async () => {
    supplier(null)
    const res = await notificationsPost(postReq('p-1'), undefined)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error?: string }).error).toBe('Supplier account has no supplier linked')
    expect(notifySvc.markRead).not.toHaveBeenCalled()
    expect(dbState.lastWhere).toBeUndefined() // the pin check never even ran
  })

  it('client pinned to ANOTHER project → 403 (the historical branch, untouched)', async () => {
    h.session = { user: { id: 'u-c', email: 'client@test.dev', name: 'Client', role: 'client', projectId: 'p-other', supplierId: null } }
    const res = await notificationsPost(postReq('p-1'), undefined)
    expect(res.status).toBe(403)
    expect(notifySvc.markRead).not.toHaveBeenCalled()
  })

  it('unknown project → 404 (unchanged, supplier or not)', async () => {
    supplier('sup-1')
    const res = await notificationsPost(postReq('p-missing'), undefined)
    expect(res.status).toBe(404)
    expect(notifySvc.markRead).not.toHaveBeenCalled()
  })

  it('site team (contractor) → 200, no supplier scoping query at all (unchanged)', async () => {
    contractor()
    const res = await notificationsPost(postReq('p-1'), undefined)
    expect(res.status).toBe(200)
    expect(notifySvc.markRead).toHaveBeenCalledTimes(1)
    expect(dbState.lastWhere).toBeUndefined()
  })
})
