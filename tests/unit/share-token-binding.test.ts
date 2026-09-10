/**
 * Issue #102 (audit BE-1) — a share token is a bearer capability bound to
 * exactly ONE project. GET /api/project?share= must:
 *   1. answer ONLY with the token's own project — never a ?projectId-named
 *      other project, never the "first project in the DB" fallback;
 *   2. answer a ?projectId that names a different project with the same 404
 *      as an unknown id (no existence oracle);
 *   3. never echo token material on the public path (the caller already
 *      holds the one token it used) — while owner sessions keep the field
 *      (the Share dialog builds the link from it);
 *   4. keep the prior contract: 401 for missing/bogus tokens, supplier 403
 *      before any share handling, client-role pinning, owner ?projectId.
 */
import { NextRequest } from 'next/server'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------- seams

const h = vi.hoisted(() => ({
  session: null as { user: { role: string; projectId?: string | null; supplierId?: string | null } } | null,
}))

vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const getSessionFromReq = vi.fn(async () => h.session)
  return {
    getSessionFromReq,
    unauthorized: () => NextResponse.json({ error: 'Sign in required' }, { status: 401 }),
    forbidden: (role?: string) =>
      NextResponse.json(
        { error: role ? `Not permitted for role "${role}"` : 'Not permitted' },
        { status: 403 },
      ),
  }
})

vi.mock('@/backend/lib/db', () => {
  // Two projects with distinct share tokens — the cross-project probe setup.
  const P1 = { id: 'p-1', name: 'Riverside Villas', shareToken: 'tok-1', status: 'active' }
  const P2 = { id: 'p-2', name: 'Westlands Duplex', shareToken: 'tok-2', status: 'active' }
  const byToken = (t: string) => [P1, P2].find((p) => p.shareToken === t) ?? null
  const byId = (id: string) => [P1, P2].find((p) => p.id === id) ?? null
  return {
    db: {
      project: {
        findUnique: vi.fn(async ({ where }: { where: { shareToken?: string; id?: string } }) =>
          where.shareToken !== undefined ? byToken(where.shareToken) : byId(String(where.id)),
        ),
        findFirst: vi.fn(async () => P1),
      },
      // buildTimelineSlice's eight source queries — all empty in these tests.
      auditEvent: { findMany: vi.fn(async () => []) },
      domainEvent: { findMany: vi.fn(async () => []) },
      sitePhoto: { findMany: vi.fn(async () => []) },
      milestone: { findMany: vi.fn(async () => []) },
      purchaseOrder: { findMany: vi.fn(async () => []) },
      orderDelivery: { findMany: vi.fn(async () => []) },
      invoice: { findMany: vi.fn(async () => []) },
      notification: { findMany: vi.fn(async () => []) },
    },
  }
})

vi.mock('@/backend/lib/mjengo', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  return {
    ...orig,
    getProjectPayload: vi.fn(async (projectId?: string | null) =>
      projectId === 'p-1'
        ? ({ project: { id: 'p-1', name: 'Riverside Villas', shareToken: 'tok-1' }, summary: {} })
        : projectId === 'p-2'
          ? ({ project: { id: 'p-2', name: 'Westlands Duplex', shareToken: 'tok-2' }, summary: {} })
          : null,
    ),
  }
})

import { GET as projectGet } from '@/app/api/project/route'
import { getProjectPayload } from '@/backend/lib/mjengo'

// ---------------------------------------------------------------- helpers

function getReq(url: string): NextRequest {
  return new NextRequest(url, { headers: { 'content-type': 'application/json' } })
}

async function bodyOf(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  h.session = null
})

// ---------------------------------------------------------------- the fix

describe('issue #102 (BE-1): the share token binds to exactly one project', () => {
  it('?share=<tok-1> with NO projectId → the token\'s own project (never the first-project fallback)', async () => {
    const res = await projectGet(getReq('http://localhost/api/project?share=tok-1'))
    expect(res.status).toBe(200)
    expect(getProjectPayload).toHaveBeenCalledWith('p-1')
    const body = await bodyOf(res)
    expect((body.project as Record<string, unknown>).id).toBe('p-1')
  })

  it('?share=<tok-1>&projectId=p-2 (cross-project probe) → 404, and p-2 is never read', async () => {
    const res = await projectGet(getReq('http://localhost/api/project?share=tok-1&projectId=p-2'))
    expect(res.status).toBe(404)
    expect(await bodyOf(res)).toEqual({ error: 'Project not found' })
    expect(getProjectPayload).not.toHaveBeenCalled()
  })

  it('?share=<tok-1>&projectId=p-1 (honest self-reference) → 200 with p-1', async () => {
    const res = await projectGet(getReq('http://localhost/api/project?share=tok-1&projectId=p-1'))
    expect(res.status).toBe(200)
    expect(getProjectPayload).toHaveBeenCalledWith('p-1')
  })

  it('?share=<bogus> → 401 (unknown token)', async () => {
    const res = await projectGet(getReq('http://localhost/api/project?share=bogus'))
    expect(res.status).toBe(401)
  })

  it('no share, no session → 401', async () => {
    const res = await projectGet(getReq('http://localhost/api/project'))
    expect(res.status).toBe(401)
  })

  it('public share path never echoes token material (project.shareToken stripped)', async () => {
    const res = await projectGet(getReq('http://localhost/api/project?share=tok-1'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const project = body.project as Record<string, unknown>
    expect(project.shareToken).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('tok-1')
    expect(JSON.stringify(body)).not.toContain('tok-2')
  })
})

// ------------------------------------------------- unchanged prior contract

describe('the rest of the route contract is unchanged', () => {
  it('owner session + ?projectId=p-2 → 200, shareToken PRESENT (Share dialog builds the link from it)', async () => {
    h.session = { user: { role: 'contractor', projectId: null } }
    const res = await projectGet(getReq('http://localhost/api/project?projectId=p-2'))
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect((body.project as Record<string, unknown>).shareToken).toBe('tok-2')
  })

  it('client session is pinned to its own project (a ?projectId query is ignored)', async () => {
    h.session = { user: { role: 'client', projectId: 'p-1' } }
    const res = await projectGet(getReq('http://localhost/api/project?projectId=p-2'))
    expect(res.status).toBe(200)
    expect(getProjectPayload).toHaveBeenCalledWith('p-1')
  })

  it('supplier session → 403 BEFORE any share handling (W5-3 ordering preserved)', async () => {
    h.session = { user: { role: 'supplier', supplierId: 'sup-1' } }
    const res = await projectGet(getReq('http://localhost/api/project?share=tok-1'))
    expect(res.status).toBe(403)
    expect(await bodyOf(res)).toEqual({ error: 'Not permitted for role "supplier"' })
  })
})
