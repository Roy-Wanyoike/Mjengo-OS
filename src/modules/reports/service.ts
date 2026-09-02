import { db } from '@/lib/db'
import { overallProgress } from '@/lib/mjengo'
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
// HONEST DERIVATION NOTE — PER-PHASE SPENT IS AN ALLOCATION, NOT A
// MEASUREMENT. The Transaction model has NO phaseId (checked: id, projectId,
// type, amount, method, reference, costCode, ledgerTxnId, note, date) — the
// ledger simply does not record which phase a cost belongs to. Attributing
// every shilling to a phase would therefore fabricate precision. What this
// report does instead:
//   1. EXACT where the schema allows it: transactions paid against a
//      milestone (PaymentRequest with relatedEntityType 'milestone' +
//      paidTxnId, whose milestone carries a phaseId) are attributed to that
//      phase — the one phase-attributed money flow that exists.
//   2. ALLOCATION for the rest: unattributed transactions are assigned to
//      STARTED phases (status !== 'pending' or progressPct > 0; fallback:
//      all phases) greedily toward each phase's budget-share target, in date
//      order. Deterministic, and total-preserving: Σ phase.spent always
//      equals the project's flat spent (the mjengo derivation above) — rows
//      never overlap and no shilling is invented or lost. Treat per-phase
//      numbers as a budget-share estimate until phase cost-codes land in the
//      schema (migration trigger noted in ARCHITECTURE.md's roadmap).
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
  topTransactions: BudgetVarianceTopTransaction[]
}

export interface BudgetVarianceCategory {
  key: string
  label: string
  spent: number
  txCount: number
  share: number // % of total spent, rounded
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

  // ---- step 1: EXACT milestone attribution (PaymentRequest → Milestone → Phase)
  const phaseByMilestone = new Map(milestones.map((m) => [m.id, m.phaseId]))
  const phaseIdByTxnId = new Map<string, string>()
  for (const pr of paymentRequests) {
    const phaseId = pr.relatedEntityId ? phaseByMilestone.get(pr.relatedEntityId) : undefined
    if (phaseId && pr.paidTxnId) phaseIdByTxnId.set(pr.paidTxnId, phaseId)
  }

  // ---- step 2: allocate unattributed transactions across started phases ----
  // Every unattributed txn is assigned to exactly ONE phase, greedily to the
  // phase furthest BELOW its budget-share target (min deficit, ties keep
  // phase order) — Σ phase.spent == project spent, always.
  const assigned = new Map<string, Transaction[]>(phases.map((f) => [f.id, []]))
  const assignedTotal = new Map<string, number>(phases.map((f) => [f.id, 0]))

  let started = phases.filter((f) => f.status !== 'pending' || phaseProgress(f) > 0)
  if (started.length === 0) started = phases // spend recorded before any phase started
  const startedBudget = started.reduce((s, f) => s + f.budget, 0)
  const exactTotal = transactions
    .filter((t) => phaseIdByTxnId.has(t.id))
    .reduce((s, t) => s + t.amount, 0)
  const pool = spent - exactTotal // unattributed total to spread across started phases
  const target = new Map<string, number>(
    started.map((f) => [f.id, startedBudget ? (f.budget / startedBudget) * pool : 0]),
  )

  for (const t of transactions) {
    const exact = phaseIdByTxnId.get(t.id)
    if (exact) {
      assigned.get(exact)?.push(t)
      assignedTotal.set(exact, (assignedTotal.get(exact) ?? 0) + t.amount)
      continue
    }
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
  }
}
