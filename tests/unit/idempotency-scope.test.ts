/**
 * Idempotency-Key principal scoping (issue #177 / audit register SEC-10) —
 * the /api/actions half of the matrix, plus the ONE-SEAM helper contracts.
 *
 * BEFORE #177 the replay keyspace was GLOBAL (`key` alone was unique): any
 * actor presenting another actor's caller-chosen key replayed that actor's
 * stored result — a cross-actor information oracle (and owner-role sessions
 * additionally received the full project payload of whatever project the key
 * belonged to). The BE-6 client pin (#104) closed one projection of it for
 * client sessions; everyone else stayed exposed.
 *
 * AFTER #177 the record is keyed by (principal, scope, key) and the principal
 * is derived at the one seam (src/backend/lib/idempotency.ts): session
 * callers live in `user:<email>|project:<id|none>` (clients session-pinned),
 * share-link callers in `share:<sha256(token)>`. A foreign actor's identical
 * key MISSES — their request dispatches fresh and records in THEIR namespace.
 *
 * Idiom: the flags-gating fake guard + stubbed db with applyAction mocked
 * (the fresh-dispatch paths below MUST reach the applier — the point is that
 * a miss is a fresh dispatch, not a replay); getProjectPayload/getProjectsList
 * controlled. The withIdempotency (v1) half of the matrix lives in
 * wallet-idempotency.test.ts; the DB-level composite unique is pinned in
 * idempotency-scope-realdb.test.ts.
 */
import { NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per test.
const h = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string; role: string; projectId: string | null; supplierId: string | null }
  },
}))

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
    safeErrorMessage: (e: unknown, fallback: string) =>
      e instanceof Error && !e.message.includes('\n') ? e.message : fallback,
    isInternalError: (e: unknown) => e instanceof Error && e.message.includes('\n'),
    FINANCE_ROLES,
    PAYMENT_ROLES,
    KNOWN_ROLES,
    OWNER_ROLES,
  }
})

vi.mock('@/backend/lib/db', () => {
  const state = {
    flagRows: [
      { key: 'ai_progress', enabled: true, description: 'AI progress' },
      { key: 'ai_voice', enabled: true, description: 'AI voice' },
      { key: 'wallet', enabled: true, description: 'Wallet' },
      { key: 'marketplace', enabled: true, description: 'Marketplace' },
      { key: 'land_verification', enabled: true, description: 'Land' },
    ],
    // idemRows: the written IdempotencyRecords (asserted per namespace).
    idemRows: [] as Array<Record<string, unknown>>,
    // project rows for the REAL findLiveProjectByShareToken (share path).
    projectRows: [
      { id: 'p-1', name: 'Riverside Villas', client: 'Mama Njeri', shareToken: 'tok-1', shareTokenExpiresAt: null },
      { id: 'p-2', name: 'Westlands Duplex', client: 'Baba Otieno', shareToken: 'tok-2', shareTokenExpiresAt: null },
    ],
    reset() {
      state.idemRows = []
    },
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
      async findUnique({ where }: { where: Record<string, string> }) {
        if (where.shareToken !== undefined) {
          return state.projectRows.find((p) => p.shareToken === where.shareToken) ?? null
        }
        return state.projectRows.find((p) => p.id === where.id) ?? null
      },
    },
    idempotencyRecord: {
      // #177: the (principal, scope, key) composite unique is the lookup shape.
      async findUnique({
        where,
      }: {
        where: { principal_scope_key?: { principal: string; scope: string; key: string }; key?: string }
      }) {
        const c = where.principal_scope_key
        return (
          state.idemRows.find((r) =>
            c
              ? r.principal === c.principal && r.scope === c.scope && r.key === c.key
              : r.key === where.key,
          ) ?? null
        )
      },
      async create({ data }: { data: Record<string, unknown> }) {
        // Faithful composite unique: the same triple twice is a collision.
        const clash = state.idemRows.find(
          (r) => r.principal === data.principal && r.scope === data.scope && r.key === data.key,
        )
        if (clash) throw new Error('stub: unique constraint failed on (principal, scope, key)')
        state.idemRows.push({ ...data })
        return { ...data }
      },
    },
  }
  return { db }
})

// The applier is controlled — the fresh-dispatch tests assert it RUNS (a
// namespace miss is a fresh dispatch, the whole point of #177); the replay
// tests assert it does NOT re-run.
const mj = vi.hoisted(() => ({
  applyAction: vi.fn(async () => ({ applied: 'fresh' })),
  getProjectPayload: vi.fn(async (id?: string | null) => ({ project: { id, name: 'Seeded Project' } })),
  getProjectsList: vi.fn(async () => [{ id: 'p-1', name: 'Riverside Villas' }, { id: 'p-2', name: 'Westlands Duplex' }]),
}))
vi.mock('@/backend/lib/mjengo', () => mj)

import { db } from '@/backend/lib/db'
import {
  actionsPrincipal,
  principalForSession,
  shareTokenPrincipal,
  syncPrincipal,
  SYSTEM_PRINCIPAL,
} from '@/backend/lib/idempotency'
import { applyAction, getProjectPayload } from '@/backend/lib/mjengo'
import { POST as actionsPost } from '@/app/api/actions/route'

const state = (db as unknown as { __state: ReturnType<typeof getState> }).__state
function getState() {
  return undefined as unknown as {
    idemRows: Array<Record<string, unknown>>
    reset: () => void
  }
}

function sessionFor(
  role: string,
  opts: { email?: string; projectId?: string | null; supplierId?: string | null } = {},
) {
  h.session = {
    user: {
      id: `u-${role}`,
      email: opts.email ?? `${role}@idemscope.test.dev`,
      name: role,
      role,
      projectId: opts.projectId ?? null,
      supplierId: opts.supplierId ?? null,
    },
  }
}

function actionReq(
  type: string,
  opts: { payload?: unknown; projectId?: string; shareToken?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest('http://localhost/api/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify({
      type,
      payload: opts.payload ?? {},
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.shareToken !== undefined ? { shareToken: opts.shareToken } : {}),
    }),
  })
}

const bodyOf = (res: { json: () => Promise<unknown> }) => res.json() as Promise<Record<string, unknown>>

beforeEach(() => {
  h.session = null
  state.reset()
  vi.mocked(applyAction).mockClear()
  vi.mocked(getProjectPayload).mockClear()
  mj.getProjectPayload.mockClear()
  mj.getProjectsList.mockClear()
})

// ------------------------------------------------- the one-seam helper contracts

describe('lib/idempotency — the principal derivations (one seam)', () => {
  it('principalForSession: lowercased email (the rate-limiter convention), optional resource suffix', () => {
    expect(principalForSession({ user: { email: 'Finance@Demo.KE' } })).toBe('user:finance@demo.ke')
    expect(principalForSession({ user: { email: '  Finance@Demo.KE  ' } }, 'wallet:w-1')).toBe(
      'user:finance@demo.ke|wallet:w-1',
    )
    // A nullish resource is not glued on (no dangling '|').
    expect(principalForSession({ user: { email: 'a@b.c' } }, null)).toBe('user:a@b.c')
    expect(principalForSession({ user: { email: 'a@b.c' } }, undefined)).toBe('user:a@b.c')
  })

  it('shareTokenPrincipal: sha256 of the token — the raw secret never rides the principal; tokens do not collide', () => {
    const p = shareTokenPrincipal('tok-1')
    expect(p).toBe(`share:${createHash('sha256').update('tok-1').digest('hex')}`)
    expect(p).not.toContain('tok-1')
    expect(p).toMatch(/^share:[0-9a-f]{64}$/)
    expect(shareTokenPrincipal('tok-2')).not.toBe(p)
    // Whitespace variant of the same token is a DIFFERENT principal (the raw
    // value is hashed verbatim — callers pass the body value untouched).
    expect(shareTokenPrincipal(' tok-1')).not.toBe(p)
  })

  it('syncPrincipal: the project segment the sync keys themselves embed; global for null', () => {
    expect(syncPrincipal('p-1')).toBe('sync:p-1')
    expect(syncPrincipal(undefined)).toBe('sync:global')
    expect(syncPrincipal(null)).toBe('sync:global')
  })

  it('SYSTEM_PRINCIPAL is the fixed server-generated namespace', () => {
    expect(SYSTEM_PRINCIPAL).toBe('system')
  })

  it('actionsPrincipal: session → user:<email>|project:<pinned-or-body>; share → hashed token; neither → null', () => {
    const contractor = { user: { id: 'u-1', email: 'Con@X.dev', name: 'Con', role: 'contractor', projectId: null, supplierId: null } }
    // Owners act on the BODY project (the write's targetProjectId).
    expect(actionsPrincipal(contractor, 'p-1', undefined)).toBe('user:con@x.dev|project:p-1')
    expect(actionsPrincipal(contractor, null, undefined)).toBe('user:con@x.dev|project:none')
    // Clients are SESSION-pinned — the body project is deliberately ignored,
    // exactly like the fresh-dispatch branch's tenant pin.
    const client = { user: { id: 'u-2', email: 'Cli@X.dev', name: 'Cli', role: 'client', projectId: 'p-1', supplierId: null } }
    expect(actionsPrincipal(client, 'p-2', undefined)).toBe('user:cli@x.dev|project:p-1')
    // Share-link callers: the token IS the principal (hashed).
    expect(actionsPrincipal(null, 'p-1', 'tok-1')).toBe(shareTokenPrincipal('tok-1'))
    // No session and no token: no principal — the route skips the replay.
    expect(actionsPrincipal(null, 'p-1', undefined)).toBeNull()
    expect(actionsPrincipal(null, 'p-1', '')).toBeNull()
    expect(actionsPrincipal(null, 'p-1', null)).toBeNull()
  })
})

// ------------------------------------------------- /api/actions replay keyspace

describe('POST /api/actions — per-principal replay keyspace (#177 / SEC-10)', () => {
  it('same actor + same key + same type: the retry REPLAYS (applyAction exactly once, record in their namespace)', async () => {
    sessionFor('contractor', { email: 'a@idemscope.test.dev' })
    const first = await actionsPost(
      actionReq('comment.add', { payload: { text: 'hi' }, projectId: 'p-1', headers: { 'idempotency-key': 'k-1' } }),
      undefined,
    )
    expect(first.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(state.idemRows).toEqual([
      {
        principal: 'user:a@idemscope.test.dev|project:p-1',
        key: 'k-1',
        scope: 'comment.add',
        projectId: 'p-1',
        responseBody: JSON.stringify({ applied: 'fresh' }),
      },
    ])

    const retry = await actionsPost(
      actionReq('comment.add', { payload: { text: 'hi' }, projectId: 'p-1', headers: { 'idempotency-key': 'k-1' } }),
      undefined,
    )
    expect(retry.status).toBe(200)
    const body = await bodyOf(retry)
    expect(body.replayed).toBe(true)
    expect(body.scope).toBe('comment.add')
    expect(body.result).toEqual({ applied: 'fresh' })
    expect(applyAction).toHaveBeenCalledTimes(1) // never re-applied
    expect(getProjectPayload).toHaveBeenCalledWith('p-1')
  })

  it('a DIFFERENT actor presenting the SAME key → a FRESH dispatch in THEIR namespace — never the other actor\'s stored result', async () => {
    // Actor A records…
    sessionFor('contractor', { email: 'a@idemscope.test.dev' })
    await actionsPost(
      actionReq('comment.add', { payload: { text: 'A' }, projectId: 'p-1', headers: { 'idempotency-key': 'shared-1' } }),
      undefined,
    )
    expect(applyAction).toHaveBeenCalledTimes(1)

    // …actor B presents A's key. Pre-#177 the global keyspace replayed A's
    // stored result (the cross-actor oracle). Now B's lookup misses → their
    // own fresh dispatch, their own record, their own project payload.
    sessionFor('contractor', { email: 'b@idemscope.test.dev' })
    vi.mocked(applyAction).mockResolvedValueOnce({ applied: 'by-B' })
    const foreign = await actionsPost(
      actionReq('comment.add', { payload: { text: 'B' }, projectId: 'p-2', headers: { 'idempotency-key': 'shared-1' } }),
      undefined,
    )
    expect(foreign.status).toBe(200)
    const body = await bodyOf(foreign)
    expect(body.replayed).toBeUndefined() // NOT a replay
    expect(body.result).toEqual({ applied: 'by-B' }) // A's stored result never crossed over
    expect(applyAction).toHaveBeenCalledTimes(2) // B's dispatch really ran
    expect(getProjectPayload).toHaveBeenCalledWith('p-2') // B's own project, not A's

    // Two records, one per namespace — the composite unique holds both.
    const byPrincipal = state.idemRows.filter((r) => r.key === 'shared-1')
    expect(byPrincipal.map((r) => r.principal).sort()).toEqual([
      'user:a@idemscope.test.dev|project:p-1',
      'user:b@idemscope.test.dev|project:p-2',
    ])

    // And A retrying still replays THEIR stored result.
    sessionFor('contractor', { email: 'a@idemscope.test.dev' })
    const retryA = await actionsPost(
      actionReq('comment.add', { payload: { text: 'A' }, projectId: 'p-1', headers: { 'idempotency-key': 'shared-1' } }),
      undefined,
    )
    expect((await bodyOf(retryA)).replayed).toBe(true)
    expect(applyAction).toHaveBeenCalledTimes(2)
  })

  it('same actor + same key + a DIFFERENT action type → fresh dispatch (scope is part of the keyspace)', async () => {
    sessionFor('contractor', { email: 'a@idemscope.test.dev' })
    await actionsPost(
      actionReq('comment.add', { projectId: 'p-1', headers: { 'idempotency-key': 'cross-type' } }),
      undefined,
    )
    // The same key against a different action: pre-#177 this silently
    // replayed the comment.add result for the task.update call.
    const other = await actionsPost(
      actionReq('task.update', { payload: { id: 't-1', progress: 50 }, projectId: 'p-1', headers: { 'idempotency-key': 'cross-type' } }),
      undefined,
    )
    expect(other.status).toBe(200)
    const body = await bodyOf(other)
    expect(body.replayed).toBeUndefined()
    expect(applyAction).toHaveBeenCalledTimes(2)
    expect(state.idemRows.filter((r) => r.key === 'cross-type').map((r) => r.scope).sort()).toEqual([
      'comment.add',
      'task.update',
    ])
  })

  it('a share-link caller records in share:<sha256(token)> and retries replay; a rotated link is a fresh namespace', async () => {
    h.session = null
    const first = await actionsPost(
      actionReq('comment.add', { payload: { text: 'from link' }, shareToken: 'tok-1', headers: { 'idempotency-key': 'link-1' } }),
      undefined,
    )
    expect(first.status).toBe(200)
    expect(applyAction).toHaveBeenCalledTimes(1)
    expect(applyAction).toHaveBeenCalledWith('comment.add', expect.objectContaining({ __role: 'client' }), 'p-1')
    expect(state.idemRows).toEqual([
      {
        principal: shareTokenPrincipal('tok-1'),
        key: 'link-1',
        scope: 'comment.add',
        projectId: 'p-1',
        responseBody: JSON.stringify({ applied: 'fresh' }),
      },
    ])

    // The retry (still no session) replays — the token IS the principal.
    const retry = await actionsPost(
      actionReq('comment.add', { payload: { text: 'from link' }, shareToken: 'tok-1', headers: { 'idempotency-key': 'link-1' } }),
      undefined,
    )
    expect((await bodyOf(retry)).replayed).toBe(true)
    expect(applyAction).toHaveBeenCalledTimes(1)

    // A DIFFERENT link (tok-2 → p-2) presenting the same key is a fresh
    // namespace — no replay of tok-1's stored result.
    const rotated = await actionsPost(
      actionReq('comment.add', { payload: { text: 'other link' }, shareToken: 'tok-2', headers: { 'idempotency-key': 'link-1' } }),
      undefined,
    )
    const rotatedBody = await bodyOf(rotated)
    expect(rotatedBody.replayed).toBeUndefined()
    expect(applyAction).toHaveBeenCalledTimes(2)
    expect(applyAction).toHaveBeenLastCalledWith('comment.add', expect.objectContaining({ __role: 'client' }), 'p-2')
  })

  it('a SESSION caller cannot reach a share-link record (and the link\'s hash never leaks into a session namespace)', async () => {
    state.idemRows.push({
      principal: shareTokenPrincipal('tok-1'),
      key: 'bridge-1',
      scope: 'comment.add',
      projectId: 'p-1',
      responseBody: JSON.stringify({ secret: 'link-only' }),
    })
    sessionFor('contractor', { email: 'a@idemscope.test.dev' })
    const res = await actionsPost(
      actionReq('comment.add', { projectId: 'p-1', headers: { 'idempotency-key': 'bridge-1' } }),
      undefined,
    )
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.replayed).toBeUndefined() // the share record was NOT served
    expect(body.result).not.toMatchObject({ secret: 'link-only' })
    expect(applyAction).toHaveBeenCalledTimes(1) // fresh dispatch
  })
})
