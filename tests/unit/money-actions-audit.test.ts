/**
 * #218 — decision actions capture their decision payload in the audit trail.
 *
 * Before #218 the milestone.decide AuditEvent answered only "Milestone
 * approve by client" — meta carried { type } alone, before/after were never
 * populated by ANY writer, and the reject path had no evidence linkage at
 * all. These tests pin the enrichment:
 *
 *   · milestone.decide APPROVE — ONE kind 'milestone' row whose meta carries
 *     the decision (decision, note, amount as integer-cents string, milestone
 *     name/phase, evidence photo ids) AND the money refs (ledgerRef,
 *     ledgerTxnId, drawPackId); before/after freeze the status transition
 *     release_requested → released with the evidence basis in both states;
 *     entity is the Prisma model name 'Milestone' (the DrawPack convention);
 *     the DrawPack's own audit event stays SEPARATE and entity-scoped.
 *   · milestone.decide REJECT — same shape minus the money fields (no
 *     ledgerRef/ledgerTxnId/drawPackId), note + evidence refs present, no
 *     draw_pack row, no ledger movement.
 *   · FROZEN AT DECISION TIME — a later change to the milestone row's
 *     evidence never rewrites the audit row (matches DrawPack semantics).
 *   · ADDITIVE ctx MERGE — wrapped in an ambient request context (the
 *     /api/actions auditContextFor shape) the row keeps ip/userAgent/
 *     requestId AND gains the enrichment; the explicit ctx's entity wins
 *     over the ambient kind.
 *   · variation.decide + payment.decide — the same treatment (payload in
 *     meta + status before/after) per the issue's consistency AC.
 *   · RESPONSE CONTRACT — the reserved __audit key is STRIPPED before the
 *     result leaves applyAction (callers never see it).
 *   · NON-DECISION ACTIONS UNCHANGED — a money action without facts still
 *     writes the historic { type }-only meta and no before/after.
 *   · logAudit HARDENING — a BigInt inside meta/before serializes as a
 *     string instead of throwing away the whole row (DB-4: the audit write
 *     must not become the failure surface as callers enrich payloads).
 *
 * Mocks mirror tests/unit/draw-pack.test.ts (the proven release-path stub):
 * '@/backend/lib/db' in-memory with just enough Prisma, $transaction =
 * identity. applyAction, releaseMilestoneAtomic, the drawpack module, the
 * wallet service and the ledger posting all run REAL — the whole decision
 * path is the code under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The drawpack module chain imports the AI provider seam (z-ai-web-dev-sdk)
// through modules/ai/authenticity — mocked like every other suite; the
// decision tests never run the screen (the ai flag is off in the stub: the
// featureFlag model is absent → getFlags throws → fail-closed no-op).
vi.mock('z-ai-web-dev-sdk', () => ({
  default: { create: vi.fn(async () => ({})) },
}))

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    phases: new Map<string, Row>(),
    milestones: new Map<string, Row>(),
    variations: new Map<string, Row>(),
    attendances: new Map<string, Row>(),
    mjengoScores: new Map<string, Row>(),
    sitePhotos: new Map<string, Row>(),
    escrowWallets: new Map<string, Row>(),
    drawPacks: new Map<string, Row>(),
    ledgerAccounts: new Map<string, Row>(),
    ledgerTxns: [] as Row[],
    ledgerEntries: [] as Row[],
    transactions: new Map<string, Row>(),
    paymentRequests: new Map<string, Row>(),
    aiReviewNotes: new Map<string, Row>(),
    auditEvents: [] as Row[],
    notifications: [] as Row[],
    /** Flip to simulate a pack write failure (the release must still stand). */
    failDrawPackCreate: false,
    reset() {
      state.seq = 0
      state.failDrawPackCreate = false
      for (const m of Object.values(state)) {
        if (m instanceof Map) m.clear()
      }
      state.ledgerTxns.length = 0
      state.ledgerEntries.length = 0
      state.auditEvents.length = 0
      state.notifications.length = 0
    },
  }

  /** Just enough of Prisma's where: equality, { gte }, { lte }, { in }, { not }. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('gte' in c && String(row[key]) < String(c.gte)) return false
        if ('lte' in c && String(row[key]) > String(c.lte)) return false
        if ('in' in c && !(c.in as unknown[]).includes(row[key])) return false
        if ('not' in c && row[key] === (c.not as unknown)) return false
        continue
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  /** orderBy as a single object OR an array (deterministic multi-key sort). */
  function sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
    if (!orderBy) return rows
    const keys = Array.isArray(orderBy) ? orderBy : [orderBy]
    return [...rows].sort((a, b) => {
      for (const o of keys) {
        const [[field, dir]] = Object.entries(o)
        const av = a[field], bv = b[field]
        const cmp =
          av instanceof Date || bv instanceof Date
            ? new Date(av as string).getTime() - new Date(bv as string).getTime()
            : String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
      }
      return 0
    })
  }

  const scoped = (map: Map<string, Row>, where: Row): Row[] =>
    [...map.values()].filter((r) => matches(r, where))

  const project = (rows: Row[], select?: Row): Row[] =>
    select ? rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]))) : rows

  /** update data with { decrement } / { increment } atomics. */
  function applyUpdate(row: Row, data: Row): void {
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && ('decrement' in v || 'increment' in v)) {
        const c = v as { decrement?: number; increment?: number }
        row[k] = Number(row[k] ?? 0) - Number(c.decrement ?? 0) + Number(c.increment ?? 0)
      } else {
        row[k] = v
      }
    }
  }

  function updatable(map: Map<string, Row>, keyOf: (where: Row) => string | undefined) {
    return {
      async update({ where, data }: { where: Row; data: Row }) {
        const key = keyOf(where)
        const row = key !== undefined ? map.get(key) : undefined
        if (!row) throw new Error('Record not found')
        applyUpdate(row, data)
        return { ...row }
      },
    }
  }

  const cloneTxn = (r: Row): Row => ({
    ...r,
    entries: Array.isArray(r.entries) ? (r.entries as Row[]).map((e) => ({ ...e })) : [],
  })

  const db = {
    __state: state,
    // The real decision paths run inside db.$transaction — identity
    // passthrough (single-threaded stub, every method is on the same object).
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),

    project: {
      async findUnique({ where }: { where: Row }) {
        const r = state.projects.get(String(where.id))
        return r ? { ...r } : null
      },
      ...updatable(state.projects, (w) => (w.id !== undefined ? String(w.id) : undefined)),
    },
    phase: {
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.phases, where)
        return rows[0] ? { ...rows[0] } : null
      },
      ...updatable(state.phases, (w) => (w.id !== undefined ? String(w.id) : undefined)),
    },
    milestone: {
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.milestones, where)
        return rows[0] ? { ...rows[0] } : null
      },
      async findMany({ where, orderBy }: { where: Row; orderBy?: Row | Row[] }) {
        return sorted(scoped(state.milestones, where), orderBy).map((m) => ({ ...m }))
      },
      async create({ data }: { data: Row }) {
        const row = { id: `ms_${++state.seq}`, ...data }
        state.milestones.set(String(row.id), row)
        return { ...row }
      },
      ...updatable(state.milestones, (w) => (w.id !== undefined ? String(w.id) : undefined)),
    },
    variationOrder: {
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.variations, where)
        return rows[0] ? { ...rows[0] } : null
      },
      async findMany({ where, orderBy }: { where: Row; orderBy?: Row | Row[] }) {
        return sorted(scoped(state.variations, where), orderBy).map((v) => ({ ...v }))
      },
      ...updatable(state.variations, (w) => (w.id !== undefined ? String(w.id) : undefined)),
    },
    paymentRequest: {
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.paymentRequests, where)
        return rows[0] ? { ...rows[0] } : null
      },
      ...updatable(state.paymentRequests, (w) => (w.id !== undefined ? String(w.id) : undefined)),
    },
    attendance: {
      async findMany({ where }: { where: Row }) {
        return scoped(state.attendances, where).map((a) => ({ ...a }))
      },
    },
    mjengoScore: {
      async findFirst({ where, orderBy }: { where: Row; orderBy?: Row }) {
        const rows = sorted(scoped(state.mjengoScores, where), orderBy)
        return rows[0] ? { ...rows[0] } : null
      },
    },
    sitePhoto: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        return project(scoped(state.sitePhotos, where), select).map((p) => ({ ...p }))
      },
    },
    escrowWallet: {
      async findUnique({ where }: { where: Row }) {
        const r = state.escrowWallets.get(String(where.projectId))
        return r ? { ...r } : null
      },
      ...updatable(state.escrowWallets, (w) => (w.projectId !== undefined ? String(w.projectId) : undefined)),
    },
    // Append-only by construction (create/find ONLY) — the immutability
    // contract the drawpack module documents.
    drawPack: {
      async create({ data }: { data: Row }) {
        if (state.failDrawPackCreate) throw new Error('simulated draw pack write failure')
        const row: Row = {
          id: `dp_${++state.seq}`,
          currency: 'KES',
          evidencePhotoIds: '[]',
          variationsOpen: '[]',
          schemaVersion: 1,
          ...data,
        }
        if (!row.createdAt) row.createdAt = new Date()
        state.drawPacks.set(String(row.id), row)
        return { ...row }
      },
      async findUnique({ where }: { where: Row }) {
        let row: Row | undefined
        if (where.milestoneId !== undefined) {
          for (const r of state.drawPacks.values()) {
            if (r.milestoneId === where.milestoneId) { row = r; break }
          }
        } else if (where.id !== undefined) {
          row = state.drawPacks.get(String(where.id))
        }
        return row ? { ...row } : null
      },
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.drawPacks, where)
        return rows[0] ? { ...rows[0] } : null
      },
      async findMany({ where, orderBy, select }: { where: Row; orderBy?: Row; select?: Row }) {
        return project(sorted(scoped(state.drawPacks, where), orderBy), select).map((p) => ({ ...p }))
      },
    },
    ledgerAccount: {
      async findUnique({ where }: { where: Row }) {
        const r = state.ledgerAccounts.get(String(where.code))
        return r ? { ...r } : null
      },
      async create({ data }: { data: Row }) {
        const row = { id: `la_${++state.seq}`, ...data }
        state.ledgerAccounts.set(String(row.code), row)
        return { ...row }
      },
    },
    ledgerTransaction: {
      async findUnique({ where }: { where: Row }) {
        let row: Row | undefined
        if (where.idempotencyKey !== undefined) {
          row = state.ledgerTxns.find((t) => t.idempotencyKey === where.idempotencyKey)
        } else if (where.id !== undefined) {
          row = state.ledgerTxns.find((t) => t.id === where.id)
        }
        return row ? cloneTxn(row) : null
      },
      async create({ data }: { data: Row }) {
        const nested = (data.entries as { create: Row[] } | undefined)?.create ?? []
        const { entries, ...rest } = data
        void entries
        const row: Row = { id: `lt_${++state.seq}`, status: 'posted', reversalOfId: null, reversalRef: null, ...rest }
        const entryRows = nested.map((e) => ({ id: `le_${++state.seq}`, txnId: row.id, ...e }))
        row.entries = entryRows
        state.ledgerTxns.push(row)
        state.ledgerEntries.push(...entryRows)
        return cloneTxn(row)
      },
      async update({ where, data }: { where: Row; data: Row }) {
        const row = state.ledgerTxns.find((t) => t.id === where.id)
        if (!row) throw new Error(`stub: ledger txn ${String(where.id)} not found`)
        Object.assign(row, data)
        return cloneTxn(row)
      },
    },
    transaction: {
      async findFirst({ where }: { where: Row }) {
        const rows = scoped(state.transactions, where)
        return rows[0] ? { ...rows[0] } : null
      },
      async create({ data }: { data: Row }) {
        const row = { id: `txn_${++state.seq}`, ...data }
        state.transactions.set(String(row.id), row)
        return { ...row }
      },
    },
    // logAudit is the ONLY writer in production — the stub captures its rows.
    auditEvent: {
      async create({ data }: { data: Row }) {
        const row = { id: `audit_${++state.seq}`, ...data }
        state.auditEvents.push(row)
        return { ...row }
      },
    },
    notification: {
      async create({ data }: { data: Row }) {
        const row = { id: `notif_${++state.seq}`, ...data }
        state.notifications.push(row)
        return { ...row }
      },
    },
    aiReviewNote: {
      async findFirst({ where }: { where: Row }) {
        const rows = [...state.aiReviewNotes.values()].filter((r) => matches(r, where))
        return rows[0] ? { ...rows[0] } : null
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { applyAction } from '@/backend/lib/mjengo'
import { logAudit, withAuditContext } from '@/backend/lib/audit'

type State = ReturnType<typeof stateType>
function stateType() {
  return undefined as unknown as {
    seq: number
    projects: Map<string, Record<string, unknown>>
    phases: Map<string, Record<string, unknown>>
    milestones: Map<string, Record<string, unknown>>
    variations: Map<string, Record<string, unknown>>
    attendances: Map<string, Record<string, unknown>>
    mjengoScores: Map<string, Record<string, unknown>>
    sitePhotos: Map<string, Record<string, unknown>>
    escrowWallets: Map<string, Record<string, unknown>>
    drawPacks: Map<string, Record<string, unknown>>
    ledgerAccounts: Map<string, Record<string, unknown>>
    ledgerTxns: Array<Record<string, unknown>>
    ledgerEntries: Array<Record<string, unknown>>
    transactions: Map<string, Record<string, unknown>>
    paymentRequests: Map<string, Record<string, unknown>>
    aiReviewNotes: Map<string, Record<string, unknown>>
    auditEvents: Array<Record<string, unknown>>
    notifications: Array<Record<string, unknown>>
    failDrawPackCreate: boolean
    reset: () => void
  }
}
const state = (db as unknown as { __state: State }).__state

// ---------------- fixtures ----------------

const P1 = 'p-1'
const REQ = new Date('2026-02-01T09:00:00Z')

function seedWorld() {
  state.projects.set(P1, {
    id: P1, name: 'Nyumba Yangu', client: 'Amina (Client)',
    clientType: 'diaspora', location: 'Karen', budget: 450_000_000n, status: 'active',
    shareToken: 'tok-1', startDate: REQ, targetDate: new Date('2026-08-01T09:00:00Z'),
    createdAt: REQ, updatedAt: REQ,
  })
  state.phases.set('ph-1', {
    id: 'ph-1', projectId: P1, name: 'Site Prep & Foundation', order: 1,
    budget: 90_000_000n, status: 'in_progress', createdAt: REQ,
  })
  state.escrowWallets.set(P1, {
    id: 'ew-1', projectId: P1, balance: 150_000_000n, ledgerAccountId: null, createdAt: REQ, updatedAt: REQ,
  })
  state.milestones.set('m1', {
    id: 'm1', projectId: P1, phaseId: 'ph-1', name: 'Foundation complete', amount: 80_000_000n,
    status: 'release_requested', evidencePhotoIds: '["ph-1","ph-2"]',
    requestedAt: new Date(Date.now() - 3 * 86_400_000), decidedAt: null, decidedBy: null,
    decisionNote: null, releasedAt: null, createdAt: REQ,
  })
  state.sitePhotos.set('ph-1', { id: 'ph-1', projectId: P1, phaseId: 'ph-1', url: '/uploads/foundation-1.jpg', caption: 'Foundation rebar', createdAt: REQ })
  state.sitePhotos.set('ph-2', { id: 'ph-2', projectId: P1, phaseId: 'ph-1', url: '/uploads/foundation-2.jpg', caption: 'Formwork ready', createdAt: REQ })
  state.variations.set('v1', {
    id: 'v1', projectId: P1, phaseId: 'ph-1', title: 'Black cotton soil',
    description: 'deeper foundation', budgetImpact: 18_000_000n, status: 'submitted',
    submittedBy: 'Site Manager', createdAt: REQ,
  })
  state.paymentRequests.set('pr-1', {
    id: 'pr-1', requestCode: 'PR-2026-000001', projectId: P1,
    requestedByRole: 'contractor', requestedByName: 'Site Manager',
    description: 'Cement batch 2', amount: 12_000_000n, payee: 'Bamburi Supplies',
    method: 'mpesa', status: 'pending', relatedEntityType: null, relatedEntityId: null,
    decidedBy: null, decidedAt: null, decisionNote: null, paidAt: null, paidTxnId: null,
    createdAt: REQ, updatedAt: REQ,
  })
}

beforeEach(() => {
  state.reset()
  seedWorld()
})

/** The decision rows under test, parsed. */
function auditRowsOf(kind: string) {
  return state.auditEvents.filter((e) => e.kind === kind)
}
function parsed(row: Record<string, unknown>, key: string): Record<string, any> {
  return JSON.parse(String(row[key]))
}

// ================================================================ milestone.decide

describe('#218 milestone.decide — the decision AuditEvent', () => {
  it('APPROVE: one milestone row with decision + evidence + money refs in meta, the status transition in before/after, entity = the Milestone model', async () => {
    // __actor/__role mirror what every entry route stamps server-side from
    // the session (here: the share-link client stamp) — the audit row's actor.
    const result = await applyAction(
      'milestone.decide',
      { id: 'm1', decision: 'approve', by: 'Amina (Client)', __actor: 'Amina (Client)', __role: 'client' },
      P1,
    )

    // the release itself happened (the enrichment records real refs)
    expect(state.milestones.get('m1')!.status).toBe('released')
    expect(state.ledgerTxns).toHaveLength(1)
    expect(result.ledgerRef).toMatch(/^LX-/)

    // ONE decision row + the pack's own SEPARATE entity-scoped row
    const rows = auditRowsOf('milestone')
    expect(rows).toHaveLength(1)
    expect(auditRowsOf('draw_pack')).toHaveLength(1)
    expect(auditRowsOf('draw_pack')[0].entity).toBe('DrawPack') // untouched pin

    const row = rows[0]
    expect(row).toMatchObject({
      projectId: P1,
      actor: 'Amina (Client)',
      role: 'client',
      summary: 'Milestone approve by client', // the human line is unchanged
      entity: 'Milestone', // Prisma model name — the DrawPack convention
      entityId: 'm1',
    })

    // meta: WHAT was decided, on what evidence, with which money refs
    const meta = parsed(row, 'meta')
    expect(meta).toEqual({
      type: 'milestone.decide',
      decision: 'approve',
      milestoneId: 'm1',
      milestoneName: 'Foundation complete',
      amountCents: '80000000', // integer cents, BigInt → lossless string
      phaseId: 'ph-1',
      evidencePhotoIds: ['ph-1', 'ph-2'],
      ledgerRef: result.ledgerRef,
      ledgerTxnId: state.ledgerTxns[0]!.id,
      drawPackId: result.drawPackId,
    })

    // before/after: the frozen status transition + the evidence basis
    expect(parsed(row, 'before')).toEqual({ status: 'release_requested', evidencePhotoIds: ['ph-1', 'ph-2'] })
    expect(parsed(row, 'after')).toEqual({ status: 'released', evidencePhotoIds: ['ph-1', 'ph-2'] })
  })

  it('APPROVE with a note: the note rides the meta', async () => {
    await applyAction('milestone.decide', { id: 'm1', decision: 'approve', by: 'Amina (Client)', note: 'Good work' }, P1)
    const meta = parsed(auditRowsOf('milestone')[0]!, 'meta')
    expect(meta.note).toBe('Good work')
    expect(meta.decision).toBe('approve')
  })

  it('the reserved __audit key never leaves applyAction — the response contract is byte-identical', async () => {
    const result = await applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1)
    expect(Object.keys(result).sort()).toEqual(['balance', 'drawPackId', 'id', 'ledgerRef'])
    expect(result).toEqual({
      id: 'm1',
      balance: 700_000,
      ledgerRef: expect.any(String),
      drawPackId: expect.any(String),
    })
  })

  it('REJECT: same shape minus the money fields — no ledgerRef/ledgerTxnId/drawPackId, note + evidence refs present, no money moved', async () => {
    const result = await applyAction('milestone.decide', { id: 'm1', decision: 'reject', note: 'rework first' }, P1)

    expect(state.milestones.get('m1')!.status).toBe('rejected')
    expect(state.ledgerTxns).toHaveLength(0)
    expect(state.drawPacks.size).toBe(0)
    expect(auditRowsOf('draw_pack')).toHaveLength(0)

    const rows = auditRowsOf('milestone')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({ entity: 'Milestone', entityId: 'm1', summary: 'Milestone reject by client' })

    const meta = parsed(row, 'meta')
    expect(meta).toEqual({
      type: 'milestone.decide',
      decision: 'reject',
      note: 'rework first',
      milestoneId: 'm1',
      milestoneName: 'Foundation complete',
      amountCents: '80000000',
      phaseId: 'ph-1',
      evidencePhotoIds: ['ph-1', 'ph-2'],
    })
    // the reject path carries NO money refs — explicitly absent, not null-filled
    expect(meta).not.toHaveProperty('ledgerRef')
    expect(meta).not.toHaveProperty('ledgerTxnId')
    expect(meta).not.toHaveProperty('drawPackId')

    expect(parsed(row, 'before')).toEqual({ status: 'release_requested', evidencePhotoIds: ['ph-1', 'ph-2'] })
    expect(parsed(row, 'after')).toEqual({ status: 'rejected', evidencePhotoIds: ['ph-1', 'ph-2'] })
    // the reject result keeps its own contract (no __audit leak either)
    expect(Object.keys(result).sort()).toEqual(['balance', 'id'])
  })

  it('FROZEN AT DECISION TIME: a later evidence change never rewrites the audit row', async () => {
    await applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1)
    // simulate ANY post-decision drift on the milestone row (the status
    // ladder refuses new evidence on released/rejected milestones, but the
    // audit row must not depend on that — it is a decision-time snapshot)
    state.milestones.get('m1')!.evidencePhotoIds = '["ph-9"]'
    const row = auditRowsOf('milestone')[0]!
    expect(parsed(row, 'before').evidencePhotoIds).toEqual(['ph-1', 'ph-2'])
    expect(parsed(row, 'after').evidencePhotoIds).toEqual(['ph-1', 'ph-2'])
    expect(parsed(row, 'meta').evidencePhotoIds).toEqual(['ph-1', 'ph-2'])
  })

  it('ADDITIVE ctx merge: the ambient request context (ip/userAgent/requestId + kind entity) survives and the explicit ctx wins the entity', async () => {
    // the exact shape /api/actions auditContextFor builds (entity = the
    // lowercase kind there — the enrichment must override it, not lose it)
    await withAuditContext(
      { ip: '198.51.100.9', userAgent: 'audit-enrichment-test/1.0', requestId: 'req-218', entity: 'milestone', entityId: 'm1' },
      () => applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1),
    )
    const row = auditRowsOf('milestone')[0]!
    expect(row.ip).toBe('198.51.100.9')
    expect(row.userAgent).toBe('audit-enrichment-test/1.0')
    expect(row.requestId).toBe('req-218')
    expect(row.entity).toBe('Milestone') // explicit ctx over ambient kind
    expect(parsed(row, 'before').status).toBe('release_requested')
    expect(parsed(row, 'after').status).toBe('released')
  })

  it('APPROVE with a failed pack write: meta records drawPackId null honestly (the release stands, the failure is audited separately)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      state.failDrawPackCreate = true
      const result = await applyAction('milestone.decide', { id: 'm1', decision: 'approve' }, P1)
      expect(result.drawPackId).toBeNull()
      expect(state.milestones.get('m1')!.status).toBe('released') // the release stands
      const row = auditRowsOf('milestone')[0]!
      const meta = parsed(row, 'meta')
      expect(meta.drawPackId).toBeNull() // honest null — never fabricated
      expect(meta.ledgerRef).toMatch(/^LX-/) // the money ref is real
      // the pack failure carries its OWN audit row (create_failed) — separate
      const packEvents = auditRowsOf('draw_pack')
      expect(packEvents).toHaveLength(1)
      expect(parsed(packEvents[0]!, 'meta').type).toBe('draw_pack.create_failed')
    } finally {
      state.failDrawPackCreate = false
      errSpy.mockRestore()
    }
  })

  it('the note is truncated to the house 500-char bound (ids-and-refs size policy)', async () => {
    const longNote = 'x'.repeat(600)
    await applyAction('milestone.decide', { id: 'm1', decision: 'reject', note: longNote }, P1)
    const meta = parsed(auditRowsOf('milestone')[0]!, 'meta')
    expect(meta.note).toHaveLength(501) // 500 chars + the ellipsis
    expect(meta.note).toBe(`${'x'.repeat(500)}…`)
    // PII/size care: no photo binaries or URLs ever ride the row — ids only
    expect(JSON.stringify(meta)).not.toContain('/uploads/')
  })

  it('NON-DECISION money actions keep the historic { type }-only meta and no before/after', async () => {
    await applyAction('milestone.create', { name: 'Slab', amount: 650_000 }, P1)
    const rows = auditRowsOf('milestone')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(parsed(row, 'meta')).toEqual({ type: 'milestone.create' })
    expect(row.before).toBeUndefined()
    expect(row.after).toBeUndefined()
    expect(row.entity).toBeUndefined()
  })
})

// ================================================================ variation.decide

describe('#218 variation.decide — the same treatment', () => {
  it('APPROVE: decision + title + budget impact in meta, submitted → approved in before/after, entity = VariationOrder', async () => {
    const result = await applyAction(
      'variation.decide',
      { id: 'v1', decision: 'approve', by: 'Amina (Client)', note: 'agreed', __actor: 'Amina (Client)', __role: 'client' },
      P1,
    )

    expect(state.variations.get('v1')!.status).toBe('approved')
    const rows = auditRowsOf('variation')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      actor: 'Amina (Client)',
      role: 'client',
      summary: 'Variation approve by client',
      entity: 'VariationOrder',
      entityId: 'v1',
    })
    expect(parsed(row, 'meta')).toEqual({
      type: 'variation.decide',
      decision: 'approve',
      note: 'agreed',
      variationId: 'v1',
      title: 'Black cotton soil',
      budgetImpactCents: '18000000',
      phaseId: 'ph-1',
    })
    expect(parsed(row, 'before')).toEqual({ status: 'submitted' })
    expect(parsed(row, 'after')).toEqual({ status: 'approved' })
    // response contract unchanged — the reserved key is stripped
    expect(Object.keys(result).sort()).toEqual(['id'])
  })

  it('REJECT: submitted → rejected, budget untouched, no money-shaped fields', async () => {
    await applyAction('variation.decide', { id: 'v1', decision: 'reject' }, P1)
    expect(state.variations.get('v1')!.status).toBe('rejected')
    // the phase + project budgets are untouched on reject
    expect(state.phases.get('ph-1')!.budget).toBe(90_000_000n)
    expect(state.projects.get(P1)!.budget).toBe(450_000_000n)

    const row = auditRowsOf('variation')[0]!
    const meta = parsed(row, 'meta')
    expect(meta.decision).toBe('reject')
    expect(meta.budgetImpactCents).toBe('18000000')
    expect(meta).not.toHaveProperty('note') // no note was supplied
    expect(parsed(row, 'after')).toEqual({ status: 'rejected' })
  })
})

// ================================================================ payment.decide

describe('#218 payment.decide — the same treatment', () => {
  it('APPROVE: decision + requestCode + amount + payee in meta, pending → approved in before/after, entity = PaymentRequest', async () => {
    const result = await applyAction(
      'payment.decide',
      { id: 'pr-1', decision: 'approve', by: 'Amina (Client)', note: 'ok to pay', __actor: 'Amina (Client)', __role: 'client' },
      P1,
    )

    expect(state.paymentRequests.get('pr-1')!.status).toBe('approved')
    const rows = auditRowsOf('payment')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      actor: 'Amina (Client)',
      role: 'client',
      summary: 'Payment request approve — ok to pay',
      entity: 'PaymentRequest',
      entityId: 'pr-1',
    })
    expect(parsed(row, 'meta')).toEqual({
      type: 'payment.decide',
      decision: 'approve',
      note: 'ok to pay',
      paymentRequestId: 'pr-1',
      requestCode: 'PR-2026-000001',
      amountCents: '12000000',
      payee: 'Bamburi Supplies',
    })
    expect(parsed(row, 'before')).toEqual({ status: 'pending' })
    expect(parsed(row, 'after')).toEqual({ status: 'approved' })
    // response contract unchanged — the reserved key is stripped
    expect(Object.keys(result).sort()).toEqual(['decidedBy', 'id', 'status'])
  })

  it('REJECT: pending → rejected, no note key when none was supplied', async () => {
    await applyAction('payment.decide', { id: 'pr-1', decision: 'reject' }, P1)
    expect(state.paymentRequests.get('pr-1')!.status).toBe('rejected')
    const row = auditRowsOf('payment')[0]!
    const meta = parsed(row, 'meta')
    expect(meta.decision).toBe('reject')
    expect(meta).not.toHaveProperty('note')
    expect(parsed(row, 'before')).toEqual({ status: 'pending' })
    expect(parsed(row, 'after')).toEqual({ status: 'rejected' })
  })
})

// ================================================================ logAudit hardening

describe('#218 logAudit serialization hardening (DB-4 discipline)', () => {
  it('a BigInt inside meta/before serializes as a string instead of losing the whole row', async () => {
    // Pre-#218 this exact call THREW inside JSON.stringify and the row was
    // silently dropped (caught + logged by logAudit's outer catch) — the
    // latent v1-payments shape (amount: request.amount).
    await logAudit(
      P1,
      'wallet',
      { name: 'finance', role: 'finance' },
      'Deposit KSh 500',
      { type: 'wallet.deposit', amount: 50_000n, nested: { balance: 12_345n } },
      { entity: 'WalletAccount', entityId: 'w-1', before: { balance: 0n }, after: { balance: 50_000n } },
    )
    expect(state.auditEvents).toHaveLength(1)
    const row = state.auditEvents[0]!
    expect(parsed(row, 'meta')).toEqual({ type: 'wallet.deposit', amount: '50000', nested: { balance: '12345' } })
    expect(parsed(row, 'before')).toEqual({ balance: '0' })
    expect(parsed(row, 'after')).toEqual({ balance: '50000' })
  })

  it('non-serializable meta degrades to the row WITHOUT meta — never loses the row', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await logAudit(P1, 'action', { name: 'system', role: 'system' }, 'Weird payload', cyclic as Record<string, unknown>)
    expect(state.auditEvents).toHaveLength(1)
    expect(state.auditEvents[0]!.meta).toBeUndefined()
    expect(state.auditEvents[0]!.summary).toBe('Weird payload')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
