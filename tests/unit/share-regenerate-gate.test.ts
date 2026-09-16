/**
 * Issue #172 (SEC-3r residual) — the share.regenerate lifecycle, through the
 * REAL applyAction (the route-contract cases live in
 * share-link-expiry.test.ts; this file keeps the real mjengo module graph so
 * the production applier + role gates are what runs).
 *
 * Pinned:
 *   · ROTATION — regenerate mints a fresh CSPRNG token; the OLD token is gone
 *     from the row (a bearer capability dies at rotate, as before).
 *   · EXPIRY RESET — the update also stamps shareTokenExpiresAt ≈ now +
 *     SHARE_TOKEN_TTL_DAYS (default 90) — even a grandfathered NULL-expiry
 *     link picks up a real TTL here.
 *   · AUDIT — the re-issue lands on the Bias-Free Ledger (logAudit row with
 *     kind 'share', "Share link regenerated").
 *   · ROLE GATE — share.regenerate is contractor/admin-only now (the
 *     TEAM_ACTIONS pattern): supervisor/qs/procurement/finance and the
 *     client/share stamp are refused server-side; the no-stamp internal
 *     default (contractor) still rotates.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  const state = {
    projects: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    audits: [] as Array<Record<string, unknown>>,
    reset() {
      state.projects = []
      state.updates = []
      state.audits = []
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
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const row = state.projects.find((p) => p.id === where.id)
        if (!row) throw new Error('Record not found')
        Object.assign(row, data, { updatedAt: new Date() })
        state.updates.push({ where: { ...where }, data: { ...data } })
        return { ...row }
      },
    },
    auditEvent: {
      async create({ data }: { data: Record<string, unknown> }) {
        state.audits.push(data)
        return { id: `a-${state.audits.length}` }
      },
    },
  }
  return { db }
})

// The REAL mjengo (applyAction + the new SHARE_ROTATE role gate) against the
// in-memory db above — the draw-pack.test.ts idiom.
import { applyAction } from '@/backend/lib/mjengo'
import { db } from '@/backend/lib/db'

const dbState = (db as unknown as {
  __state: {
    projects: Array<Record<string, unknown>>
    updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>
    audits: Array<Record<string, unknown>>
    reset: () => void
  }
}).__state

const DAY = 24 * 3600 * 1000

beforeEach(() => {
  dbState.reset()
  dbState.projects.push({
    id: 'p-1',
    name: 'Riverside Villas',
    client: 'Mama Njeri',
    location: 'Karen',
    shareToken: 'tok-old',
    shareTokenExpiresAt: null, // grandfathered pre-migration-11 link
    startDate: new Date('2026-01-05T09:00:00Z'),
    targetDate: new Date('2026-08-01T09:00:00Z'),
    status: 'active',
    budget: 2_000_000,
    createdAt: new Date('2026-01-04T09:00:00Z'),
    updatedAt: new Date('2026-01-04T09:00:00Z'),
  })
  delete process.env.SHARE_TOKEN_TTL_DAYS
})

describe('share.regenerate rotates + re-expires + audits (real applyAction)', () => {
  it('mints a fresh CSPRNG token, kills the old one, and stamps ≈ now + 90d', async () => {
    const before = Date.now()
    const result = await applyAction('share.regenerate', { id: 'p-1', __actor: 'Contractor', __role: 'contractor' }, 'p-1')
    const newToken = (result as { shareToken?: string }).shareToken
    expect(newToken).toMatch(/^c[0-9a-f]{24}$/) // the CSPRNG 96-bit mint, unchanged
    expect(dbState.updates).toHaveLength(1)
    expect(dbState.updates[0].data.shareToken).toBe(newToken)
    // the OLD token is gone from the row — rotation still revokes immediately
    expect(dbState.projects[0].shareToken).toBe(newToken)
    // the expiry window is RESET (this row was grandfathered NULL)
    const stamped = dbState.updates[0].data.shareTokenExpiresAt as Date
    expect(stamped).toBeInstanceOf(Date)
    const delta = stamped.getTime() - before
    expect(delta).toBeGreaterThan(90 * DAY - 120_000)
    expect(delta).toBeLessThan(90 * DAY + 120_000)
    expect(dbState.projects[0].shareTokenExpiresAt).toEqual(stamped)
  })

  it('honors SHARE_TOKEN_TTL_DAYS on re-mint', async () => {
    process.env.SHARE_TOKEN_TTL_DAYS = '7'
    const before = Date.now()
    await applyAction('share.regenerate', { id: 'p-1', __role: 'admin' }, 'p-1')
    const delta = (dbState.updates[0].data.shareTokenExpiresAt as Date).getTime() - before
    expect(delta).toBeGreaterThan(7 * DAY - 120_000)
    expect(delta).toBeLessThan(7 * DAY + 120_000)
  })

  it('writes the audit event (the re-issue is on the ledger)', async () => {
    await applyAction('share.regenerate', { id: 'p-1' }, 'p-1')
    expect(dbState.audits).toHaveLength(1)
    expect(dbState.audits[0].kind).toBe('share')
    expect(dbState.audits[0].projectId).toBe('p-1')
    expect(String(dbState.audits[0].summary)).toMatch(/regenerated/i)
  })
})

describe('share.regenerate is contractor/admin-only (issue #172 role gate)', () => {
  it('supervisor/qs/procurement/finance sessions are refused server-side, nothing updates', async () => {
    for (const role of ['supervisor', 'qs', 'procurement', 'finance']) {
      await expect(
        applyAction('share.regenerate', { id: 'p-1', __actor: 'R', __role: role }, 'p-1'),
        `role ${role}`,
      ).rejects.toThrow(/Only a contractor or admin may rotate a client share link/)
    }
    expect(dbState.updates).toHaveLength(0)
    expect(dbState.projects[0].shareToken).toBe('tok-old')
  })

  it('a client (share-link) stamp is refused too', async () => {
    await expect(
      applyAction('share.regenerate', { id: 'p-1', __actor: 'Mama Njeri', __role: 'client' }, 'p-1'),
    ).rejects.toThrow(/Only a contractor or admin may rotate a client share link/)
  })

  it('contractor, admin and the no-stamp internal default still rotate', async () => {
    for (const role of ['contractor', 'admin', undefined]) {
      const payload = role ? { id: 'p-1', __actor: 'A', __role: role } : { id: 'p-1' }
      await expect(applyAction('share.regenerate', payload, 'p-1')).resolves.toMatchObject({
        shareToken: expect.stringMatching(/^c[0-9a-f]{24}$/),
      })
    }
    expect(dbState.updates).toHaveLength(3)
  })
})
