/**
 * Issue #172 (SEC-3r residual) — share-link expiry + confirm-before-decide,
 * the ROUTE contract. (The real-applyAction regenerate/role-gate cases live
 * in share-regenerate-gate.test.ts — a different module graph.)
 *
 * A share link is a sessionless BEARER CAPABILITY with money power
 * (milestone.decide / variation.decide release escrow). Before this fix the
 * token NEVER expired and decided with a single scripted POST. Pinned here:
 *
 *   · EXPIRY BOUNDARY — a token whose expiry is strictly in the future is
 *     live; expiry == now or 1 ms past is dead; NULL expiry (a grandfathered
 *     pre-migration-11 token / seed) stays live (documented policy).
 *   · NO ORACLE — GET /api/share answers an EXPIRED token with the exact 404
 *     body an unknown one gets; GET /api/project?share= answers the exact 401
 *     an unknown one gets (and never falls back to the first project).
 *   · CONFIRM-BEFORE-DECIDE — POST /api/share (and the /api/actions
 *     sessionless shareToken twin) refuse milestone.decide / variation.decide
 *     without a STRICT payload `confirm: true`; comment.add etc. are
 *     unaffected; the logged-in client-ROLE session path is unaffected.
 *   · MINTS STAMP EXPIRY — POST /api/projects writes shareTokenExpiresAt ≈
 *     now + SHARE_TOKEN_TTL_DAYS (default 90, env knob honored).
 *
 * Mocks (the sync-flag-gate idioms): '@/backend/lib/db' (in-memory project
 * store with expiry control), '@/backend/lib/guard' (full fake — session
 * control for withGuard/publicRoute), '@/backend/lib/mjengo' (applyAction
 * spy + payload-builder stubs). route-kit, rate-limit, mutation-safety and
 * share-token stay REAL — the gates under test are the production ones.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; projectId: string | null; supplierId: string | null } },
}))

// Full fake guard (the v1-projects idiom — mirrors guard.ts 1:1, so the
// mocked getSessionFromReq IS the one withGuard/publicRoute consult).
vi.mock('@/backend/lib/guard', async () => {
  const { NextResponse } = await import('next/server')
  const KNOWN_ROLES = ['contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs', 'supplier']
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
        if (opts?.roles && !opts.roles.includes((session as { user: { role: string } }).user.role)) {
          return NextResponse.json(
            { error: `Not permitted for role "${(session as { user: { role: string } }).user.role}"` },
            { status: 403 },
          )
        }
        return handler(req, session, ctx)
      },
    safeErrorMessage: (e: unknown, fallback: string) =>
      e instanceof Error && !e.message.includes('\n') ? e.message : fallback,
    isInternalError: (e: unknown) => e instanceof Error && e.message.includes('\n'),
    sessionSupplierId: (session: { user?: { supplierId?: string | null } }) => session.user?.supplierId ?? null,
    KNOWN_ROLES,
  }
})

// In-memory project store — the ONLY thing the token seam reads. The expiry
// column is per-row so each test plants exactly the boundary it pins.
vi.mock('@/backend/lib/db', () => {
  const state = {
    projects: [] as Array<Record<string, unknown>>,
    reset() {
      state.projects = []
    },
  }
  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: { shareToken?: string; id?: string } }) {
        if (where?.shareToken !== undefined) {
          return state.projects.find((p) => p.shareToken === where.shareToken) ?? null
        }
        return state.projects.find((p) => p.id === where?.id) ?? null
      },
      async findFirst() { return state.projects[0] ?? null },
      async findMany() { return state.projects.map((p) => ({ ...p })) },
      async create({ data }: { data: Record<string, unknown> }) {
        const row = {
          id: `p-${state.projects.length + 1}`, createdAt: new Date(), updatedAt: new Date(),
          name: '', client: '', location: '', status: 'active', budget: 0,
          startDate: new Date(), targetDate: new Date(),
          ...data,
        }
        state.projects.push(row)
        return { ...row }
      },
    },
    // buildTimelineSlice's sources (GET /api/project) — empty.
    auditEvent: { async findMany() { return [] } },
    domainEvent: { async findMany() { return [] } },
    sitePhoto: { async findMany() { return [] } },
    milestone: { async findMany() { return [] } },
    purchaseOrder: { async findMany() { return [] } },
    orderDelivery: { async findMany() { return [] } },
    invoice: { async findMany() { return [] } },
    notification: { async findMany() { return [] } },
    // actionFlagGate: no flag rows → FLAG_DEFAULTS (milestone.* is ungated).
    featureFlag: { async findMany() { return [] }, async upsert() { /* lazy-create no-op */ } },
    idempotencyRecord: {
      async findUnique() { return null },
      async create({ data }: { data: Record<string, unknown> }) { return { id: 'idem-1', ...data } },
    },
    // POST /api/projects' phase template writes.
    phase: { async create({ data }: { data: Record<string, unknown> }) { return { id: 'ph-1', ...data } } },
  }
  return { db }
})

vi.mock('@/backend/lib/mjengo', () => ({
  applyAction: vi.fn(async () => ({ ok: true, applied: true })),
  getProjectPayload: vi.fn(async (projectId?: string | null) =>
    projectId === 'p-1'
      ? { project: { id: 'p-1', name: 'Riverside Villas', shareToken: 'tok-1' }, summary: {} }
      : null,
  ),
  getProjectsList: vi.fn(async () => []),
}))

import { GET as shareGet, POST as sharePost } from '@/app/api/share/route'
import { GET as projectGet } from '@/app/api/project/route'
import { POST as actionsPost } from '@/app/api/actions/route'
import { POST as projectsPost } from '@/app/api/projects/route'
import { applyAction, getProjectPayload } from '@/backend/lib/mjengo'
import { db } from '@/backend/lib/db'
import {
  isShareTokenExpired,
  shareTokenTtlDays,
  shareTokenExpiryFromNow,
} from '@/backend/lib/share-token'

const dbState = (db as unknown as {
  __state: { projects: Array<Record<string, unknown>>; reset: () => void }
}).__state

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

const DAY = 24 * 3600 * 1000

/** Plant one project with a share token + expiry. */
function plant(opts: { id?: string; token?: string; expiresAt?: Date | null } = {}) {
  dbState.projects.push({
    id: opts.id ?? 'p-1',
    name: 'Riverside Villas',
    client: 'Mama Njeri',
    location: 'Karen',
    shareToken: opts.token ?? 'tok-1',
    shareTokenExpiresAt: opts.expiresAt !== undefined ? opts.expiresAt : new Date(Date.now() + 90 * DAY),
    startDate: new Date('2026-01-05T09:00:00Z'),
    targetDate: new Date('2026-08-01T09:00:00Z'),
    status: 'active',
    budget: 2_000_000,
    createdAt: new Date('2026-01-04T09:00:00Z'),
    updatedAt: new Date('2026-01-04T09:00:00Z'),
  })
}

let ipCounter = 0
/** Fresh per-test IP so the in-process rate limiter never carries over. */
function freshIp() {
  ipCounter += 1
  return `192.0.2.${(ipCounter % 250) + 1}`
}

const shareGetReq = (query: string) =>
  new NextRequest(`http://localhost/api/share${query}`, { headers: { 'x-forwarded-for': freshIp() } })

const sharePostReq = (body: unknown) =>
  new NextRequest('http://localhost/api/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify(body),
  })

const projectGetReq = (query: string) =>
  new NextRequest(`http://localhost/api/project${query}`, { headers: { 'x-forwarded-for': freshIp() } })

const actionsPostReq = (body: unknown) =>
  new NextRequest('http://localhost/api/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify(body),
  })

const projectsPostReq = () =>
  new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
    body: JSON.stringify({ name: 'Test Villa', budget: 1_000_000 }),
  })

const contractorSession = () => {
  h.session = { user: { id: 'u-1', email: 'c@test.dev', name: 'Contractor', role: 'contractor', projectId: null, supplierId: null } }
}
const clientSession = (projectId: string | null) => {
  h.session = { user: { id: 'u-c', email: 'client@test.dev', name: 'Mama Njeri', role: 'client', projectId, supplierId: null } }
}

let savedTtl: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  dbState.reset()
  h.session = null
  savedTtl = process.env.SHARE_TOKEN_TTL_DAYS
  delete process.env.SHARE_TOKEN_TTL_DAYS
})

afterEach(() => {
  if (savedTtl === undefined) delete process.env.SHARE_TOKEN_TTL_DAYS
  else process.env.SHARE_TOKEN_TTL_DAYS = savedTtl
})

// ------------------------------------------------- TTL knob + expiry boundary

describe('the TTL knob (SHARE_TOKEN_TTL_DAYS)', () => {
  it('defaults to 90 days; invalid/zero/negative values fall back (never dead-on-arrival mints)', () => {
    expect(shareTokenTtlDays()).toBe(90)
    process.env.SHARE_TOKEN_TTL_DAYS = '30'
    expect(shareTokenTtlDays()).toBe(30)
    for (const bad of ['abc', '0', '-5', '']) {
      process.env.SHARE_TOKEN_TTL_DAYS = bad
      expect(shareTokenTtlDays(), `SHARE_TOKEN_TTL_DAYS=${JSON.stringify(bad)}`).toBe(90)
    }
  })

  it('shareTokenExpiryFromNow() is now + TTL (read per call, no re-import needed)', () => {
    const now = new Date('2026-09-16T12:00:00.000Z')
    expect(shareTokenExpiryFromNow(now).toISOString()).toBe('2026-12-15T12:00:00.000Z')
    process.env.SHARE_TOKEN_TTL_DAYS = '1'
    expect(shareTokenExpiryFromNow(now).toISOString()).toBe('2026-09-17T12:00:00.000Z')
  })

  it('isShareTokenExpired: strictly-past is dead, == now is dead, just-after is live, NULL is grandfathered-live', () => {
    const now = new Date()
    expect(isShareTokenExpired({ shareTokenExpiresAt: new Date(now.getTime() - 1) }, now)).toBe(true)
    expect(isShareTokenExpired({ shareTokenExpiresAt: new Date(now.getTime()) }, now)).toBe(true)
    expect(isShareTokenExpired({ shareTokenExpiresAt: new Date(now.getTime() + 1) }, now)).toBe(false)
    expect(isShareTokenExpired({ shareTokenExpiresAt: null }, now)).toBe(false)
    expect(isShareTokenExpired({}, now)).toBe(false)
    expect(isShareTokenExpired(null, now)).toBe(false)
  })
})

// ------------------------------------------------- GET /api/share — expiry + no oracle

describe('GET /api/share — expired links are indistinguishable from unknown ones', () => {
  it('live token (expiry in the future) → 200', async () => {
    plant({ expiresAt: new Date(Date.now() + 60_000) })
    const res = await shareGet(shareGetReq('?token=tok-1'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true)
  })

  it('grandfathered token (NULL expiry, pre-migration-11 row) → 200 (documented policy)', async () => {
    plant({ expiresAt: null })
    const res = await shareGet(shareGetReq('?token=tok-1'))
    expect(res.status).toBe(200)
  })

  it('expired token (1 ms past) → the EXACT 404 body an unknown token gets (no oracle)', async () => {
    plant({ expiresAt: new Date(Date.now() - 1) })
    const expired = await shareGet(shareGetReq('?token=tok-1'))
    const unknown = await shareGet(shareGetReq('?token=tok-nope'))
    expect(expired.status).toBe(404)
    expect(unknown.status).toBe(404)
    const expiredBody = (await expired.json()) as { error?: string }
    expect(expiredBody).toEqual(await unknown.json())
    expect(expiredBody.error).toBe('Invalid or expired link')
  })

  it('expiry == now is already dead (boundary)', async () => {
    plant({ expiresAt: new Date() })
    const res = await shareGet(shareGetReq('?token=tok-1'))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error?: string }).error).toBe('Invalid or expired link')
  })
})

// ------------------------------------------------- GET /api/project — the IDOR twin

describe('GET /api/project?share= — an expired token never reaches the payload (SEC-7 twin)', () => {
  it('expired token → the EXACT 401 an unknown one gets; getProjectPayload NEVER runs (no first-project fallback)', async () => {
    plant({ expiresAt: new Date(Date.now() - 1) })
    const expired = await projectGet(projectGetReq('?share=tok-1'))
    const unknown = await projectGet(projectGetReq('?share=tok-nope'))
    expect(expired.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(await expired.json()).toEqual(await unknown.json())
    expect(getProjectPayload).not.toHaveBeenCalled()
  })

  it('live token → 200, pinned to the token\'s own project', async () => {
    plant({ expiresAt: new Date(Date.now() + 60_000) })
    const res = await projectGet(projectGetReq('?share=tok-1'))
    expect(res.status).toBe(200)
    expect(getProjectPayload).toHaveBeenCalledWith('p-1')
  })
})

// ------------------------------------------------- POST /api/share — confirm gate

describe('POST /api/share — money decisions need an explicit confirm: true', () => {
  beforeEach(() => plant())

  it('milestone.decide WITHOUT confirm → 400 honest error, applyAction never runs', async () => {
    const res = await sharePost(sharePostReq({ token: 'tok-1', type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve' } }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toMatch(/confirm: true/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('variation.decide WITHOUT confirm → 400 (same gate)', async () => {
    const res = await sharePost(sharePostReq({ token: 'tok-1', type: 'variation.decide', payload: { id: 'v-1', decision: 'approve' } }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toMatch(/confirm: true/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('a truthy NON-boolean confirm is NOT an explicit confirmation (strict === true)', async () => {
    for (const fake of ['true', 'yes', 1]) {
      const res = await sharePost(sharePostReq({ token: 'tok-1', type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve', confirm: fake } }))
      expect(res.status, `confirm: ${JSON.stringify(fake)}`).toBe(400)
    }
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('milestone.decide WITH confirm: true → 200, actor stamped from the link', async () => {
    const res = await sharePost(sharePostReq({ token: 'tok-1', type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve', confirm: true } }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true)
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(applyAction).toHaveBeenCalledWith(
      'milestone.decide',
      expect.objectContaining({ id: 'ms-1', decision: 'approve', __actor: 'Mama Njeri', __role: 'client' }),
      'p-1',
    )
  })

  it('non-decision actions (comment.add) need NO confirm — the read path is unchanged', async () => {
    const res = await sharePost(sharePostReq({ token: 'tok-1', type: 'comment.add', payload: { photoId: 'ph-1', text: 'Looking good' } }))
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
  })

  it('EXPIRED token + confirm: true → 404 exactly like an unknown one; the decision never applies', async () => {
    dbState.projects[0].shareTokenExpiresAt = new Date(Date.now() - 1)
    const res = await sharePost(sharePostReq({ token: 'tok-1', type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve', confirm: true } }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error?: string }).error).toBe('Invalid or expired link')
    expect(applyAction).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------- POST /api/actions — the sessionless twin

describe('POST /api/actions (shareToken body path) — the same two gates, no bypass', () => {
  beforeEach(() => plant())

  it('milestone.decide via shareToken WITHOUT confirm → 400 honest error, applyAction never runs', async () => {
    const res = await actionsPost(actionsPostReq({ type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve' }, shareToken: 'tok-1' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toMatch(/confirm: true/)
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('milestone.decide via shareToken WITH confirm: true → 200, actor stamped from the link', async () => {
    const res = await actionsPost(actionsPostReq({ type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve', confirm: true }, shareToken: 'tok-1' }))
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(applyAction).toHaveBeenCalledWith(
      'milestone.decide',
      expect.objectContaining({ __actor: 'Mama Njeri', __role: 'client' }),
      'p-1',
    )
  })

  it('EXPIRED shareToken + confirm → 404 Invalid or expired link', async () => {
    dbState.projects[0].shareTokenExpiresAt = new Date(Date.now() - 1)
    const res = await actionsPost(actionsPostReq({ type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve', confirm: true }, shareToken: 'tok-1' }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error?: string }).error).toBe('Invalid or expired link')
    expect(applyAction).not.toHaveBeenCalled()
  })

  it('a logged-in client-ROLE session does NOT need the flag (session-gated path, unchanged)', async () => {
    clientSession('p-1')
    const res = await actionsPost(actionsPostReq({ type: 'milestone.decide', payload: { id: 'ms-1', decision: 'approve' }, projectId: 'p-1' }))
    expect(res.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(applyAction).toHaveBeenCalledWith(
      'milestone.decide',
      expect.objectContaining({ __actor: 'Mama Njeri', __role: 'client' }),
      'p-1',
    )
  })
})

// ------------------------------------------------- creation stamps the expiry

describe('POST /api/projects stamps shareTokenExpiresAt on the mint', () => {
  it('persists shareTokenExpiresAt ≈ now + 90d (default knob) and echoes the token', async () => {
    contractorSession()
    const before = Date.now()
    const res = await projectsPost(projectsPostReq())
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok?: boolean; result?: { shareToken?: string } }
    expect(json.ok).toBe(true)
    const created = dbState.projects[0]
    expect(json.result?.shareToken).toBe(created.shareToken)
    expect(created.shareTokenExpiresAt).toBeInstanceOf(Date)
    const delta = (created.shareTokenExpiresAt as Date).getTime() - before
    expect(delta).toBeGreaterThan(90 * DAY - 120_000)
    expect(delta).toBeLessThan(90 * DAY + 120_000)
  })

  it('honors SHARE_TOKEN_TTL_DAYS=30', async () => {
    contractorSession()
    process.env.SHARE_TOKEN_TTL_DAYS = '30'
    const before = Date.now()
    const res = await projectsPost(projectsPostReq())
    expect(res.status).toBe(200)
    const delta = (dbState.projects[0].shareTokenExpiresAt as Date).getTime() - before
    expect(delta).toBeGreaterThan(30 * DAY - 120_000)
    expect(delta).toBeLessThan(30 * DAY + 120_000)
  })
})

// ------------------------------------------------- frontend + i18n static pins

describe('the client view sends the confirm flag (frontend pins)', () => {
  it('money-tab decideMilestone/decideVariation both dispatch confirm: true', () => {
    const src = readSrc('src/frontend/mjengo/money-tab.tsx')
    const decides = src.match(/dispatch\('(milestone|variation)\.decide',\s*\{[\s\S]*?\}/g) ?? []
    expect(decides).toHaveLength(2)
    for (const d of decides) expect(d).toContain('confirm: true')
  })

  it('the share-link confirm note exists in BOTH dictionaries (EN/SW parity)', () => {
    const en = readSrc('src/frontend/i18n/dicts/en.ts')
    const sw = readSrc('src/frontend/i18n/dicts/sw.ts')
    expect(en).toContain("'money.appr.shareNote':")
    expect(sw).toContain("'money.appr.shareNote':")
    // the dead-link copy now honestly says a link can EXPIRE, in both langs
    expect(en).toMatch(/share\.error\.invalid.*expired/)
    expect(sw).toMatch(/share\.error\.invalid.*kimekwisha muda/)
  })
})
