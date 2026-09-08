/**
 * MjengoScore invariants (issue W3-3) — the deterministic contractor trust
 * score: engine math, service persistence, action wiring, and the four
 * honesty guarantees.
 *
 * Pinned here:
 *   · DETERMINISM — the pure engine over identical inputs produces an
 *     identical result twice; the service over identical rows produces an
 *     identical score + components twice (two history rows).
 *   · TRACEABILITY — each of the 6 components has a fixture that moves it and
 *     ONLY it; every documented threshold is pinned by a formula test.
 *   · HONESTY — empty/young projects store score NULL + an explanation
 *     (never a fake 0 or 100); null components drop out of the weighted
 *     average (renormalization is deterministic).
 *   · HISTORY — every recompute appends a row; the first row is byte-identical
 *     after the second recompute; latest wins; there is no update path (the
 *     db stub deliberately exposes no update method + source greps).
 *   · NON-INFLUENCE — score rows are read by NOTHING outside the intel module
 *     and the score section (grep-level walk over src/); score.recompute is
 *     role-checked exactly like risk.recompute (contractor/admin, never
 *     clients/share links); no job or background path recomputes it.
 *   · MIGRATION — prisma/migrations/1_mjengo_score is additive-only: exactly
 *     one CREATE TABLE, no ALTER/DROP/UPDATE/DELETE/INSERT anywhere.
 *   · I18N — every score.* key exists in BOTH dictionaries; every t('score.…')
 *     literal in the section resolves.
 *
 * @/backend/lib/db is swapped for an in-memory stub (the
 * reports-budget-variance / delivery-photos pattern); the engines run REAL.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => {
  type Row = Record<string, unknown>

  const state = {
    seq: 0,
    projects: new Map<string, Row>(),
    phases: new Map<string, Row>(),
    tasks: new Map<string, Row>(),
    transactions: new Map<string, Row>(),
    milestones: new Map<string, Row>(),
    attendances: new Map<string, Row>(),
    variations: new Map<string, Row>(),
    orders: new Map<string, Row>(),
    deliveries: new Map<string, Row>(),
    deliveryLines: new Map<string, Row>(),
    invoices: new Map<string, Row>(),
    mjengoScores: new Map<string, Row>(),
    /** Fresh row id — exposed on __state so fixtures build deterministic rows. */
    _id(prefix: string) {
      return `${prefix}_${++state.seq}`
    },
    reset() {
      state.seq = 0
      for (const m of Object.values(state)) {
        if (m instanceof Map) m.clear()
      }
    },
  }

  /** Just enough of Prisma's where: equality, { gte }, { in }, { not }. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('gte' in c) {
          const a = row[key], b = c.gte
          if (a instanceof Date || b instanceof Date) {
            if (new Date(a as string).getTime() < new Date(b as string).getTime()) return false
          } else if (String(a) < String(b)) {
            return false
          }
          continue
        }
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
        if ('not' in c) {
          if (row[key] === (c.not as unknown)) return false
          continue
        }
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  /** orderBy support with a documented tie-break: later-inserted wins ties. */
  function orderIdx(row: Row): number {
    const n = Number(String(row.id).split('_').pop())
    return Number.isFinite(n) ? n : 0
  }
  function sorted(rows: Row[], orderBy?: Row): Row[] {
    if (!orderBy) return rows
    const [[field, dir]] = Object.entries(orderBy)
    const sign = dir === 'desc' ? -1 : 1
    return [...rows].sort((a, b) => {
      const av = a[field], bv = b[field]
      const cmp =
        av instanceof Date || bv instanceof Date
          ? new Date(av as string).getTime() - new Date(bv as string).getTime()
          : String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0
      if (cmp !== 0) return sign * cmp
      return sign * (orderIdx(a) - orderIdx(b)) // stable: last append wins on exact ties, in BOTH directions
    })
  }

  function scoped(map: Map<string, Row>, where: Row): Row[] {
    return [...map.values()].filter((r) => matches(r, where))
  }

  const db = {
    __state: state,
    project: {
      async findUnique({ where }: { where: Row }) {
        const row = state.projects.get(String(where.id))
        return row ? { ...row } : null
      },
    },
    phase: {
      async findMany({ where, orderBy, include }: { where: Row; orderBy?: Row; include?: Row }) {
        const rows = sorted(scoped(state.phases, where), orderBy)
        return rows.map((p) => ({
          ...p,
          ...(include?.tasks ? { tasks: scoped(state.tasks, { phaseId: p.id }).map((t) => ({ ...t })) } : {}),
        }))
      },
    },
    transaction: {
      async findMany({ where }: { where: Row }) {
        return scoped(state.transactions, where).map((t) => ({ ...t }))
      },
    },
    milestone: {
      async findMany({ where }: { where: Row }) {
        return scoped(state.milestones, where).map((m) => ({ ...m }))
      },
    },
    attendance: {
      async findMany({ where }: { where: Row }) {
        return scoped(state.attendances, where).map((a) => ({ ...a }))
      },
    },
    variationOrder: {
      async findMany({ where }: { where: Row }) {
        return scoped(state.variations, where).map((v) => ({ ...v }))
      },
    },
    purchaseOrder: {
      async findMany({ where, include }: { where: Row; include?: Row }) {
        const rows = scoped(state.orders, where).map((o) => ({ ...o }))
        if (!include?.deliveries) return rows
        return rows.map((o) => ({
          ...o,
          deliveries: scoped(state.deliveries, { orderId: o.id }).map((d) => ({
            ...d,
            ...(include.deliveries?.include?.lines
              ? { lines: scoped(state.deliveryLines, { deliveryId: d.id }).map((l) => ({ ...l })) }
              : {}),
          })),
        }))
      },
    },
    invoice: {
      async findMany({ where }: { where: Row }) {
        return scoped(state.invoices, where).map((i) => ({ ...i }))
      },
    },
    // Append-only by construction: create/findFirst/findMany ONLY. There is
    // deliberately NO update method — the contract under test.
    mjengoScore: {
      async create({ data }: { data: Row }) {
        const row = { id: `ms_${++state.seq}`, ...data }
        state.mjengoScores.set(row.id, row)
        return { ...row }
      },
      async findFirst({ where, orderBy }: { where: Row; orderBy?: Row }) {
        const rows = sorted(scoped(state.mjengoScores, where), orderBy)
        const row = rows[0]
        return row ? { ...row } : null
      },
      async findMany({ where }: { where: Row }) {
        return scoped(state.mjengoScores, where).map((r) => ({ ...r }))
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import {
  computeMjengoScore, SCORE_RULE_VERSION, SCORE_WEIGHTS,
  ATTENDANCE_WINDOW_DAYS, BUDGET_LEAD_CAP_POINTS, VARIATION_IMPACT_CAP_RATIO,
  DELIVERY_DISCREPANCY_CAP_RATIO, INVOICE_DISPUTE_CAP_RATIO, MIN_COMPONENTS_FOR_SCORE,
  type MjengoScoreInput, type ScoreComponentKey,
} from '@/backend/modules/intel/score'
import { recomputeScore } from '@/backend/modules/intel/service'
import { applyIntelAction, INTEL_ACTIONS } from '@/backend/actions/intel'
import { intelCan, type IntelRole } from '@/backend/modules/intel/policy'
import { kindForAction, summarizeAction } from '@/backend/lib/audit'
import { CLIENT_ACTIONS } from '@/shared/client-actions'
import { parseScoreComponents } from '@/backend/modules/intel/types'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'

const state = (db as unknown as { __state: {
  projects: Map<string, Record<string, unknown>>
  phases: Map<string, Record<string, unknown>>
  tasks: Map<string, Record<string, unknown>>
  transactions: Map<string, Record<string, unknown>>
  milestones: Map<string, Record<string, unknown>>
  attendances: Map<string, Record<string, unknown>>
  variations: Map<string, Record<string, unknown>>
  orders: Map<string, Record<string, unknown>>
  deliveries: Map<string, Record<string, unknown>>
  deliveryLines: Map<string, Record<string, unknown>>
  invoices: Map<string, Record<string, unknown>>
  mjengoScores: Map<string, Record<string, unknown>>
  reset: () => void
  _id: (prefix: string) => string
} }).__state

const P1 = 'proj-1'
const NOW = new Date('2026-06-15T12:00:00.000Z')
// The service scopes attendance with a real clock — fixture rows must sit
// INSIDE the trailing 30-day window of the actual test run date.
const TODAY = new Date().toISOString().slice(0, 10)

// ---------------- fixtures ----------------

function seedProject(id = P1, budget = 4_500_000) {
  state.projects.set(id, {
    id, name: 'Nyumba Yangu', client: 'Amina', clientType: 'diaspora', location: 'Karen',
    budget, status: 'active', shareToken: 'tok-1',
    startDate: new Date('2026-01-05T09:00:00Z'), targetDate: new Date('2026-08-01T09:00:00Z'),
    createdAt: new Date('2026-01-05T09:00:00Z'), updatedAt: new Date('2026-01-05T09:00:00Z'),
  })
}

function seedPhases() {
  const defs: Array<[string, number, number]> = [
    ['Site Prep & Foundation', 900_000, 100],
    ['Walling', 1_200_000, 62],
    ['Roofing', 800_000, 0],
    ['Plumbing & Electrical', 600_000, 0],
    ['Finishing', 1_000_000, 0],
  ]
  for (const [name, budget, progress] of defs) {
    state.phases.set(state._id('f'), {
      id: `f-${name}`, projectId: P1, name, order: defs.findIndex((d) => d[0] === name),
      budget, status: 'pending', progressManual: progress,
      createdAt: NOW, updatedAt: NOW,
    })
  }
}

function seedFullProject() {
  seedProject()
  seedPhases()
  // spend 2,000,000 → spentPct 44.4% vs progress 37% → lead 7.44 pts
  for (const [id, amount] of [['t1', 1_200_000], ['t2', 800_000]] as const) {
    state.transactions.set(id, {
      id, projectId: P1, type: 'material', amount, method: 'mpesa',
      reference: null, costCode: null, ledgerTxnId: null, note: null,
      date: NOW, createdAt: NOW,
    })
  }
  // 2 released milestones: one with 2 evidence photos, one with none
  state.milestones.set('m1', { id: 'm1', projectId: P1, phaseId: 'f-Foundation', name: 'Foundation complete', amount: 800_000, status: 'released', evidencePhotoIds: '["ph1","ph2"]', createdAt: NOW })
  state.milestones.set('m2', { id: 'm2', projectId: P1, phaseId: 'f-Walling', name: 'Walling to ring beam', amount: 650_000, status: 'released', evidencePhotoIds: '[]', createdAt: NOW })
  state.milestones.set('m3', { id: 'm3', projectId: P1, phaseId: 'f-Roofing', name: 'Roofing package', amount: 500_000, status: 'locked', evidencePhotoIds: '[]', createdAt: NOW })
  // 10 attendance rows: 8 verified, 2 reported
  for (let i = 0; i < 10; i++) {
    state.attendances.set(`att${i}`, {
      id: `att${i}`, workerId: `w${i}`, projectId: P1, date: TODAY,
      status: 'present', method: 'geofence', wage: 500, paid: true,
      verification: i < 8 ? 'verified' : 'reported',
      createdAt: NOW,
    })
  }
  // 2 variations: 1 approved (+180k), 1 submitted (+95k)
  state.variations.set('v1', { id: 'v1', projectId: P1, phaseId: 'f-Foundation', title: 'Black cotton soil', description: 'deeper foundation', budgetImpact: 180_000, status: 'approved', createdAt: NOW })
  state.variations.set('v2', { id: 'v2', projectId: P1, phaseId: 'f-Finishing', title: 'Granite upgrade', description: 'counter upgrade', budgetImpact: 95_000, status: 'submitted', createdAt: NOW })
  // 8 landed deliveries: 7 received, 1 discrepancy
  state.orders.set('po1', { id: 'po1', projectId: P1, orderCode: 'PO-2026-000009', status: 'delivered', createdAt: NOW })
  for (let i = 0; i < 8; i++) {
    state.deliveries.set(`dl${i}`, {
      id: `dl${i}`, orderId: 'po1', status: i === 0 ? 'discrepancy' : 'received',
      dispatchedAt: NOW, receivedAt: NOW, photoCount: 0,
    })
    state.deliveryLines.set(`dl${i}-l1`, {
      id: `dl${i}-l1`, deliveryId: `dl${i}`, orderLineId: `ol${i}`,
      qtyOrdered: 50, qtyReceived: i === 0 ? 48 : 50, qtyRejected: 0, condition: 'ok',
    })
  }
  // 6 invoices: 1 disputed, 5 not
  for (let i = 0; i < 6; i++) {
    state.invoices.set(`inv${i}`, {
      id: `inv${i}`, invoiceCode: `INV-2026-${String(i + 1).padStart(6, '0')}`, projectId: P1,
      status: i === 0 ? 'disputed' : 'paid', subtotal: 10_000, tax: 0, total: 10_000,
      createdAt: NOW, updatedAt: NOW,
    })
  }
}

/** The full pure-engine input matching seedFullProject (base of isolation fixtures). */
function fullInput(): MjengoScoreInput {
  return {
    now: NOW,
    releasedMilestones: [
      { id: 'm1', name: 'Foundation complete', evidencePhotoCount: 2 },
      { id: 'm2', name: 'Walling to ring beam', evidencePhotoCount: 0 },
    ],
    attendances: [
      ...Array.from({ length: 8 }, () => ({ verification: 'verified' })),
      ...Array.from({ length: 2 }, () => ({ verification: 'reported' })),
    ],
    phases: [
      { name: 'Foundation', status: 'done', budget: 900_000, progressManual: 100, tasks: [] },
      { name: 'Walling', status: 'in_progress', budget: 1_200_000, progressManual: 62, tasks: [] },
      { name: 'Roofing', status: 'pending', budget: 800_000, progressManual: 0, tasks: [] },
      { name: 'Plumbing', status: 'pending', budget: 600_000, progressManual: 0, tasks: [] },
      { name: 'Finishing', status: 'pending', budget: 1_000_000, progressManual: 0, tasks: [] },
    ],
    transactions: [{ amount: 1_200_000 }, { amount: 800_000 }],
    projectBudget: 4_500_000,
    variations: [
      { title: 'Black cotton soil', status: 'approved', budgetImpact: 180_000 },
      { title: 'Granite upgrade', status: 'submitted', budgetImpact: 95_000 },
    ],
    deliveries: [
      { status: 'discrepancy', lines: [{ qtyOrdered: 50, qtyReceived: 48 }] },
      ...Array.from({ length: 7 }, () => ({ status: 'received', lines: [{ qtyOrdered: 50, qtyReceived: 50 }] })),
    ],
    invoices: [
      { status: 'disputed' },
      ...Array.from({ length: 5 }, () => ({ status: 'paid' })),
    ],
  }
}

function componentByKey(components: Array<{ key: string }>, key: ScoreComponentKey) {
  return components.find((c) => c.key === key)!
}

beforeEach(() => {
  state.reset()
})

// ================================================================ engine

describe('MjengoScore engine — determinism', () => {
  it('two computes over identical fixtures produce identical score + components (deep)', () => {
    const a = computeMjengoScore(fullInput())
    const b = computeMjengoScore(fullInput())
    expect(a).toEqual(b)
    expect(a.score).not.toBeNull()
    expect(a.components).toHaveLength(6)
  })

  it('rule version is pinned and the 6 weights sum to 100', () => {
    expect(SCORE_RULE_VERSION).toBe('1')
    const total = Object.values(SCORE_WEIGHTS).reduce((s, w) => s + w, 0)
    expect(total).toBe(100)
    expect(Object.keys(SCORE_WEIGHTS)).toHaveLength(6)
  })

  it('documented thresholds are pinned', () => {
    expect(ATTENDANCE_WINDOW_DAYS).toBe(30)
    expect(BUDGET_LEAD_CAP_POINTS).toBe(30)
    expect(VARIATION_IMPACT_CAP_RATIO).toBe(0.15)
    expect(DELIVERY_DISCREPANCY_CAP_RATIO).toBe(0.25)
    expect(INVOICE_DISPUTE_CAP_RATIO).toBe(0.2)
    expect(MIN_COMPONENTS_FOR_SCORE).toBe(2)
  })
})

describe('MjengoScore engine — component formulas (traceable thresholds)', () => {
  it('evidence_backed_releases: ratio of released milestones with ≥1 evidence photo, weight 20', () => {
    const r = computeMjengoScore(fullInput())
    const c = componentByKey(r.components, 'evidence_backed_releases')
    // 1 of 2 released milestones carries photos → 50% → −10 of 20
    expect(c.value).toBe(50)
    expect(c.deduction).toBe(10)
    expect(c.evidence).toContain('1 of 2 released milestones')
  })

  it('attendance_verification: verified share over the trailing window, weight 15', () => {
    const r = computeMjengoScore(fullInput())
    const c = componentByKey(r.components, 'attendance_verification')
    // 8 of 10 verified → 80% → −3 of 15
    expect(c.value).toBe(80)
    expect(c.deduction).toBe(3)
    expect(c.evidence).toContain('8 of 10 attendance rows verified')
    expect(c.evidence).toContain('last 30 days')
  })

  it('budget_discipline: R1 budget_pace lead maps linearly to 30 pts = −20', () => {
    const input = fullInput()
    // spent 2,000,000 = 44% of the 4.5M phase budget, progress 37% → lead 7.44 pts
    const c = componentByKey(computeMjengoScore(input).components, 'budget_discipline')
    expect(c.value).toBe(75) // round(100 − (7.44/30)×100)
    expect(c.deduction).toBe(5) // (7.44/30) × 20
    expect(c.evidence).toContain('R1 budget_pace')
    // at the R1 critical line (30 pts ahead) the full weight deducts
    const critical = computeMjengoScore({
      ...input,
      transactions: [{ amount: 4_495_000 }], // ~99.9% spent, 37% progress → lead > 30
    })
    const cc = componentByKey(critical.components, 'budget_discipline')
    expect(cc.deduction).toBe(20)
    expect(cc.value).toBe(0)
  })

  it('variation_discipline: approved impact / project budget, 15% = −15', () => {
    const r = computeMjengoScore(fullInput())
    const c = componentByKey(r.components, 'variation_discipline')
    // 180k approved impact on a 4.5M budget = 4.0% → (0.04/0.15) × 15 = 4
    expect(c.value).toBe(73)
    expect(c.deduction).toBe(4)
    expect(c.evidence).toContain('1 of 2 approved')
    expect(c.evidence).toContain('4.0%')
    // at 15% of the budget the full weight deducts
    const maxed = computeMjengoScore({ ...fullInput(), variations: [{ title: 'Big', status: 'approved', budgetImpact: 675_000 }] })
    expect(componentByKey(maxed.components, 'variation_discipline').deduction).toBe(15)
  })

  it('delivery_discrepancy: discrepancy share of landed deliveries, 25% = −15', () => {
    const r = computeMjengoScore(fullInput())
    const c = componentByKey(r.components, 'delivery_discrepancy')
    // 1 of 8 landed = 12.5% → (0.125/0.25) × 15 = 7.5
    expect(c.value).toBe(88)
    expect(c.deduction).toBe(7.5)
    expect(c.evidence).toContain('1 of 8 landed deliveries')
    // in-transit rows are NOT evidence either way (excluded from the denominator)
    const transit = computeMjengoScore({ ...fullInput(), deliveries: [...fullInput().deliveries, { status: 'in_transit', lines: [] }] })
    expect(componentByKey(transit.components, 'delivery_discrepancy').deduction).toBe(7.5)
  })

  it('invoice_disputes: disputed share of all invoices, 20% = −15', () => {
    const r = computeMjengoScore(fullInput())
    const c = componentByKey(r.components, 'invoice_disputes')
    // 1 of 6 disputed = 16.7% → (0.1667/0.2) × 15 = 12.5
    expect(c.value).toBe(83)
    expect(c.deduction).toBe(12.5)
    expect(c.evidence).toContain('1 of 6 invoices disputed')
    const maxed = computeMjengoScore({ ...fullInput(), invoices: [{ status: 'paid' }, { status: 'paid' }, { status: 'paid' }, { status: 'paid' }, { status: 'paid' }, { status: 'disputed' }, { status: 'disputed' }] })
    expect(componentByKey(maxed.components, 'invoice_disputes').deduction).toBe(15)
  })
})

describe('MjengoScore engine — each fixture moves its component and ONLY it', () => {
  const CASES: Array<{ key: ScoreComponentKey; label: string; mutate: (i: MjengoScoreInput) => MjengoScoreInput }> = [
    {
      key: 'evidence_backed_releases', label: 'attach evidence to the second released milestone',
      mutate: (i) => ({ ...i, releasedMilestones: i.releasedMilestones.map((m) => (m.id === 'm2' ? { ...m, evidencePhotoCount: 2 } : m)) }),
    },
    {
      key: 'attendance_verification', label: 'verify one reported attendance row',
      mutate: (i) => ({ ...i, attendances: i.attendances.map((a, idx) => (idx === 8 ? { verification: 'verified' } : a)) }),
    },
    {
      key: 'budget_discipline', label: 'spend another 500,000 (R1 lead grows)',
      mutate: (i) => ({ ...i, transactions: [...i.transactions, { amount: 500_000 }] }),
    },
    {
      key: 'variation_discipline', label: 'approve another +200,000 variation',
      mutate: (i) => ({ ...i, variations: [...i.variations, { title: 'Extra works', status: 'approved', budgetImpact: 200_000 }] }),
    },
    {
      key: 'delivery_discrepancy', label: 'one received delivery closes discrepant',
      mutate: (i) => ({ ...i, deliveries: i.deliveries.map((d, idx) => (idx === 1 ? { status: 'discrepancy', lines: [{ qtyOrdered: 50, qtyReceived: 45 }] } : d)) }),
    },
    {
      key: 'invoice_disputes', label: 'a paid invoice becomes disputed',
      mutate: (i) => ({ ...i, invoices: i.invoices.map((inv, idx) => (idx === 1 ? { status: 'disputed' } : inv)) }),
    },
  ]

  for (const { key, label, mutate } of CASES) {
    it(`${key} — ${label}`, () => {
      const base = computeMjengoScore(fullInput())
      const moved = computeMjengoScore(mutate(fullInput()))
      const before = componentByKey(base.components, key)
      const after = componentByKey(moved.components, key)
      expect(after.value, `${key} value must move`).not.toBe(before.value)
      expect(after.deduction, `${key} deduction must move`).not.toBe(before.deduction)
      // every OTHER component is byte-identical — the fixture moved it and only it
      for (const other of base.components) {
        if (other.key === key) continue
        expect(componentByKey(moved.components, other.key), `${other.key} must be untouched`).toEqual(other)
      }
    })
  }
})

describe('MjengoScore engine — score aggregation + confidence', () => {
  it('full fixture: 100 − Σ deductions (weights all available) = 58, confidence high', () => {
    const r = computeMjengoScore(fullInput())
    // deductions 10 + 3 + 5 + 4 + 7.5 + 12.5 = 42 of 100 → round(57.7… adjusted) = 58
    expect(r.score).toBe(58)
    expect(r.confidence).toBe('high')
    expect(r.notes).toBeNull()
  })

  it('null components drop out and the weights renormalize (deterministic)', () => {
    // only releases + attendance have data → weights 20 + 15 = 35, deductions 10 + 3
    const r = computeMjengoScore({
      ...fullInput(),
      phases: [], transactions: [], projectBudget: 0, variations: [], deliveries: [], invoices: [],
    })
    expect(r.score).toBe(63) // round(100 × (1 − 13/35))
    expect(r.confidence).toBe('low') // exactly 2 components
    expect(r.components.filter((c) => c.value !== null)).toHaveLength(2)
  })

  it('confidence ladder: 2 components low · 3 medium · 5 high', () => {
    const two = computeMjengoScore({ ...fullInput(), phases: [], transactions: [], projectBudget: 0, variations: [], deliveries: [], invoices: [] })
    expect(two.confidence).toBe('low')
    const three = computeMjengoScore({ ...fullInput(), projectBudget: 0, variations: [], deliveries: [], invoices: [] })
    expect(three.confidence).toBe('medium')
    const five = computeMjengoScore({ ...fullInput(), deliveries: [] })
    expect(five.confidence).toBe('high')
  })

  it('a legitimately worst project earns an honest 0 (deductions sum to 100)', () => {
    const r = computeMjengoScore({
      ...fullInput(),
      releasedMilestones: [{ id: 'm1', name: 'No evidence', evidencePhotoCount: 0 }],
      attendances: fullInput().attendances.map(() => ({ verification: 'reported' })),
      transactions: [{ amount: 4_495_000 }],
      variations: [{ title: 'Big', status: 'approved', budgetImpact: 675_000 }],
      deliveries: [{ status: 'discrepancy', lines: [{ qtyOrdered: 50, qtyReceived: 10 }] }],
      invoices: [{ status: 'disputed' }],
    })
    expect(r.score).toBe(0)
    expect(r.confidence).toBe('high') // all 6 components have rows — an honest 0, not a punishment
  })
})

describe('MjengoScore engine — empty/young projects (honesty)', () => {
  it('empty project: every component null, score NULL (not 0, not 100), notes explain', () => {
    const r = computeMjengoScore({
      now: NOW, releasedMilestones: [], attendances: [], phases: [], transactions: [],
      projectBudget: 0, variations: [], deliveries: [], invoices: [],
    })
    expect(r.components.every((c) => c.value === null && c.deduction === null)).toBe(true)
    expect(r.score).toBeNull()
    expect(r.confidence).toBe('low')
    expect(r.notes).toBeTruthy()
    expect(r.notes).toContain('0 of 6 components')
    expect(r.notes).toContain('Not enough history')
  })

  it('young project with a single component: still score NULL + explanation', () => {
    const r = computeMjengoScore({ ...fullInput(), releasedMilestones: [], attendances: [], phases: [], transactions: [], projectBudget: 0, variations: [], deliveries: [] })
    // invoices is the only component with rows → 1 of 6
    expect(r.score).toBeNull()
    expect(r.notes).toContain('1 of 6')
  })

  it('each component is null on its own honest "no rows" reason', () => {
    const r = computeMjengoScore({
      now: NOW, releasedMilestones: [], attendances: [], phases: [], transactions: [],
      projectBudget: 0, variations: [], deliveries: [], invoices: [],
    })
    for (const c of r.components) {
      expect(c.evidence).toMatch(/no .+ (yet|on record|in the last)/)
    }
  })
})

// ================================================================ service

describe('recomputeScore — persistence (append-only history)', () => {
  it('computes the full-fixture score from real query shapes and appends one row', async () => {
    seedFullProject()
    const result = await recomputeScore(P1)
    expect(result.score).toBe(58)
    expect(result.confidence).toBe('high')
    expect(result.ruleVersion).toBe(SCORE_RULE_VERSION)
    const rows = await db.mjengoScore.findMany({ where: { projectId: P1 } })
    expect(rows).toHaveLength(1)
    expect(rows[0].score).toBe(58)
    const parsed = parseScoreComponents(String(rows[0].components))
    expect(parsed).toHaveLength(6)
    expect(parsed.map((c) => c.key)).toEqual([
      'evidence_backed_releases', 'attendance_verification', 'budget_discipline',
      'variation_discipline', 'delivery_discrepancy', 'invoice_disputes',
    ])
  })

  it('determinism: two recomputes over identical rows → identical score + components, two rows', async () => {
    seedFullProject()
    const first = await recomputeScore(P1)
    const second = await recomputeScore(P1)
    expect(second.score).toBe(first.score)
    expect(second.confidence).toBe(first.confidence)
    expect(second.notes).toBe(first.notes)
    expect(second.components).toEqual(first.components)
    const rows = await db.mjengoScore.findMany({ where: { projectId: P1 } })
    expect(rows).toHaveLength(2)
  })

  it('history: the second recompute appends a NEW row; the first is never updated; latest wins', async () => {
    seedFullProject()
    const first = await recomputeScore(P1)
    const firstRowSnapshot = { ...(await db.mjengoScore.findMany({ where: { projectId: P1 } }))[0] }

    // rows change between computes (a paid invoice becomes disputed)
    state.invoices.set('inv1', { ...state.invoices.get('inv1')!, status: 'disputed' })
    const second = await recomputeScore(P1)
    expect(second.score).not.toBe(first.score)

    const rows = await db.mjengoScore.findMany({ where: { projectId: P1 } })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
    // the first row is byte-identical to its snapshot — no field was touched
    const firstRow = rows.find((r) => r.id === first.id)!
    expect({ ...firstRow }).toEqual(firstRowSnapshot)
    // latest wins: findFirst (the repository read) returns the newest compute
    const latest = await db.mjengoScore.findFirst({ where: { projectId: P1 }, orderBy: { computedAt: 'desc' } })
    expect(latest!.id).toBe(second.id)
    expect(latest!.score).toBe(second.score)
  })

  it('no update path exists: the stub exposes no update method and the service never calls one', async () => {
    const scoreDelegate = (db as unknown as { mjengoScore: Record<string, unknown> }).mjengoScore
    expect(Object.keys(scoreDelegate).sort()).toEqual(['create', 'findFirst', 'findMany'])
    const serviceSrc = readFileSync(
      fileURLToPath(new URL('../../src/backend/modules/intel/service.ts', import.meta.url)),
      'utf8',
    )
    expect(serviceSrc).not.toMatch(/mjengoScore\.update|mjengoScore\.upsert|mjengoScore\.delete/)
  })

  it('empty project → honest low-confidence row: score NULL + explanation, all components null', async () => {
    seedProject()
    const result = await recomputeScore(P1)
    expect(result.score).toBeNull()
    expect(result.confidence).toBe('low')
    expect(result.notes).toContain('Not enough history')
    const parsed = parseScoreComponents(String((await db.mjengoScore.findMany({ where: { projectId: P1 } }))[0].components))
    expect(parsed.every((c) => c.value === null)).toBe(true)
    // persisted row is honest too — NULL, never a fake 0 or 100
    expect((await db.mjengoScore.findMany({ where: { projectId: P1 } }))[0].score).toBeNull()
  })

  it('unknown project → honest error', async () => {
    await expect(recomputeScore('missing')).rejects.toThrow('Project not found')
  })

  it('milestone evidence JSON is parsed defensively (malformed → 0 photos)', async () => {
    seedFullProject()
    // m1 carried 2 photo ids — corrupt the JSON → honest count 0
    state.milestones.set('m1', { ...state.milestones.get('m1')!, evidencePhotoIds: 'not-json' })
    const result = await recomputeScore(P1)
    const c = componentByKey(result.components, 'evidence_backed_releases')
    expect(c.value).toBe(0) // 0 of 2 released milestones with photos
    expect(c.evidence).toContain('0 of 2 released milestones')
  })

  it('attendance window: only the trailing 30 days count (R5-style scoping)', async () => {
    seedFullProject()
    // 3 stale rows far outside the window must NOT move the rate
    for (let i = 0; i < 3; i++) {
      state.attendances.set(`old${i}`, {
        id: `old${i}`, workerId: `ow${i}`, projectId: P1, date: '2020-01-01',
        status: 'present', method: 'geofence', wage: 500, paid: true, verification: 'verified', createdAt: NOW,
      })
    }
    const result = await recomputeScore(P1)
    const c = componentByKey(result.components, 'attendance_verification')
    expect(c.value).toBe(80) // still 8 of the 10 in-window rows
    expect(c.evidence).toContain('8 of 10')
  })
})

// ================================================================ action wiring

describe('score.recompute — a normal intel action (audit + roles)', () => {
  it('is registered in INTEL_ACTIONS and dispatchable through applyIntelAction', async () => {
    expect(INTEL_ACTIONS).toContain('score.recompute')
    seedFullProject()
    const result = await applyIntelAction('score.recompute', {}, P1)
    expect(result).toMatchObject({ score: 58, confidence: 'high', ruleVersion: '1' })
    expect(result.componentsCount).toBe(6)
    expect(await db.mjengoScore.findMany({ where: { projectId: P1 } })).toHaveLength(1)
  })

  it('writes a distinctive audit kind + honest one-liner summary (auto-audited by applyAction)', () => {
    expect(kindForAction('score.recompute')).toBe('mjengo_score')
    expect(summarizeAction('score.recompute', {}, { score: 58, confidence: 'high', componentsCount: 6, ruleVersion: '1' }))
      .toContain('58/100')
    expect(summarizeAction('score.recompute', {}, { score: 58, confidence: 'high', componentsCount: 6, ruleVersion: '1' }))
      .toContain('humans decide')
    // null-score variant is honest too
    const nullSummary = summarizeAction('score.recompute', {}, { score: null, componentsCount: 1, ruleVersion: '1' })
    expect(nullSummary).toContain('no score yet')
  })

  it('role matrix mirrors risk.recompute EXACTLY: contractor/admin only', () => {
    const roles: IntelRole[] = ['contractor', 'admin', 'supervisor', 'client', 'finance', 'share_client']
    for (const role of roles) {
      expect(intelCan(role, 'score.recompute'), `score.recompute for ${role}`).toBe(intelCan(role, 'risk.recompute'))
    }
    expect(intelCan('contractor', 'score.recompute')).toBe(true)
    expect(intelCan('admin', 'score.recompute')).toBe(true)
    expect(intelCan('supervisor', 'score.recompute')).toBe(false)
    expect(intelCan('client', 'score.recompute')).toBe(false)
    expect(intelCan('finance', 'score.recompute')).toBe(false)
    expect(intelCan('share_client', 'score.recompute')).toBe(false)
  })

  it('clients and share links can never dispatch it (not in CLIENT_ACTIONS)', () => {
    expect(CLIENT_ACTIONS).not.toContain('score.recompute')
  })
})

// ================================================================ non-influence (grep-level)

describe('non-influence: score rows change no action outcomes anywhere', () => {
  /** Recursively collect .ts/.tsx files under a directory. */
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
    }
    return out
  }

  it('MjengoScore / mjengoScore / score.recompute appear ONLY in the intel module, its action registration, the audit label map and the score section', () => {
    const root = fileURLToPath(new URL('../../src', import.meta.url))
    const allowlist = new Set([
      'src/backend/modules/intel/score.ts',
      'src/backend/modules/intel/service.ts',
      'src/backend/modules/intel/types.ts',
      'src/backend/modules/intel/repository.ts',
      'src/backend/modules/intel/policy.ts',
      'src/backend/actions/intel.ts',
      'src/backend/lib/audit.ts', // kind map + ledger one-liner only — no reads
      'src/frontend/mjengo/intel/sections/score-section.tsx',
      'src/frontend/mjengo/intel-tab.tsx', // mounts the section — display wiring only
      // display strings only — dictionary values, no logic, cannot influence actions
      'src/frontend/i18n/dicts/en.ts',
      'src/frontend/i18n/dicts/sw.ts',
    ].map((p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))))
    const offenders: string[] = []
    for (const file of walk(root)) {
      if (file.includes('score-section.test')) continue
      const src = readFileSync(file, 'utf8')
      if (/MjengoScore|mjengoScore|score\.recompute/.test(src) && !allowlist.has(file)) {
        offenders.push(file.replace(`${root}/`, ''))
      }
    }
    expect(offenders, `files outside the allowlist reference the score: ${offenders.join(', ')}`).toEqual([])
  })

  it('no action handler reads the score: the mutating modules stay score-blind', () => {
    const modules = [
      'src/backend/actions/money.ts', 'src/backend/actions/supply.ts', 'src/backend/actions/invoices.ts',
      'src/backend/actions/trust.ts', 'src/backend/actions/evidence.ts', 'src/backend/actions/land.ts',
      'src/backend/actions/professionals.ts', 'src/backend/actions/wallet.ts', 'src/backend/actions/inventory.ts',
      'src/backend/lib/mjengo.ts', 'src/backend/api/actions.ts',
    ]
    for (const rel of modules) {
      const src = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
      expect(src, `${rel} must not reference MjengoScore`).not.toMatch(/MjengoScore|mjengoScore/)
    }
  })

  it('no background path recomputes it: jobs handlers never dispatch score.recompute', () => {
    const jobsSrc = readFileSync(
      fileURLToPath(new URL('../../src/backend/modules/jobs/handlers.ts', import.meta.url)),
      'utf8',
    )
    expect(jobsSrc).not.toMatch(/score\.recompute|computeMjengoScore|MjengoScore/)
  })

  it('the score appears in no decision/gate branch of the intel service (view-only read path)', () => {
    const repoSrc = readFileSync(
      fileURLToPath(new URL('../../src/backend/modules/intel/repository.ts', import.meta.url)),
      'utf8',
    )
    expect(repoSrc).toContain('db.mjengoScore.findFirst') // the ONE read — latest wins
    expect(repoSrc).toContain("orderBy: { computedAt: 'desc' }")
    expect(repoSrc).not.toMatch(/mjengoScore\.(update|delete|upsert)/)
  })
})

// ================================================================ migration

describe('Prisma migration is additive-only (existing rows untouched)', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/1_mjengo_score/migration.sql', import.meta.url)),
    'utf8',
  )
  // Comments stripped, statement list = SQL split on ';' (comment text can
  // legitimately say the word UPDATE; a mutation statement cannot).
  const body = sql.replace(/--[^\n]*/g, '')
  const statements = body.split(';').map((s) => s.trim()).filter(Boolean)

  it('is exactly one statement: CREATE TABLE "MjengoScore"', () => {
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE TABLE "MjengoScore" \(/)
  })

  it('starts no ALTER/DROP/INSERT/UPDATE/DELETE/REPLACE/INDEX/TRIGGER statement (existing rows untouched)', () => {
    const mutations = statements.filter((s) =>
      /^(ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|CREATE (INDEX|TRIGGER|VIEW))/i.test(s),
    )
    expect(mutations, `mutation statements found: ${mutations.join(' || ')}`).toEqual([])
    // the ONLY table the migration declares is MjengoScore (the FK target
    // "Project" is a reference, not a touch).
    expect(body.match(/CREATE TABLE/g)).toHaveLength(1)
  })

  it('the SQL columns match the Prisma model fields, score nullable', () => {
    for (const col of ['id', 'projectId', 'computedAt', 'score', 'confidence', 'components', 'notes', 'ruleVersion']) {
      expect(sql).toContain(`"${col}"`)
    }
    const scoreLine = sql.split('\n').find((l) => l.includes('"score"'))!
    expect(scoreLine).not.toContain('NOT NULL')
    // schema.prisma declares the same model
    const schema = readFileSync(fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)), 'utf8')
    expect(schema).toContain('model MjengoScore')
    expect(schema).toMatch(/score\s+Int\?/)
  })
})

// ================================================================ i18n

describe('en/sw dictionaries ship the score keys', () => {
  const enKeys = Object.keys(enDict)
  const swKeys = Object.keys(swDict)

  it('every score.* key exists in BOTH dictionaries with non-empty values', () => {
    const enScore = enKeys.filter((k) => k.startsWith('score.'))
    const swScore = swKeys.filter((k) => k.startsWith('score.'))
    expect(new Set(enScore)).toEqual(new Set(swScore))
    expect(enScore.length).toBeGreaterThanOrEqual(30)
    for (const k of enScore) {
      expect(enDict[k as keyof typeof enDict].trim().length).toBeGreaterThan(0)
      expect(swDict[k as keyof typeof swDict].trim().length).toBeGreaterThan(0)
    }
  })

  it('every t("score.…") literal in the section resolves in both dictionaries', () => {
    const sectionSrc = readFileSync(
      fileURLToPath(new URL('../../src/frontend/mjengo/intel/sections/score-section.tsx', import.meta.url)),
      'utf8',
    )
    const literals = [...sectionSrc.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]).filter((k) => k.startsWith('score.'))
    expect(literals.length).toBeGreaterThan(15) // the regex actually found keys
    for (const key of new Set(literals)) {
      expect(enKeys, `en.ts missing "${key}"`).toContain(key)
      expect(swKeys, `sw.ts missing "${key}"`).toContain(key)
    }
  })

  it('all six component keys exist for the dynamic t(`score.comp.${key}`) lookups', () => {
    for (const key of Object.keys(SCORE_WEIGHTS) as ScoreComponentKey[]) {
      expect(enKeys).toContain(`score.comp.${key}`)
      expect(swKeys).toContain(`score.comp.${key}`)
    }
  })
})
