/**
 * Consumption posting (issue #186 / audit TEST-5, the consumption half) —
 * the `consumption.create` action: the Consumption model's ONLY writer.
 *
 * The inventory module has two stock surfaces, and only one of them was
 * pinned before this file:
 *  · the Site Store movement ledger (inventory.open/receive/consume/… →
 *    StockMovement rows, derived closing) — pinned by
 *    inventory-atomicity.test.ts (#119) + inventory-realdb.test.ts (#184);
 *  · the materials rollup (delivery.create → Delivery + auto-Transaction,
 *    consumption.create → Consumption rows; onSiteQty = delivered − consumed
 *    feeds the project payload's spend views and the AI anomaly
 *    reconciler) — pinned HERE and in inventory-consumption-realdb.test.ts.
 *
 * Pinned in this file (the applier over the standard in-memory stub — the
 * draw-pack.test.ts / share-regenerate-gate.test.ts idiom, real applyAction):
 *  · CREATION — exactly one project-scoped Consumption row, quantity kept as
 *    dispatched, empty phaseName/note normalised to null, date stamped now;
 *  · PROJECT SCOPE — the server-resolved projectId always wins over any
 *    payload.projectId copy; no arg + no payload → the first project;
 *  · VALIDATION — missing/empty materialId and non-positive or non-number
 *    quantities are refused BEFORE any write (no row, no audit entry);
 *  · AUDIT — the auto-logged Bias-Free Ledger row (kind 'material', the
 *    summarizeAction one-liner, actor defaults / __actor override), and
 *    auditing NEVER breaks the action (logAudit swallows its own failure);
 *  · APPEND-ONLY — an identical replay lands a second row (no idempotency
 *    key at this layer; the §57 sync seam's fingerprint dedupe deliberately
 *    excludes consumption — pinned as a source pin below);
 *  · THE HONEST GAP — the applier's numeric guard is `typeof number` +
 *    `<= 0`, so NaN and Infinity pass it; the row is attempted. The real
 *    engine's serialisation is the only backstop (pinned in the realdb
 *    companion). Pinned as-is here so a future finite-check fails this test
 *    on purpose.
 *
 * The DB-semantics invariants (FK enforcement, rollup math over real tables,
 * movement-ledger non-interference, spend views) live in
 * inventory-consumption-realdb.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// In-memory Prisma stub: just enough of project / consumption / auditEvent
// for the consumption.create posting path (the applier writes no other
// table — unlike delivery.create it does not even read the material).
vi.mock('@/backend/lib/db', () => {
  const state = {
    seq: 0,
    projects: [] as Array<Record<string, unknown>>,
    consumptions: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
    failAudit: false,
    reset() {
      state.projects = []
      state.consumptions = []
      state.audits = []
      state.seq = 0
      state.failAudit = false
    },
  }
  const nid = (p: string) => `${p}_${++state.seq}`
  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: { id: string } }) {
        return state.projects.find((p) => p.id === where.id) ?? null
      },
      async findFirst({ orderBy }: { orderBy?: Record<string, string> } = {}) {
        // resolveProjectId's fallback: first project by createdAt asc.
        const rows = [...state.projects]
        if (orderBy?.createdAt === 'asc') rows.sort((a, b) => Number(new Date(String(a.createdAt))) - Number(new Date(String(b.createdAt))))
        return rows[0] ?? null
      },
    },
    consumption: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: nid('cons'), createdAt: new Date(), ...data }
        state.consumptions.push(row)
        return { ...row }
      },
    },
    auditEvent: {
      async create({ data }: { data: Record<string, unknown> }) {
        if (state.failAudit) throw new Error('stub: simulated audit write failure')
        state.audits.push(data)
        return { id: nid('audit') }
      },
    },
  }
  return { db }
})

// The REAL applier graph (applyAction → applyCoreAction → case
// 'consumption.create' + the auto logAudit) against the stub above.
import { applyAction } from '@/backend/lib/mjengo'
import { db } from '@/backend/lib/db'
import { kindForAction, summarizeAction } from '@/backend/lib/audit'

type StubState = {
  projects: Array<Record<string, unknown>>
  consumptions: Array<Record<string, unknown>>
  audits: Array<Record<string, unknown>>
  failAudit: boolean
  reset: () => void
}
const state = (db as unknown as { __state: StubState }).__state

const P = 'p-1'
const MAT = 'mat-abc123'

beforeEach(() => {
  state.reset()
  state.projects.push(
    { id: 'p-1', name: 'Riverside', createdAt: new Date('2026-01-01T00:00:00Z') },
    { id: 'p-2', name: 'Karen', createdAt: new Date('2026-02-01T00:00:00Z') },
    { id: 'p-decoy', name: 'Decoy', createdAt: new Date('2026-03-01T00:00:00Z') },
  )
})

describe('consumption.create — one row, project-scoped, normalised (applyCoreAction)', () => {
  it('creates exactly one Consumption row with the dispatched quantity and null-normalised optionals', async () => {
    const before = Date.now()
    const r = await applyAction('consumption.create', { materialId: MAT, quantity: 30, phaseName: '', note: 'foundation pour' }, P)
    expect(r).toMatchObject({ id: expect.any(String) })
    expect(state.consumptions).toHaveLength(1)
    const row = state.consumptions[0]
    expect(row.projectId).toBe(P)
    expect(row.materialId).toBe(MAT)
    expect(row.quantity).toBe(30)
    expect(row.phaseName).toBeNull() // '' normalised — never an empty string
    expect(row.note).toBe('foundation pour')
    expect(row.date).toBeInstanceOf(Date)
    expect((row.date as Date).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('keeps a fractional quantity and passes absent optionals through as null', async () => {
    await applyAction('consumption.create', { materialId: MAT, quantity: 0.5 }, P)
    const row = state.consumptions[0]
    expect(row.quantity).toBe(0.5) // mortar sand by the half-bag is honest
    expect(row.phaseName).toBeNull()
    expect(row.note).toBeNull()
  })

  it('the server-resolved project always wins over a payload.projectId copy', async () => {
    await applyAction(
      'consumption.create',
      { materialId: MAT, quantity: 3, projectId: 'p-decoy' },
      P,
    )
    expect(state.consumptions[0].projectId).toBe(P)
    expect(state.consumptions).toHaveLength(1) // no second row for the decoy
  })

  it('without an explicit arg, payload.projectId resolves the scope; an unknown project refuses', async () => {
    await applyAction('consumption.create', { materialId: MAT, quantity: 2, projectId: 'p-2' })
    expect(state.consumptions[0].projectId).toBe('p-2')

    await expect(applyAction('consumption.create', { materialId: MAT, quantity: 2, projectId: 'p-nope' })).rejects.toThrow(
      'Project not found',
    )
    expect(state.consumptions).toHaveLength(1)
  })

  it('no arg and no payload → the first project (createdAt asc) is the scope', async () => {
    await applyAction('consumption.create', { materialId: MAT, quantity: 1 })
    expect(state.consumptions[0].projectId).toBe('p-1')
  })

  it('the applier does NOT look the material up — unlike delivery.create, the DB FK is the only guard', async () => {
    // Honest asymmetry, pinned as-is: delivery.create throws 'Unknown
    // material' (mjengo.ts), consumption.create accepts any non-empty id and
    // relies on the Consumption.materialId foreign key (P2003 on the real
    // engine — pinned in inventory-consumption-realdb.test.ts). If a future
    // refactor adds the applier-level check, this test fails on purpose —
    // update it with the fix.
    await applyAction('consumption.create', { materialId: 'mat-does-not-exist', quantity: 4 }, P)
    expect(state.consumptions).toHaveLength(1)
    expect(state.consumptions[0].materialId).toBe('mat-does-not-exist')
  })
})

describe('consumption.create — validation refuses before any write', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['materialId missing', { quantity: 5 }],
    ['materialId empty string', { materialId: '', quantity: 5 }],
    ['quantity missing', { materialId: MAT }],
    ['quantity zero', { materialId: MAT, quantity: 0 }],
    ['quantity negative', { materialId: MAT, quantity: -3 }],
    ['quantity a numeric string (offline JSON drift)', { materialId: MAT, quantity: '5' }],
    ['quantity null', { materialId: MAT, quantity: null }],
    ['quantity a boolean', { materialId: MAT, quantity: true }],
  ]

  it.each(BAD)('%s — no row, no audit entry', async (_label, payload) => {
    await expect(applyAction('consumption.create', payload, P)).rejects.toThrow(
      'materialId and positive quantity required',
    )
    expect(state.consumptions).toHaveLength(0)
    // The refusal happens inside the handler, BEFORE applyAction's logAudit —
    // a refused action leaves no ledger trace.
    expect(state.audits).toHaveLength(0)
  })

  it('THE HONEST GAP: NaN and Infinity pass the numeric guard and reach the write', async () => {
    // `typeof NaN === 'number'` and `NaN <= 0` is false, so the applier's
    // guard admits it (Infinity likewise). Pinned so the gap is visible: the
    // real engine's Float serialisation is the only backstop — see
    // inventory-consumption-realdb.test.ts for what SQLite/Prisma actually
    // does with each. A future Number.isFinite guard fails this on purpose.
    await applyAction('consumption.create', { materialId: MAT, quantity: NaN }, P)
    expect(state.consumptions).toHaveLength(1)
    expect(state.consumptions[0].quantity).toBeNaN()
    await applyAction('consumption.create', { materialId: MAT, quantity: Infinity }, P)
    expect(state.consumptions[1].quantity).toBe(Infinity)
  })
})

describe('consumption.create — the Bias-Free Ledger entry', () => {
  it('auto-logs kind material with the summarize one-liner and the default actor', async () => {
    await applyAction('consumption.create', { materialId: MAT, quantity: 30 }, P)
    expect(state.audits).toHaveLength(1)
    const audit = state.audits[0]
    expect(audit.kind).toBe('material') // kindForAction: 'consumption' → 'material'
    expect(audit.actor).toBe('Site Manager')
    expect(audit.role).toBe('contractor')
    expect(audit.summary).toBe(`Recorded consumption: 30× material ${MAT.slice(-6)}`)
    expect(audit.meta).toBe(JSON.stringify({ type: 'consumption.create' }))
  })

  it('honors the route-stamped __actor/__role and strips them from the payload', async () => {
    await applyAction(
      'consumption.create',
      { __actor: 'Amina (Supervisor)', __role: 'supervisor', materialId: MAT, quantity: 7, note: '' },
      P,
    )
    expect(state.audits[0].actor).toBe('Amina (Supervisor)')
    expect(state.audits[0].role).toBe('supervisor')
    // The actor stamps never reach the row (cleanPayload).
    expect(state.consumptions[0]).not.toHaveProperty('__actor')
    expect(state.consumptions[0]).not.toHaveProperty('__role')
  })

  it('an audit-write failure NEVER breaks the action (auditing must not break actions)', async () => {
    state.failAudit = true
    // logAudit swallows its own errors — the consumption row is the source of
    // truth and must survive a ledger outage.
    const r = await applyAction('consumption.create', { materialId: MAT, quantity: 9 }, P)
    expect(r).toMatchObject({ id: expect.any(String) })
    expect(state.consumptions).toHaveLength(1)
    expect(state.consumptions[0].quantity).toBe(9)
  })

  it('kindForAction / summarizeAction map consumption onto the material kind directly', () => {
    expect(kindForAction('consumption.create')).toBe('material')
    expect(summarizeAction('consumption.create', { materialId: MAT, quantity: 12 }, { id: 'x' })).toBe(
      `Recorded consumption: 12× material ${MAT.slice(-6)}`,
    )
  })
})

describe('consumption.create — append-only at the action layer', () => {
  it('an identical replay lands a SECOND row (legitimate double entry, no idem key here)', async () => {
    const payload = { materialId: MAT, quantity: 6, note: 'walling' }
    const a = await applyAction('consumption.create', payload, P)
    const b = await applyAction('consumption.create', payload, P)
    expect(a.id).not.toBe(b.id)
    expect(state.consumptions).toHaveLength(2)
    // Both rows are complete, standalone records.
    for (const row of state.consumptions) {
      expect(row).toMatchObject({ projectId: P, materialId: MAT, quantity: 6, note: 'walling' })
    }
  })
})

// ------------------------------------------------------ source pins (house style)

describe('source pins — append-only by construction, offline surfaces', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

  it('no mutation verb exists for consumption: create is the only case, update/delete are not actions', () => {
    const src = read('src/backend/lib/mjengo.ts')
    // Exactly one consumption case in the dispatcher — the create.
    const cases = src.match(/case 'consumption\.[a-z.]+'/g) ?? []
    expect(cases).toEqual(["case 'consumption.create'"])
    // And no mutation id is declared anywhere in the action union.
    expect(src).not.toContain("'consumption.update'")
    expect(src).not.toContain("'consumption.delete'")
    expect(src).toContain('| \'consumption.create\'') // the declared action id
  })

  it("sync's replay fingerprint dedupe deliberately EXCLUDES consumption (append-only rows must both land)", () => {
    const src = read('src/backend/api/sync.ts')
    // The comment sits ABOVE the const — window from the comment's first
    // words through the set's closing brace.
    const block = src.slice(src.indexOf('Actions whose EXACT replay'), src.indexOf('function todayEAT'))
    // The set literal itself…
    expect(block).not.toMatch(/'consumption\.create'/)
    // …and the documented reason (the comment names consumptions explicitly).
    expect(block).toContain('Deliberately excludes append-only rows (consumptions, deliveries, expenses')
  })

  it("the client's optimistic mirror clamps on-site stock exactly like the server rollup (never negative)", () => {
    // Server: onSiteQty = Math.max(0, deliveredQty - consumedQty)  (mjengo.ts)
    // Client: m.onSiteQty = Math.max(0, m.onSiteQty - payload.quantity)  (use-mjengo.ts)
    // Mirror drift here = the #183 bug class (local shows −4 bags, server
    // says 0) — pinned so both sides keep the SAME clamp.
    const server = read('src/backend/lib/mjengo.ts')
    const client = read('src/frontend/hooks/use-mjengo.ts')
    expect(server).toContain('const onSiteQty = Math.max(0, deliveredQty - consumedQty)')
    const mirror = client.slice(client.indexOf("case 'consumption.create'"), client.indexOf("case 'attendance.checkin'"))
    expect(mirror).toContain('m.consumedQty += payload.quantity')
    expect(mirror).toContain('m.onSiteQty = Math.max(0, m.onSiteQty - payload.quantity)')
    expect(mirror).toContain('m.stockValue = m.onSiteQty * m.unitPrice')
  })

  it('materials-tab dispatches consumption.create through the shared dispatch (outbox queueing offline)', () => {
    const src = read('src/frontend/mjengo/materials-tab.tsx')
    expect(src).toContain("dispatch('consumption.create'")
  })
})
