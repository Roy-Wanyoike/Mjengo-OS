// Issue #175 (SEC-7) — unpinned client fail-closed edges.
//
// Pinned through the REAL route handlers (same pattern as
// share-token-binding.test.ts):
//   · GET /api/project with a client session that has NO projectId → 403
//     "No project assigned to this account" (previously fell through to the
//     owner first-project default and read a foreign project + its
//     shareToken).
//   · POST /api/notifications with a client session whose pin is NULL → 403
//     (the check previously SKIPPED entirely when the pin was null).
//   · Control: an owner (contractor) with no ?projectId keeps the documented
//     first-project default (fresh-contractor load path).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = { session: null as null | { user: { id: string; role: string; projectId?: string | null; supplierId?: string | null; name: string; email: string } } }

vi.mock('@/backend/lib/guard', async () => {
  const unauthorized = () => NextResponse.json({ error: 'Sign in required' }, { status: 401 })
  const forbidden = (role?: string) =>
    NextResponse.json({ error: role ? `Not permitted for role "${role}"` : 'Not permitted' }, { status: 403 })
  // Mirrors the REAL withGuard(handler, opts?) => (req, ctx) => handler(session, req, ctx):
  // session from the mocked getSessionFromReq; roles omitted so the pin logic is what's under test.
  const getSessionFromReq = vi.fn(async () => h.session)
  return {
    getSessionFromReq,
    unauthorized,
    forbidden,
    safeErrorMessage: (e: unknown) => (e instanceof Error ? e.message : 'error'),
    withGuard: (handler: (req: NextRequest, session: unknown, ctx?: unknown) => Promise<NextResponse>) =>
      async (req: NextRequest) => handler(req, await getSessionFromReq(req), undefined),
  }
})

vi.mock('@/backend/lib/db', () => {
  const P1 = { id: 'p-1', name: 'Riverside Villas', shareToken: 'tok-1', status: 'active' }
  return {
    db: {
      project: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => (where.id === 'p-1' ? P1 : null)),
        findFirst: vi.fn(async () => P1),
      },
      auditEvent: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
      domainEvent: { findMany: vi.fn(async () => []) },
      sitePhoto: { findMany: vi.fn(async () => []) },
      milestone: { findMany: vi.fn(async () => []) },
      purchaseOrder: { findMany: vi.fn(async () => []) },
      orderDelivery: { findMany: vi.fn(async () => []) },
      invoice: { findMany: vi.fn(async () => []) },
      notification: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    },
  }
})

vi.mock('@/backend/lib/mjengo', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/backend/lib/mjengo')>()
  return {
    ...original,
    getProjectPayload: vi.fn(async (projectId?: string | null) =>
      projectId === 'p-1' || projectId == null
        ? ({ project: { id: 'p-1', name: 'Riverside Villas', shareToken: 'tok-1' } } as never)
        : null,
    ),
  }
})

import { GET as projectGet } from '@/app/api/project/route'
import { POST as notificationsPost } from '@/app/api/notifications/route'

const req = (url: string, init?: RequestInit) =>
  new NextRequest(`http://localhost${url}`, { headers: { 'content-type': 'application/json' }, ...init })

beforeEach(() => {
  h.session = null
})

describe('GET /api/project — unpinned client fails closed (issue #175)', () => {
  it('client session with NO projectId gets 403, never the first-project default', async () => {
    h.session = { user: { id: 'u-c', role: 'client', projectId: null, name: 'C', email: 'c@t' } }
    const res = await projectGet(req('/api/project'))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('No project assigned')
  })

  it('pinned client still reads exactly their project', async () => {
    h.session = { user: { id: 'u-c', role: 'client', projectId: 'p-1', name: 'C', email: 'c@t' } }
    const res = await projectGet(req('/api/project'))
    expect(res.status).toBe(200)
  })

  it('owner without ?projectId keeps the first-project default (fresh-contractor load)', async () => {
    h.session = { user: { id: 'u-o', role: 'contractor', projectId: null, name: 'O', email: 'o@t' } }
    const res = await projectGet(req('/api/project'))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/notifications — null client pin no longer skips the check (issue #175)', () => {
  it('unpinned client is refused for ANY projectId (was fail-open)', async () => {
    h.session = { user: { id: 'u-c', role: 'client', projectId: null, name: 'C', email: 'c@t' } }
    const res = await notificationsPost(
      req('/api/notifications', { method: 'POST', body: JSON.stringify({ projectId: 'p-1' }) }),
    )
    expect(res.status).toBe(403)
  })

  it('pinned client marking their own project still succeeds', async () => {
    h.session = { user: { id: 'u-c', role: 'client', projectId: 'p-1', name: 'C', email: 'c@t' } }
    const res = await notificationsPost(
      req('/api/notifications', { method: 'POST', body: JSON.stringify({ projectId: 'p-1' }) }),
    )
    expect(res.status).not.toBe(403)
  })
})
