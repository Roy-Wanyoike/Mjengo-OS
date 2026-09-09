import { db } from '@/backend/lib/db'
import { overallProgress } from '@/backend/lib/mjengo'
import type { Phase, Task, Transaction } from '@prisma/client'

// Budget Variance report service (QS surface: "BOQ / Cost Plan / Variations /
// Actual Cost / Forecast / Budget Variance", spec reporting section) — W3-B.
//
// PROJECT-LEVEL MATH — REUSED, NOT REINVENTED: budgetTotal = Σ Phase.budget
// and spent = Σ Transaction.amount are the exact derivations lib/mjengo.ts
// uses for ProjectSummary.budgetTotal/budgetSpent (and modules/wallet's
// loadFinanceSlice repeats); overallProgress() is imported straight from
// lib/mjengo.ts so the progressPct here can never disagree with the app
// payload. `remaining` = budgetTotal − spent (plain variance surface — the
// finance slice's `committed` dimension, POs + approved invoices + pending
// positive variations, is deliberately NOT folded in; that is the cash-flow
// surface, this is the budget-variance surface).
//
// HONEST DERIVATION NOTE — PER-PHASE SPEND: THREE ATTRIBUTION TIERS,
// STRICTLY BY PRECEDENCE (issue #39 — transaction phase cost-codes). The
// report states which mode produced the numbers via `phaseAttribution`
// (mode + the exact split), and Σ phase.spent always equals the project's
// flat spent (rows never overlap, no shilling is invented or lost):
//   1. REAL CODE — a Transaction carrying a phaseId cost-code (stamped at
//      posting by the seams that KNOW the phase: milestone releases,
//      milestone payment requests, payer-attributed invoice.pay, reversals
//      copying the original row) counts DIRECTLY to that phase. A code is
//      honored only when it references one of THIS project's phases (posting
//      seams validate in-project; the FK + SetNull guard dangling ids — a
//      foreign id cannot occur through the API and is treated as
//      unattributed if it ever does, never counted against a phantom phase).
//   2. LEGACY MILESTONE DERIVATION (exact, not a stored code) — pre-code rows
//      paid against a milestone (PaymentRequest with relatedEntityType
//      'milestone' + paidTxnId, whose milestone carries a phaseId) attribute
//      to that phase. Superseded by tier 1 when a row carries both.
//   3. BUDGET-SHARE ESTIMATE for the rest — uncoded rows are assigned to
//      STARTED phases (status !== 'pending' or progressPct > 0; fallback:
//      all phases) greedily toward each phase's budget-share target, in date
//      order. Deterministic and total-preserving. Treat the estimated
//      remainder as a budget-share estimate — it is an allocation, not a
//      measurement (wages and unattributed expenses carry no phase).
// MODE: 'real' when every row is coded · 'mixed' when part-coded (real-coded
// + estimated remainder) · 'estimated' when nothing is coded (tiers 2+3) ·
// 'none' when there is no spend. codedSpent + milestoneDerivedSpent +
// estimatedSpent == project.spent, and the three counts == every transaction.
//
// HONEST DERIVATION NOTE — CATEGORIES: the Transaction model has no
// `category` field either (costCode exists but is unpopulated across all
// current rows). Rather than guess from note keywords, categories group by
// the one real cost dimension the model carries: Transaction.type
// (material / wage / transport / other / invoice / milestone /
// payment_request). That grouping is what it is — a type rollup, not a
// QS work-section classification.

export interface BudgetVarianceTopTransaction {
  id: string
  note: string
  amount: number
  date: string // ISO
}

export interface BudgetVariancePhase {
  id: string
  name: string
  budget: number
  spent: number
  variance: number // budget − spent (positive = under budget)
  variancePct: number
  progressPct: number
  txCount: number
  /** Real-code portion of `spent` (rows carrying this phase's cost-code — issue #39); spent − codedSpent is the fallback attribution. */
  codedSpent: number
  codedTxnCount: number
  topTransactions: BudgetVarianceTopTransaction[]
}

export interface BudgetVarianceCategory {
  key: string
  label: string
  spent: number
  txCount: number
  share: number // % of total spent, rounded
}

/** Which attribution mode produced the per-phase numbers (issue #39). */
export interface BudgetVariancePhaseAttribution {
  /** 'none' (no spend) · 'real' (every row carries a phase cost-code) · 'mixed' (part coded, part fallback) · 'estimated' (nothing coded — tiers 2+3). */
  mode: 'none' | 'real' | 'mixed' | 'estimated'
  /** Σ amounts of rows attributed via a stored Transaction.phaseId (tier 1 — real codes). */
  codedSpent: number
  codedTxnCount: number
  /** Σ amounts of UNCoded rows attributed exactly via the legacy milestone derivation (tier 2). */
  milestoneDerivedSpent: number
  milestoneDerivedTxnCount: number
  /** Σ amounts of uncoded rows spread by the budget-share estimate (tier 3). */
  estimatedSpent: number
  estimatedTxnCount: number
}

export interface BudgetVarianceReport {
  project: {
    id: string
    name: string
    budgetTotal: number
    spent: number
    remaining: number
    spentPct: number
    progressPct: number
  }
  phases: BudgetVariancePhase[]
  categories: BudgetVarianceCategory[]
  /** Honest mode statement — codedSpent + milestoneDerivedSpent + estimatedSpent == project.spent (invariant). */
  phaseAttribution: BudgetVariancePhaseAttribution
}

/** Friendly labels for Transaction.type (fallback: the raw key itself). */
const TYPE_LABELS: Record<string, string> = {
  material: 'Materials',
  wage: 'Wages',
  transport: 'Transport',
  other: 'Other',
  invoice: 'Invoices',
  milestone: 'Milestone payments',
  payment_request: 'Payment requests',
}

/**
 * Per-phase progress — mirrors lib/mjengo.ts phaseProgress() 1:1 (that helper
 * is module-private there and cannot be imported; keep the two in sync):
 * progressManual wins when set, else the rounded average of task progress.
 */
function phaseProgress(p: Phase & { tasks: Task[] }): number {
  if (p.progressManual !== null && p.progressManual !== undefined) return p.progressManual
  if (!p.tasks.length) return 0
  return Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length)
}

const pct = (numerator: number, denominator: number): number =>
  denominator ? Math.round((numerator / denominator) * 100) : 0

/**
 * Build the budget variance report for one project.
 * Returns null when the project does not exist (route → 404).
 */
export async function buildBudgetVarianceReport(projectId: string): Promise<BudgetVarianceReport | null> {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) return null

  const [phases, transactions, milestones, paymentRequests] = await Promise.all([
    db.phase.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
      include: { tasks: true },
    }),
    db.transaction.findMany({ where: { projectId }, orderBy: { date: 'asc' } }),
    db.milestone.findMany({ where: { projectId }, select: { id: true, phaseId: true } }),
    db.paymentRequest.findMany({
      where: { projectId, relatedEntityType: 'milestone', paidTxnId: { not: null } },
      select: { relatedEntityId: true, paidTxnId: true },
    }),
  ])

  // ---- project rollup (same math as lib/mjengo.ts ProjectSummary) ----
  const budgetTotal = phases.reduce((s, f) => s + f.budget, 0)
  const spent = transactions.reduce((s, t) => s + t.amount, 0)

  // ---- step 1: REAL phase cost-codes (issue #39, tier 1) ----
  // A stored phaseId counts DIRECTLY, but only when it references one of
  // THIS project's phases — posting seams validate in-project, so a foreign
  // id cannot occur through the API; if one ever does it is treated as
  // unattributed (fallback), never counted against a phantom phase.
  const phaseIds = new Set(phases.map((f) => f.id))
  const codedPhase = (t: Transaction): string | null =>
    t.phaseId && phaseIds.has(t.phaseId) ? t.phaseId : null

  // ---- step 2: legacy milestone attribution (PaymentRequest → Milestone →
  // Phase, tier 2 — exact, for rows with NO stored code) ----
  const phaseByMilestone = new Map(milestones.map((m) => [m.id, m.phaseId]))
  const phaseIdByTxnId = new Map<string, string>()
  for (const pr of paymentRequests) {
    const phaseId = pr.relatedEntityId ? phaseByMilestone.get(pr.relatedEntityId) : undefined
    // phaseIds.has guards the Σ invariant: a milestone whose phaseId is not
    // one of this project's phases must not pull spend to a phantom phase.
    if (phaseId && phaseIds.has(phaseId) && pr.paidTxnId) phaseIdByTxnId.set(pr.paidTxnId, phaseId)
  }

  // ---- step 3: allocate uncoded transactions across started phases ----
  // Every uncoded, underived txn is assigned to exactly ONE phase, greedily
  // to the phase furthest BELOW its budget-share target (min deficit, ties
  // keep phase order) — Σ phase.spent == project spent, always.
  const assigned = new Map<string, Transaction[]>(phases.map((f) => [f.id, []]))
  const assignedTotal = new Map<string, number>(phases.map((f) => [f.id, 0]))
  const codedPerPhase = new Map<string, number>(phases.map((f) => [f.id, 0]))
  const codedCountPerPhase = new Map<string, number>(phases.map((f) => [f.id, 0]))
  let codedSpent = 0
  let codedTxnCount = 0
  let milestoneDerivedSpent = 0
  let milestoneDerivedTxnCount = 0
  let estimatedSpent = 0
  let estimatedTxnCount = 0

  let started = phases.filter((f) => f.status !== 'pending' || phaseProgress(f) > 0)
  if (started.length === 0) started = phases // spend recorded before any phase started
  const startedBudget = started.reduce((s, f) => s + f.budget, 0)
  // Directly attributed (coded or legacy-derived) spend leaves the estimate
  // pool — precedence: a stored code supersedes the milestone derivation.
  const exactTotal = transactions.reduce(
    (s, t) => s + (codedPhase(t) || phaseIdByTxnId.has(t.id) ? t.amount : 0),
    0,
  )
  const pool = spent - exactTotal // uncoded total to spread across started phases
  const target = new Map<string, number>(
    started.map((f) => [f.id, startedBudget ? (f.budget / startedBudget) * pool : 0]),
  )

  for (const t of transactions) {
    const coded = codedPhase(t)
    if (coded) {
      assigned.get(coded)?.push(t)
      assignedTotal.set(coded, (assignedTotal.get(coded) ?? 0) + t.amount)
      codedPerPhase.set(coded, (codedPerPhase.get(coded) ?? 0) + t.amount)
      codedCountPerPhase.set(coded, (codedCountPerPhase.get(coded) ?? 0) + 1)
      codedSpent += t.amount
      codedTxnCount += 1
      continue
    }
    const derived = phaseIdByTxnId.get(t.id)
    if (derived) {
      assigned.get(derived)?.push(t)
      assignedTotal.set(derived, (assignedTotal.get(derived) ?? 0) + t.amount)
      milestoneDerivedSpent += t.amount
      milestoneDerivedTxnCount += 1
      continue
    }
    estimatedSpent += t.amount
    estimatedTxnCount += 1
    if (started.length === 0) continue // project with no phases at all
    // Pick the started phase with the largest deficit (assigned − target);
    // strict < keeps the earliest phase on ties → deterministic output.
    let best = started[0]
    let bestDeficit = (assignedTotal.get(best.id) ?? 0) - (target.get(best.id) ?? 0)
    for (const f of started.slice(1)) {
      const deficit = (assignedTotal.get(f.id) ?? 0) - (target.get(f.id) ?? 0)
      if (deficit < bestDeficit) {
        best = f
        bestDeficit = deficit
      }
    }
    assigned.get(best.id)?.push(t)
    assignedTotal.set(best.id, (assignedTotal.get(best.id) ?? 0) + t.amount)
  }

  // ---- phase rows (contract order: budget, spent, variance, …) ----
  const phasesOut: BudgetVariancePhase[] = phases.map((f) => {
    const rows = assigned.get(f.id) ?? []
    const phaseSpent = rows.reduce((s, t) => s + t.amount, 0)
    const variance = f.budget - phaseSpent
    const top = [...rows]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map((t) => ({ id: t.id, note: t.note ?? '', amount: t.amount, date: t.date.toISOString() }))
    return {
      id: f.id,
      name: f.name,
      budget: f.budget,
      spent: phaseSpent,
      variance,
      variancePct: f.budget ? Math.round((variance / f.budget) * 100) : 0,
      progressPct: phaseProgress(f),
      txCount: rows.length,
      codedSpent: codedPerPhase.get(f.id) ?? 0,
      codedTxnCount: codedCountPerPhase.get(f.id) ?? 0,
      topTransactions: top,
    }
  })

  // ---- categories: group by Transaction.type (see honest note above) ----
  const byType = new Map<string, { spent: number; txCount: number }>()
  for (const t of transactions) {
    const g = byType.get(t.type) ?? { spent: 0, txCount: 0 }
    g.spent += t.amount
    g.txCount += 1
    byType.set(t.type, g)
  }
  const categories: BudgetVarianceCategory[] = [...byType.entries()]
    .map(([key, g]) => ({
      key,
      label: TYPE_LABELS[key] ?? key,
      spent: g.spent,
      txCount: g.txCount,
      share: pct(g.spent, spent),
    }))
    .sort((a, b) => b.spent - a.spent || a.key.localeCompare(b.key))

  // ---- honest mode statement (issue #39): which attribution produced the
  // numbers — codedSpent + milestoneDerivedSpent + estimatedSpent == spent.
  const uncodedTxnCount = milestoneDerivedTxnCount + estimatedTxnCount
  const mode: BudgetVariancePhaseAttribution['mode'] =
    transactions.length === 0
      ? 'none'
      : uncodedTxnCount === 0
        ? 'real'
        : codedTxnCount > 0
          ? 'mixed'
          : 'estimated'

  return {
    project: {
      id: project.id,
      name: project.name,
      budgetTotal,
      spent,
      remaining: budgetTotal - spent,
      spentPct: pct(spent, budgetTotal),
      progressPct: overallProgress(phases),
    },
    phases: phasesOut,
    categories,
    phaseAttribution: {
      mode,
      codedSpent,
      codedTxnCount,
      milestoneDerivedSpent,
      milestoneDerivedTxnCount,
      estimatedSpent,
      estimatedTxnCount,
    },
  }
}
