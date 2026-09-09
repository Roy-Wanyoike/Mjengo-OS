/**
 * Budget Variance report invariants (issue #44 core-module test gap) —
 * src/backend/modules/reports/service.ts + the procurement CSV row content
 * from src/frontend/mjengo/report-utils.ts (the report family the delivery-
 * photos evidence links feed).
 *
 * The reports service is the money-adjacent QS surface ("BOQ / Cost Plan /
 * Variations / Actual Cost / Forecast / Budget Variance"). Pinned here:
 *   · PROJECT ROLLUP — budgetTotal = Σ Phase.budget, spent = Σ
 *     Transaction.amount, remaining = budgetTotal − spent, spentPct rounded;
 *     progressPct is lib/mjengo's budget-weighted overallProgress (never a
 *     second formula); unknown project → null (the route's 404 contract).
 *   · THE DOCUMENTED ESTIMATE PATH — Transaction has no phaseId, so per-phase
 *     spent is an ALLOCATION: exact milestone-paid txns (PaymentRequest →
 *     Milestone → Phase, paidTxnId set) land on their phase even when that
 *     phase is pending; everything else is spread ONLY across STARTED phases
 *     (status !== 'pending' OR progress > 0; all-pending fallback = every
 *     phase) greedily toward budget-share targets, date order, earliest phase
 *     on ties. Σ phase.spent == project spent whenever ≥1 phase exists.
 *   · VARIANCE MATH — variance = budget − spent (positive = under budget),
 *     variancePct rounded, budget 0 → 0; topTransactions = top-5 by amount
 *     with note '' fallback and ISO dates; progressPct per phase honors
 *     progressManual over the task average.
 *   · CATEGORIES — the honest type rollup: grouped by Transaction.type with
 *     friendly labels (raw key passthrough for unknown types), share rounded,
 *     sorted by spent desc with a key tie-break.
 *   · PROCUREMENT CSV — discrepancy rows (short lines OR a discrepancy-status
 *     delivery), line names resolved from the PO lines, and the EVIDENCE
 *     PHOTO column counting line-scoped DeliveryPhoto links only (whole-
 *     delivery photos never pad a line's evidence).
 *
 * @/backend/lib/db is swapped for an in-memory stub (the delivery-photos /
 * outbox-versions pattern); overallProgress runs REAL (its own file pins the
 * payload math — here we pin that the report reuses it, not reinvents it).
 */
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
    paymentRequests: new Map<string, Row>(),
    /** Fresh row id — exposed on __state so fixtures can build deterministic rows. */
    _id(prefix: string) {
      return `${prefix}_${++state.seq}`
    },
    reset() {
      state.seq = 0
      for (const m of [state.projects, state.phases, state.tasks, state.transactions, state.milestones, state.paymentRequests]) m.clear()
    },
  }

  /** Just enough of Prisma's where: equality, { not: null }, { in: [...] }. */
  function matches(row: Row, where: Row = {}): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>
        if ('not' in c) {
          if (row[key] === (c.not as unknown)) return false
          continue
        }
        if ('in' in c) {
          if (!(c.in as unknown[]).includes(row[key])) return false
          continue
        }
      }
      if (row[key] !== cond) return false
    }
    return true
  }

  /** Single-field orderBy support ({ field: 'asc' | 'desc' }). */
  function sorted(rows: Row[], orderBy?: Row): Row[] {
    if (!orderBy) return rows
    const [[field, dir]] = Object.entries(orderBy)
    const sign = dir === 'desc' ? -1 : 1
    return [...rows].sort((a, b) => sign * String(a[field]).localeCompare(String(b[field]), 'en', { numeric: true }))
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
        const rows = sorted([...state.phases.values()].filter((r) => matches(r, where)), orderBy)
        return rows.map((p) => ({
          ...p,
          ...(include?.tasks ? { tasks: [...state.tasks.values()].filter((t) => t.phaseId === p.id).map((t) => ({ ...t })) } : {}),
        }))
      },
    },
    transaction: {
      async findMany({ where, orderBy }: { where: Row; orderBy?: Row }) {
        return sorted([...state.transactions.values()].filter((r) => matches(r, where)), orderBy).map((t) => ({ ...t }))
      },
    },
    milestone: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        const rows = [...state.milestones.values()].filter((r) => matches(r, where)).map((m) => ({ ...m }))
        if (!select) return rows
        return rows.map((m) => {
          const out: Row = {}
          for (const key of Object.keys(select)) out[key] = m[key]
          return out
        })
      },
    },
    paymentRequest: {
      async findMany({ where, select }: { where: Row; select?: Row }) {
        const rows = [...state.paymentRequests.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }))
        if (!select) return rows
        return rows.map((r) => {
          const out: Row = {}
          for (const key of Object.keys(select)) out[key] = r[key]
          return out
        })
      },
    },
  }
  return { db }
})

import { db } from '@/backend/lib/db'
import { buildBudgetVarianceReport } from '@/backend/modules/reports/service'
import { buildProcurementReportCSV } from '@/frontend/mjengo/report-utils'
import type { ProjectPayload } from '@/backend/lib/mjengo'

const state = (db as unknown as { __state: {
  projects: Map<string, Record<string, unknown>>
  phases: Map<string, Record<string, unknown>>
  tasks: Map<string, Record<string, unknown>>
  transactions: Map<string, Record<string, unknown>>
  milestones: Map<string, Record<string, unknown>>
  paymentRequests: Map<string, Record<string, unknown>>
  reset: () => void
  _id: (prefix: string) => string
} }).__state
const P1 = 'proj-1'

// ---------------- fixtures ----------------

function seedProject(id = P1, name = 'Riverside Villas') {
  state.projects.set(id, {
    id, name, client: 'Mama Njeri', clientType: 'diaspora', location: 'Karen',
    budget: 0, status: 'active', shareToken: 'tok-1',
    startDate: new Date('2026-01-05T09:00:00Z'), targetDate: new Date('2026-08-01T09:00:00Z'),
    createdAt: new Date('2026-01-05T09:00:00Z'), updatedAt: new Date('2026-01-05T09:00:00Z'),
  })
}

function phase(over: Record<string, unknown> = {}) {
  return {
    id: state._id('f'), projectId: P1, name: 'Phase', order: 0, budget: 0,
    status: 'pending', progressManual: null,
    createdAt: new Date('2026-01-06T09:00:00Z'), updatedAt: new Date('2026-01-06T09:00:00Z'),
    ...over,
  }
}

function task(phaseId: string, progress: number) {
  const row = {
    id: state._id('task'), phaseId, title: 'Task', status: 'pending', progress,
    createdAt: new Date('2026-01-07T09:00:00Z'), updatedAt: new Date('2026-01-07T09:00:00Z'),
  }
  state.tasks.set(row.id, row)
  return row
}

function txn(over: Record<string, unknown> = {}) {
  const row = {
    id: state._id('t'), projectId: P1, type: 'other', amount: 0, method: 'mpesa',
    reference: null, costCode: null, ledgerTxnId: null, note: null,
    date: new Date('2026-02-01T10:00:00Z'), createdAt: new Date('2026-02-01T10:00:00Z'),
    ...over,
  }
  state.transactions.set(row.id, row)
  return row
}

function milestone(over: Record<string, unknown> = {}) {
  const row = { id: state._id('m'), projectId: P1, phaseId: null, ...over }
  state.milestones.set(row.id, row)
  return row
}

function pr(over: Record<string, unknown> = {}) {
  const row = {
    id: state._id('pr'), projectId: P1, relatedEntityType: 'milestone',
    relatedEntityId: null, paidTxnId: null, status: 'paid',
    ...over,
  }
  state.paymentRequests.set(row.id, row)
  return row
}

/** Fixture A: 3 phases (2 started), 3 unattributed txns — the canonical allocation walk. */
function seedAllocationFixture() {
  seedProject()
  state.phases.set('f1', phase({ id: 'f1', name: 'Foundation', order: 1, budget: 300_000, status: 'in_progress', progressManual: 50 }))
  state.phases.set('f2', phase({ id: 'f2', name: 'Walls', order: 2, budget: 100_000, status: 'pending', progressManual: null }))
  state.phases.set('f3', phase({ id: 'f3', name: 'Roof', order: 3, budget: 100_000, status: 'pending', progressManual: 25 }))
  txn({ id: 't-mat', type: 'material', amount: 100_000, date: new Date('2026-02-01T10:00:00Z'), note: 'Cement 100 bags' })
  txn({ id: 't-wage', type: 'wage', amount: 100_000, date: new Date('2026-02-02T10:00:00Z'), note: 'Week 5 wages' })
  txn({ id: 't-tra', type: 'transport', amount: 50_000, date: new Date('2026-02-03T10:00:00Z'), note: 'Ballast haulage' })
}

beforeEach(() => {
  state.reset()
})

// ---------------- project rollup ----------------

describe('project rollup — the mjengo derivations, reused not reinvented', () => {
  it('budgetTotal = Σ Phase.budget, spent = Σ Transaction.amount, remaining = budget − spent', async () => {
    seedAllocationFixture()
    const report = await buildBudgetVarianceReport(P1)
    expect(report).not.toBeNull()
    expect(report!.project).toEqual({
      id: P1,
      name: 'Riverside Villas',
      budgetTotal: 500_000,
      spent: 250_000,
      remaining: 250_000,
      spentPct: 50,
      progressPct: 35, // budget-weighted: (50%×300k + 25%×100k) / 500k
    })
  })

  it('spentPct rounds (250k/300k → 83); a zero-budget project reports 0, never NaN', async () => {
    seedProject()
    state.phases.set('f1', phase({ id: 'f1', budget: 300_000, status: 'in_progress', progressManual: 10 }))
    txn({ amount: 250_000 })
    const r = await buildBudgetVarianceReport(P1)
    expect(r!.project.spentPct).toBe(83)

    state.reset()
    seedProject()
    state.phases.set('f0', phase({ id: 'f0', budget: 0, status: 'in_progress', progressManual: 10 }))
    txn({ amount: 5_000 })
    const zero = await buildBudgetVarianceReport(P1)
    expect(zero!.project.budgetTotal).toBe(0)
    expect(zero!.project.spentPct).toBe(0)
    expect(zero!.project.remaining).toBe(-5_000) // spent beyond a zero budget is visible, not hidden
  })

  it('progressPct is overallProgress (budget-weighted, progressManual wins) — 0 when no budget at all', async () => {
    seedProject()
    state.phases.set('fa', phase({ id: 'fa', name: 'A', order: 1, budget: 200_000, status: 'in_progress', progressManual: 50 }))
    state.phases.set('fb', phase({ id: 'fb', name: 'B', order: 2, budget: 100_000, status: 'in_progress' }))
    task('fb', 20)
    task('fb', 60)
    const r = await buildBudgetVarianceReport(P1)
    expect(r!.project.progressPct).toBe(47) // (50%×200k + 40%×100k) / 300k = 46.67 → 47
    expect(r!.phases.find((f) => f.id === 'fb')!.progressPct).toBe(40) // task average, rounded

    state.reset()
    seedProject()
    state.phases.set('fp', phase({ id: 'fp', budget: 0, status: 'in_progress', progressManual: 80 }))
    const noBudget = await buildBudgetVarianceReport(P1)
    expect(noBudget!.project.progressPct).toBe(0)
  })

  it('unknown project → null (the route answers 404 on exactly this)', async () => {
    seedAllocationFixture()
    expect(await buildBudgetVarianceReport('proj-missing')).toBeNull()
  })
})

// ---------------- the documented estimate path ----------------

describe('phase budget-share allocation — the documented estimate path', () => {
  it('greedy budget-share walk in date order: Σ phase.spent == project spent, rows never overlap', async () => {
    seedAllocationFixture()
    const r = await buildBudgetVarianceReport(P1)

    // started = {f1, f3} (f2 pending, 0 progress) → targets f1 187.5k / f3 62.5k:
    // t-mat → f1 (largest target), t-wage → f1, t-tra → f3 (f1 now above target).
    const byId = new Map(r!.phases.map((f) => [f.id, f]))
    expect(byId.get('f1')).toMatchObject({ budget: 300_000, spent: 200_000, variance: 100_000, variancePct: 33, progressPct: 50, txCount: 2 })
    expect(byId.get('f2')).toMatchObject({ budget: 100_000, spent: 0, variance: 100_000, variancePct: 100, txCount: 0, topTransactions: [] })
    expect(byId.get('f3')).toMatchObject({ budget: 100_000, spent: 50_000, variance: 50_000, variancePct: 50, progressPct: 25, txCount: 1 })
    expect(r!.phases.reduce((s, f) => s + f.spent, 0)).toBe(r!.project.spent) // total-preserving
  })

  it('a pending phase with zero progress receives NO allocation (the honest split)', async () => {
    seedAllocationFixture()
    const r = await buildBudgetVarianceReport(P1)
    const walls = r!.phases.find((f) => f.id === 'f2')!
    expect(walls.spent).toBe(0)
    expect(walls.txCount).toBe(0)
  })

  it('all-pending project falls back to every phase, ties keep the EARLIEST phase (deterministic)', async () => {
    seedProject()
    state.phases.set('fp', phase({ id: 'fp', name: 'P', order: 1, budget: 50_000, status: 'pending', progressManual: null }))
    state.phases.set('fq', phase({ id: 'fq', name: 'Q', order: 2, budget: 150_000, status: 'pending', progressManual: null }))
    txn({ id: 'x1', amount: 30_000, date: new Date('2026-02-01T10:00:00Z') }) // spend recorded before any phase started
    txn({ id: 'x2', amount: 30_000, date: new Date('2026-02-02T10:00:00Z') })
    const r = await buildBudgetVarianceReport(P1)
    const byId = new Map(r!.phases.map((f) => [f.id, f]))
    // x1 → fq (bigger share target 45k vs 15k); then both deficits tie at −15k → x2 → fp (earliest).
    expect(byId.get('fp')!.spent).toBe(30_000)
    expect(byId.get('fq')!.spent).toBe(30_000)
    expect(r!.project.spent).toBe(60_000)
  })

  it('phases come back in contract order (order asc), budget-first field contract intact', async () => {
    seedAllocationFixture()
    const r = await buildBudgetVarianceReport(P1)
    expect(r!.phases.map((f) => f.id)).toEqual(['f1', 'f2', 'f3'])
    expect(Object.keys(r!.phases[0])).toEqual([
      'id', 'name', 'budget', 'spent', 'variance', 'variancePct', 'progressPct', 'txCount', 'topTransactions',
    ])
  })
})

describe('exact milestone attribution — the one phase-attributed money flow', () => {
  function seedExactFixture(milestonePhaseId: string | null, relatedEntityId: string | null = 'm1') {
    seedProject()
    state.phases.set('fa', phase({ id: 'fa', name: 'Foundation', order: 1, budget: 200_000, status: 'pending', progressManual: null }))
    state.phases.set('fb', phase({ id: 'fb', name: 'Frame', order: 2, budget: 100_000, status: 'in_progress' }))
    task('fb', 40)
    task('fb', 60)
    milestone({ id: 'm1', phaseId: milestonePhaseId })
    pr({ relatedEntityId, paidTxnId: 'tm' })
    txn({ id: 'tm', type: 'milestone', amount: 80_000, note: 'Milestone release' })
    txn({ id: 'tu', type: 'other', amount: 20_000, note: 'Site expenses' })
  }

  it('a milestone-paid txn lands on its phase EXACTLY — even when that phase is pending', async () => {
    seedExactFixture('fa')
    const r = await buildBudgetVarianceReport(P1)
    const byId = new Map(r!.phases.map((f) => [f.id, f]))
    expect(byId.get('fa')).toMatchObject({ spent: 80_000, txCount: 1, variance: 120_000, variancePct: 60, progressPct: 0 })
    expect(byId.get('fb')).toMatchObject({ spent: 20_000, txCount: 1, variance: 80_000, variancePct: 80, progressPct: 50 })
    // the unattributed pool excludes the exact txn: fb's target is 20k, not 100k
    expect(r!.phases.reduce((s, f) => s + f.spent, 0)).toBe(100_000)
  })

  it('a milestone with NO phaseId is not exact — its payment flows into the estimate pool', async () => {
    seedExactFixture(null)
    const r = await buildBudgetVarianceReport(P1)
    const byId = new Map(r!.phases.map((f) => [f.id, f]))
    expect(byId.get('fa')!.spent).toBe(0) // pending, nothing exact lands there now
    expect(byId.get('fb')!.spent).toBe(100_000) // 80k allocated + 20k allocated
    expect(r!.phases.reduce((s, f) => s + f.spent, 0)).toBe(100_000)
  })

  it('a payment request whose milestone is unknown is estimated, not exact', async () => {
    seedExactFixture('fa', 'm-unknown')
    const r = await buildBudgetVarianceReport(P1)
    const byId = new Map(r!.phases.map((f) => [f.id, f]))
    expect(byId.get('fa')!.spent).toBe(0)
    expect(byId.get('fb')!.spent).toBe(100_000)
  })

  it('only milestone-type payment requests are consulted (the query filters before attribution)', async () => {
    seedExactFixture('fa')
    state.paymentRequests.get([...state.paymentRequests.keys()][0])!.relatedEntityType = 'purchase_order'
    const r = await buildBudgetVarianceReport(P1)
    const byId = new Map(r!.phases.map((f) => [f.id, f]))
    expect(byId.get('fa')!.spent).toBe(0) // not exact — PR filtered out of the read
    expect(byId.get('fb')!.spent).toBe(100_000)
  })
})

// ---------------- variance rows + top transactions ----------------

describe('per-phase rows — variance, progress and top transactions', () => {
  it('topTransactions: top-5 by amount desc, note null → "", ISO dates', async () => {
    seedProject()
    state.phases.set('f1', phase({ id: 'f1', budget: 1_000_000, status: 'in_progress', progressManual: 40 }))
    const amounts = [10_000, 90_000, 50_000, 70_000, 30_000, 60_000]
    amounts.forEach((amount, i) => {
      txn({ id: `tx${i}`, amount, note: i % 2 === 0 ? `Note ${i}` : null, date: new Date(`2026-02-0${i + 1}T10:00:00Z`) })
    })
    const r = await buildBudgetVarianceReport(P1)
    const f1 = r!.phases[0]
    expect(f1.txCount).toBe(6)
    expect(f1.topTransactions).toHaveLength(5) // capped
    expect(f1.topTransactions.map((t) => t.amount)).toEqual([90_000, 70_000, 60_000, 50_000, 30_000])
    expect(f1.topTransactions.find((t) => t.amount === 10_000)).toBeUndefined() // smallest dropped
    const noNote = f1.topTransactions.find((t) => t.id === 'tx1')! // 90_000, note null
    expect(noNote.note).toBe('')
    expect(noNote.date).toBe('2026-02-02T10:00:00.000Z')
    const withNote = f1.topTransactions.find((t) => t.id === 'tx2')! // 50_000, note kept verbatim
    expect(withNote.note).toBe('Note 2')
  })

  it('variancePct: budget 0 → 0 (no divide-by-zero noise), otherwise rounded', async () => {
    seedProject()
    state.phases.set('f1', phase({ id: 'f1', budget: 0, status: 'in_progress', progressManual: 10 }))
    state.phases.set('f2', phase({ id: 'f2', budget: 30_000, status: 'in_progress', progressManual: 10 }))
    txn({ amount: 10_000 })
    const r = await buildBudgetVarianceReport(P1)
    const byId = new Map(r!.phases.map((f) => [f.id, f]))
    expect(byId.get('f1')!.variancePct).toBe(0) // zero budget — honest 0
    expect(byId.get('f2')!.variance).toBe(20_000)
    expect(byId.get('f2')!.variancePct).toBe(67) // 20k/30k = 66.67 → 67
  })

  it('a project with transactions but NO phases keeps the flat spend and emits no phase rows', async () => {
    seedProject()
    txn({ amount: 10_000 })
    txn({ amount: 20_000 })
    const r = await buildBudgetVarianceReport(P1)
    expect(r!.phases).toEqual([])
    expect(r!.project.spent).toBe(30_000)
    expect(r!.project.budgetTotal).toBe(0)
    expect(r!.categories).toHaveLength(1) // the type rollup still works — it is phase-independent
  })
})

// ---------------- categories ----------------

describe('categories — the honest Transaction.type rollup', () => {
  it('groups by type with friendly labels, txCounts and rounded shares, spent-desc + key tie-break order', async () => {
    seedAllocationFixture()
    const r = await buildBudgetVarianceReport(P1)
    expect(r!.categories).toEqual([
      { key: 'material', label: 'Materials', spent: 100_000, txCount: 1, share: 40 },
      { key: 'wage', label: 'Wages', spent: 100_000, txCount: 1, share: 40 },
      { key: 'transport', label: 'Transport', spent: 50_000, txCount: 1, share: 20 },
    ])
  })

  it('an unknown type keeps its raw key as the label; shares round; no txns → no categories', async () => {
    seedProject()
    state.phases.set('f1', phase({ id: 'f1', budget: 100, status: 'in_progress', progressManual: 10 }))
    txn({ type: 'custom_kind', amount: 2 })
    txn({ type: 'material', amount: 1 })
    const r = await buildBudgetVarianceReport(P1)
    expect(r!.categories).toEqual([
      { key: 'custom_kind', label: 'custom_kind', spent: 2, txCount: 1, share: 67 },
      { key: 'material', label: 'Materials', spent: 1, txCount: 1, share: 33 },
    ])

    state.reset()
    seedProject()
    state.phases.set('f1', phase({ id: 'f1', budget: 100, status: 'in_progress', progressManual: 10 }))
    const empty = await buildBudgetVarianceReport(P1)
    expect(empty!.categories).toEqual([])
  })

  it('every documented type label maps (material/wage/transport/other/invoice/milestone/payment_request)', async () => {
    seedProject()
    state.phases.set('f1', phase({ id: 'f1', budget: 1_000_000, status: 'in_progress', progressManual: 10 }))
    for (const type of ['material', 'wage', 'transport', 'other', 'invoice', 'milestone', 'payment_request']) {
      txn({ type, amount: 1 })
    }
    const r = await buildBudgetVarianceReport(P1)
    const labels = new Map(r!.categories.map((c) => [c.key, c.label]))
    expect(labels.get('material')).toBe('Materials')
    expect(labels.get('wage')).toBe('Wages')
    expect(labels.get('transport')).toBe('Transport')
    expect(labels.get('other')).toBe('Other')
    expect(labels.get('invoice')).toBe('Invoices')
    expect(labels.get('milestone')).toBe('Milestone payments')
    expect(labels.get('payment_request')).toBe('Payment requests')
    expect(r!.categories.every((c) => c.share === 14 || c.share === 15)).toBe(true) // 1/7 each rounds to 14/15
  })
})

// ---------------- procurement report CSV ----------------

/**
 * Minimal ProjectPayload for buildProcurementReportCSV (title/project/summary/
 * supply only — the builder touches nothing else). Cells come back from the
 * RFC-4180 serializer fully quoted, so split accordingly.
 */
function procurementPayload(orders: unknown[], requests: unknown[]): ProjectPayload {
  return {
    project: { name: 'Riverside Villas', client: 'Mama Njeri', location: 'Karen' },
    summary: { dayCount: 12 },
    supply: { requests, orders },
  } as unknown as ProjectPayload
}

const csvRows = (csv: string): string[][] =>
  csv.split('\r\n').map((line) => line.slice(1, -1).split('","'))

function discrepancyRows(csv: string): string[][] {
  const rows = csvRows(csv)
  const start = rows.findIndex((r) => r[0] === 'DELIVERY DISCREPANCIES (received vs ordered)') + 2
  const end = rows.findIndex((r, i) => i >= start && r[0].startsWith('('))
  return rows.slice(start, end === -1 ? rows.length : end)
}

describe('procurement report CSV — discrepancy rows count evidence per line', () => {
  it('short lines emit rows with ordered/received/short and line-scoped photo evidence', () => {
    const csv = buildProcurementReportCSV(procurementPayload(
      [{
        orderCode: 'PO-2026-000101', supplierName: 'Kisumu Builders', status: 'delivering',
        subtotal: 1000.4, deliveryFee: 99.6, total: 1100.0,
        lines: [{ id: 'pl_1', name: 'Cement' }, { id: 'pl_2', name: 'Ballast' }],
        deliveries: [{
          status: 'received',
          lines: [
            { id: 'dl_1', orderLineId: 'pl_1', qtyOrdered: 100, qtyReceived: 96 },
            { id: 'dl_2', orderLineId: 'pl_2', qtyOrdered: 20, qtyReceived: 20 },
          ],
          photos: [
            { deliveryLineId: 'dl_1' }, { deliveryLineId: 'dl_1' }, { deliveryLineId: null },
          ],
        }],
      }],
      [],
    ))
    const rows = discrepancyRows(csv)
    expect(rows).toEqual([
      ['PO-2026-000101', 'Cement', '100', '96', '4', '2 photos', '', ''], // whole-delivery photo NOT counted
    ])
  })

  it('a discrepancy-STATUS delivery lists every line (even at full qty) — Short 0 is honest, singular "1 photo"', () => {
    const csv = buildProcurementReportCSV(procurementPayload(
      [{
        orderCode: 'PO-2026-000102', supplierName: 'Acme', status: 'received',
        subtotal: 0, deliveryFee: 0, total: 0,
        lines: [{ id: 'pl_9', name: 'Nails' }],
        deliveries: [{
          status: 'discrepancy',
          lines: [{ id: 'dl_9', orderLineId: 'pl_9', qtyOrdered: 20, qtyReceived: 20 }],
          photos: [{ deliveryLineId: 'dl_9' }],
        }],
      }],
      [],
    ))
    expect(discrepancyRows(csv)).toEqual([
      ['PO-2026-000102', 'Nails', '20', '20', '0', '1 photo', '', ''],
    ])
  })

  it('an unmatched orderLineId falls back to "line <id>"; zero line-scoped photos → empty evidence cell', () => {
    const csv = buildProcurementReportCSV(procurementPayload(
      [{
        orderCode: 'PO-2026-000103', supplierName: 'Acme', status: 'received',
        subtotal: 0, deliveryFee: 0, total: 0,
        lines: [],
        deliveries: [{
          status: 'received',
          lines: [{ id: 'dl_7', orderLineId: 'pl_ghost', qtyOrdered: 10, qtyReceived: 9 }],
          photos: [{ deliveryLineId: null }],
        }],
      }],
      [],
    ))
    expect(discrepancyRows(csv)).toEqual([
      ['PO-2026-000103', 'line pl_ghost', '10', '9', '1', '', '', ''],
    ])
  })

  it('clean deliveries emit the honest "(no delivery discrepancies on record)" row', () => {
    const csv = buildProcurementReportCSV(procurementPayload(
      [{
        orderCode: 'PO-2026-000104', supplierName: 'Acme', status: 'received',
        subtotal: 0, deliveryFee: 0, total: 0,
        lines: [{ id: 'pl_1', name: 'Cement' }],
        deliveries: [{
          status: 'received',
          lines: [{ id: 'dl_1', orderLineId: 'pl_1', qtyOrdered: 5, qtyReceived: 5 }],
          photos: [],
        }],
      }],
      [],
    ))
    const rows = csvRows(csv)
    expect(rows.some((r) => r[0] === '(no delivery discrepancies on record)')).toBe(true)
  })

  it('header + requests + PO sections carry the real row content (rounded KES, ISO dates)', () => {
    const csv = buildProcurementReportCSV(procurementPayload(
      [{
        orderCode: 'PO-2026-000101', supplierName: 'Kisumu Builders', status: 'delivering',
        subtotal: 1000.4, deliveryFee: 99.6, total: 1100.0, lines: [], deliveries: [],
      }],
      [{
        requestCode: 'MR-2026-000001', status: 'approved',
        lines: [{}, {}], createdAt: '2026-02-01T09:30:00Z',
      }],
    ))
    const rows = csvRows(csv)
    expect(rows[0][0]).toBe('MjengoOS — Procurement Report')
    expect(rows[1]).toEqual(['Project: Riverside Villas', 'Client: Mama Njeri', 'Location: Karen', '', '', '', '', ''])
    expect(rows[2][0]).toContain('Generated:')
    expect(rows[2][0]).toContain('from live project data (day 12)')
    expect(rows).toContainEqual(['MR-2026-000001', 'approved', '2', '2026-02-01', '', '', '', ''])
    expect(rows).toContainEqual(['PO-2026-000101', 'Kisumu Builders', 'delivering', '1000', '100', '1100', '', ''])
  })
})
