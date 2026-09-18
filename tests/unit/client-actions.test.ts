/**
 * Invariants of the CLIENT_ACTIONS allowlist (src/shared/client-actions.ts).
 *
 * This list is a SECURITY boundary, not a UX hint: /api/actions and /api/sync
 * 401/403 anything a client-role session (or a share-link visitor) tries to
 * dispatch that is NOT in it. So:
 *   · every entry must be a real, dispatchable action id (registry drift =
 *     a client UI that always 403s, or worse a typo that silently widens);
 *   · only decide/communicate/pay verbs belong here — creating, editing,
 *     deleting or releasing site-team records from a client surface would
 *     bypass the owner trust model (spec Doc A §24);
 *   · no duplicates (the route check is an Array.includes, idempotent, but a
 *     duplicate signals a sloppy edit that this suite should catch).
 *
 * The dispatcher registry is imported from the real src/backend/actions/*
 * arrays (db is stubbed — the arrays are plain data; nothing is dispatched),
 * plus the core action ids parsed out of the ActionType union in
 * src/backend/lib/mjengo.ts.
 *
 * BE-6 (issue #104) — the Idempotency-Key replay pin, pinned at the bottom:
 * a client session replaying a FOREIGN key used to get that project's full
 * payload + the original actor's result (the replay branch ran before the
 * client tenant pin). The matrix pinned: foreign key → 403 no payload; own
 * key → the historical replay; no-project client + owner's global record →
 * 403 fail closed; MIRROR owner roles unchanged; MIRROR supplier → the
 * result-only replay. Idiom: the fake guard + stubbed db of the sibling
 * route suites (supplier-role.test.ts); applyAction stays REAL (never
 * reached on a replay — the stored response is the point of §57).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The session the mocked guard resolves — set per replay-pin test.
const h = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string; role: string; projectId: string | null; supplierId: string | null }
  },
}))

// Full fake guard (the supplier-role idiom — mirrors guard.ts 1:1 so the
// mocked getSessionFromReq IS the one publicRoute consults).
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
      NextResponse.json(
        { error: role ? `Not permitted for role "${role}"` : 'Not permitted' },
        { status: 403 },
      ),
    safeErrorMessage: (e: unknown, fallback: string) =>
      e instanceof Error && !e.message.includes('\n') ? e.message : fallback,
    isInternalError: (e: unknown) => e instanceof Error && e.message.includes('\n'),
    sessionSupplierId: (session: { user: { role: string; supplierId?: string | null } }) => {
      if (session.user.role !== 'supplier') return null
      const id = session.user.supplierId
      return typeof id === 'string' && id.trim() ? id.trim() : null
    },
    KNOWN_ROLES,
    OWNER_ROLES,
    FINANCE_ROLES,
    PAYMENT_ROLES,
  }
})

// The action modules import { db } from '@/backend/lib/db' (Prisma). The
// allowlist tests below dispatch nothing; the replay-pin tests at the bottom
// only need the idempotency records (a replay never re-applies anything).
vi.mock('@/backend/lib/db', () => {
  // Pre-recorded IdempotencyRecords — the replay fixtures (spec §57), each
  // living in its #177 PRINCIPAL namespace (the lookup shape the route uses):
  //   · replay-own-p1      — the p-1 client's own key (user:client…|project:p-1)
  //   · replay-reassigned  — a HIT-shaped record whose projectId disagrees
  //                          with the session pin (post-#177 the writer keeps
  //                          principal-project and projectId equal, so this is
  //                          the BE-6 defense-in-depth backstop, not the
  //                          primary guard — #177's scoping is)
  //   · replay-noproject   — the same client's key from a project-less stint
  //                          (user:client…|project:none, record project p-1)
  //   · replay-foreign-p2  — ANOTHER client's p-2 key (a foreign ACTOR — the
  //                          #177 cross-actor probe; lives in their namespace)
  //   · replay-owner-global— an owner's global action (project:none namespace)
  //   · replay-sup-p1      — the supplier's own key (user:supplier…|project:p-1)
  const idemRows = [
    { principal: 'user:client@client-actions.test.dev|project:p-1', key: 'replay-own-p1', scope: 'comment.add', projectId: 'p-1', responseBody: '{"id":"c-1","text":"approved"}' },
    { principal: 'user:client@client-actions.test.dev|project:p-1', key: 'replay-reassigned', scope: 'comment.add', projectId: 'p-2', responseBody: '{"id":"c-9","text":"old project"}' },
    { principal: 'user:client@client-actions.test.dev|project:none', key: 'replay-noproject', scope: 'comment.add', projectId: 'p-1', responseBody: '{"id":"c-8","text":"stale"}' },
    { principal: 'user:p2-client@client-actions.test.dev|project:p-2', key: 'replay-foreign-p2', scope: 'comment.add', projectId: 'p-2', responseBody: '{"id":"c-2","text":"leak"}' },
    { principal: 'user:contractor@client-actions.test.dev|project:none', key: 'replay-owner-global', scope: 'task.update', projectId: null, responseBody: '{"id":"t-1"}' },
    { principal: 'user:supplier@client-actions.test.dev|project:p-1', key: 'replay-sup-p1', scope: 'comment.add', projectId: 'p-1', responseBody: '{"id":"c-3","text":"supplier note"}' },
  ]
  return {
    db: {
      idempotencyRecord: {
        // #177: the (principal, scope, key) composite unique is the lookup shape.
        async findUnique({
          where,
        }: {
          where: { principal_scope_key?: { principal: string; scope: string; key: string }; key?: string }
        }) {
          const c = where.principal_scope_key
          return (
            idemRows.find((r) =>
              c ? r.principal === c.principal && r.scope === c.scope && r.key === c.key : r.key === where.key,
            ) ?? null
          )
        },
        async create({ data }: Record<string, unknown>) { return { ...data } },
      },
    },
  }
})

// The buyer payload read seams are controlled (the supplier-role idiom);
// applyAction stays REAL — a replay never reaches it.
vi.mock('@/backend/lib/mjengo', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>()
  return {
    ...orig,
    getProjectPayload: vi.fn(async () => null),
    getProjectsList: vi.fn(async () => []),
  }
})

import { CLIENT_ACTIONS } from '@/shared/client-actions'
import { EVIDENCE_ACTIONS } from '@/backend/actions/evidence'
import { INTEL_ACTIONS } from '@/backend/actions/intel'
import { INVENTORY_ACTIONS } from '@/backend/actions/inventory'
import { INVOICE_ACTIONS } from '@/backend/actions/invoices'
import { LAND_ACTIONS } from '@/backend/actions/land'
import { MONEY_ACTIONS } from '@/backend/actions/money'
import { PROFESSIONALS_ACTIONS } from '@/backend/actions/professionals'
import { SUPPLY_ACTIONS } from '@/backend/actions/supply'
import { TRUST_ACTIONS } from '@/backend/actions/trust'
import { WALLET_ACTIONS } from '@/backend/actions/wallet'
import { getProjectPayload, getProjectsList } from '@/backend/lib/mjengo'
import { POST as actionsPost } from '@/app/api/actions/route'

/** Core (non-module) action ids, parsed from the ActionType union source. */
function coreActionIds(): string[] {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/backend/lib/mjengo.ts', import.meta.url)),
    'utf8',
  )
  const union = src.slice(
    src.indexOf('export type ActionType'),
    src.indexOf('export async function applyAction'),
  )
  return [...union.matchAll(/'([a-z]+[a-zA-Z]*\.[a-zA-Z]+)'/g)].map((m) => m[1])
}

const REGISTRY = new Set<string>([
  ...coreActionIds(),
  ...TRUST_ACTIONS, ...MONEY_ACTIONS, ...EVIDENCE_ACTIONS, ...LAND_ACTIONS,
  ...PROFESSIONALS_ACTIONS, ...SUPPLY_ACTIONS, ...INVOICE_ACTIONS,
  ...INTEL_ACTIONS, ...INVENTORY_ACTIONS, ...WALLET_ACTIONS,
])

describe('CLIENT_ACTIONS is a complete, dispatchable allowlist', () => {
  it('has no duplicate entries', () => {
    expect(new Set(CLIENT_ACTIONS).size).toBe(CLIENT_ACTIONS.length)
  })

  it('every entry is a real action id the dispatcher knows', () => {
    for (const action of CLIENT_ACTIONS) {
      expect(REGISTRY.has(action), `"${action}" is not a dispatchable action id`).toBe(true)
    }
  })

  it('is non-empty (an empty list would brick every share-link)', () => {
    expect(CLIENT_ACTIONS.length).toBeGreaterThan(0)
  })
})

describe('no owner-only mutation leaks into the client surface', () => {
  const CLIENT_VERBS = new Set(['decide', 'pay', 'add', 'read', 'readAll'])

  it('every entry is a decide/communicate/pay verb', () => {
    for (const action of CLIENT_ACTIONS) {
      const verb = action.slice(action.indexOf('.') + 1)
      expect(
        CLIENT_VERBS.has(verb),
        `"${action}" is not a client verb (decide/pay/comment/read) — owners only?`,
      ).toBe(true)
    }
  })

  it('never contains the classic owner-only mutation ids', () => {
    const ownerOnly = [
      'task.create', 'task.update', 'task.delete', 'task.assign',
      'phase.update', 'project.update', 'material.create',
      'worker.create', 'wages.pay', 'expense.create', 'transaction.delete',
      'team.add', 'team.update', 'team.remove',
      'delivery.create', 'consumption.create', 'share.regenerate',
      'photo.apply', 'alert.ack', 'attendance.override', 'payroll.approve',
    ]
    for (const id of ownerOnly) {
      expect(CLIENT_ACTIONS, `owner-only "${id}" leaked into CLIENT_ACTIONS`).not.toContain(id)
    }
  })

  it('never lets a client create/edit/submit invoices or payment requests', () => {
    // Finder spec §8-10: clients DECIDE submitted invoices and PAY them; the
    // draft work (create/update/submit) stays with the site team.
    const siteTeamOnly = [
      'invoice.create', 'invoice.update', 'invoice.submit', 'invoice.delete',
      'payment.create', 'payment.update', 'payment.submit',
      'request.create', 'request.update', 'request.submit',
      'milestone.create', 'variation.create',
    ]
    for (const id of siteTeamOnly) {
      expect(CLIENT_ACTIONS, `"${id}" must stay site-team-only`).not.toContain(id)
    }
  })

  it('never exposes wallet/escrow plumbing to a client', () => {
    for (const action of WALLET_ACTIONS) {
      if (action === 'payment.decide' || action === 'payment.pay') continue // the client payer-queue seam, by design
      expect(CLIENT_ACTIONS).not.toContain(action)
    }
    expect(CLIENT_ACTIONS).not.toContain('escrow.topup')
  })
})

describe('dispatcher registry hygiene (the arrays CLIENT_ACTIONS depends on)', () => {
  const MODULE_ARRAYS: [string, readonly string[]][] = [
    ['TRUST_ACTIONS', TRUST_ACTIONS], ['MONEY_ACTIONS', MONEY_ACTIONS],
    ['EVIDENCE_ACTIONS', EVIDENCE_ACTIONS], ['LAND_ACTIONS', LAND_ACTIONS],
    ['PROFESSIONALS_ACTIONS', PROFESSIONALS_ACTIONS],
    ['SUPPLY_ACTIONS', SUPPLY_ACTIONS], ['INVOICE_ACTIONS', INVOICE_ACTIONS],
    ['INTEL_ACTIONS', INTEL_ACTIONS], ['INVENTORY_ACTIONS', INVENTORY_ACTIONS],
    ['WALLET_ACTIONS', WALLET_ACTIONS],
  ]

  it('action arrays are pairwise disjoint (ambiguous dispatch hazard)', () => {
    for (let i = 0; i < MODULE_ARRAYS.length; i++) {
      for (let j = i + 1; j < MODULE_ARRAYS.length; j++) {
        const [nameA, arrA] = MODULE_ARRAYS[i]
        const [nameB, arrB] = MODULE_ARRAYS[j]
        const overlap = arrA.filter((a) => arrB.includes(a))
        expect(overlap, `${nameA} and ${nameB} overlap`).toEqual([])
      }
    }
  })

  it('no module array contains duplicates', () => {
    for (const [name, arr] of MODULE_ARRAYS) {
      expect(new Set(arr).size, `${name} has duplicates`).toBe(arr.length)
    }
  })
})

// ------------------ BE-6 (issue #104) + #177 (SEC-10): the replay keyspace

describe('POST /api/actions — an Idempotency-Key replays only within the session pins (BE-6 + #177)', () => {
  /** A client-allowlisted, non-flag-family action — the flag gate passes
   *  without reading the flag table, so the replay branch is reached. */
  function replayReq(key: string, opts: { type?: string; projectId?: string | null } = {}): NextRequest {
    const type = opts.type ?? 'comment.add'
    const projectId = 'projectId' in opts ? opts.projectId : 'p-1'
    return new NextRequest('http://localhost/api/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ type, payload: { text: 'hi' }, ...(projectId !== null ? { projectId } : {}) }),
    })
  }

  function sessionFor(role: string, opts: { projectId?: string | null; supplierId?: string | null } = {}) {
    h.session = {
      user: {
        id: `u-${role}`,
        email: `${role}@client-actions.test.dev`,
        name: role,
        role,
        projectId: opts.projectId ?? null,
        supplierId: opts.supplierId ?? null,
      },
    }
  }

  beforeEach(() => {
    h.session = null
    vi.mocked(getProjectPayload).mockReset()
    vi.mocked(getProjectPayload).mockImplementation(async (id?: string | null) =>
      ({ project: { id, name: 'Seeded Project' } }) as never)
    vi.mocked(getProjectsList).mockReset()
    vi.mocked(getProjectsList).mockImplementation(async () => [
      { id: 'p-1', name: 'Riverside Villas' },
      { id: 'p-2', name: 'Westlands Duplex' },
    ] as never)
  })

  it('client session + its OWN key → the historical replay (stored result + refreshed payload)', async () => {
    sessionFor('client', { projectId: 'p-1' })
    const res = await actionsPost(replayReq('replay-own-p1'), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.replayed).toBe(true)
    expect(body.scope).toBe('comment.add')
    expect(body.result).toEqual({ id: 'c-1', text: 'approved' })
    expect('data' in body).toBe(true)
    expect('projects' in body).toBe(true)
    // The refresh is pinned to the record's (own) project.
    expect(getProjectPayload).toHaveBeenCalledWith('p-1')
  })

  it('BE-6 residual (replay-hit record, other projectId): the client pin still refuses — 403, NO payload leaked', async () => {
    // #177 closes the cross-ACTOR oracle (see the foreign-actor pin in
    // idempotency-scope.test.ts); this pin keeps the BE-6 defense-in-depth
    // for the shape it still guards — a record that HITS the caller's
    // namespace but whose projectId disagrees with the session pin. The
    // #177 writer keeps principal-project and projectId equal, so a live
    // record like this means a writer bug — the pin is the backstop.
    sessionFor('client', { projectId: 'p-1' })
    const res = await actionsPost(replayReq('replay-reassigned'), undefined)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Not permitted for this project' })
    // The foreign project's payload was never built, never shipped.
    expect(getProjectPayload).not.toHaveBeenCalled()
    expect(getProjectsList).not.toHaveBeenCalled()
  })

  it('client session with NO project assigned → 403 fail closed (their project:none records are still foreign)', async () => {
    sessionFor('client', { projectId: null })
    const res = await actionsPost(replayReq('replay-noproject'), undefined)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Not permitted for this project' })
    expect(getProjectPayload).not.toHaveBeenCalled()
  })

  it('MIRROR: an owner replaying their OWN global record (no projectId in the retry either) → the full historical replay (unchanged)', async () => {
    sessionFor('contractor')
    const res = await actionsPost(replayReq('replay-owner-global', { type: 'task.update', projectId: null }), undefined)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.replayed).toBe(true)
    expect(body.result).toEqual({ id: 't-1' })
    expect('data' in body).toBe(true)
    expect('projects' in body).toBe(true)
    expect(getProjectPayload).toHaveBeenCalledWith(null)
  })

  it('MIRROR: a supplier session replaying its OWN key → the stored result ONLY (no buyer payload keys)', async () => {
    sessionFor('supplier', { supplierId: 'sup-1' })
    const res = await actionsPost(replayReq('replay-sup-p1'), undefined)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      replayed: true,
      scope: 'comment.add',
      result: { id: 'c-3', text: 'supplier note' },
    })
    expect(getProjectPayload).not.toHaveBeenCalled()
    expect(getProjectsList).not.toHaveBeenCalled()
  })

  it('#177: a sessionless, tokenless caller presenting ANY key → 401, never a replay (the unauth replay oracle is closed)', async () => {
    // Pre-#177 the global-keyspace lookup ran before any auth: a caller with
    // NO session and NO share token could replay a stored result outright.
    // Now there is no principal to scope a replay against — the lookup is
    // skipped and the fresh branch's 401 answers.
    const res = await actionsPost(replayReq('replay-foreign-p2'), undefined)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Sign in required' })
    expect(getProjectPayload).not.toHaveBeenCalled()
    expect(getProjectsList).not.toHaveBeenCalled()
  })
})
