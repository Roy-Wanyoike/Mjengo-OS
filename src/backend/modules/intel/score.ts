// Intel module — the MjengoScore engine (PURE function, no DB).
//
// MjengoScore is the deterministic contractor trust score an embedded-finance
// underwriter can read: every component is traceable to real rows (evidence-
// backed releases, verified attendance, budget pace, variation discipline,
// delivery accuracy, invoice disputes). Same rows in → same number out.
//
// HONESTY RULES (non-negotiable, issue W3-3):
//   · the score GATES nothing and APPROVES nothing — it describes, humans
//     decide;
//   · it is a PROJECTION recomputed only on the explicit `score.recompute`
//     intel action, never a background magic number;
//   · a project with too little history gets `score: null` + an explanation
//     (never a fake 0 or 100);
//   · components with no source rows are null and simply drop out of the
//     weighted average (weights renormalize over what has data).
//
// Score rule version '1' — bump SCORE_RULE_VERSION when any threshold below
// changes so persisted history rows stay interpretable.

import { overallProgress, type RiskPhase } from './engine'

export const SCORE_RULE_VERSION = '1'

// ---------------- input shapes (plain rows, no DB) ----------------

/** One RELEASED milestone as the score engine sees it (evidence parsed by the service). */
export interface ScoreMilestone {
  id: string
  name: string
  /** Parsed length of Milestone.evidencePhotoIds (JSON array of SitePhoto ids). */
  evidencePhotoCount: number
}

/** One attendance row inside the trailing window (service scopes 30 days). */
export interface ScoreAttendance {
  verification: string // 'verified' | 'reported' | 'exception'
}

/** One variation order row. */
export interface ScoreVariation {
  title: string
  status: string // 'submitted' | 'approved' | 'rejected'
  budgetImpact: number // KES, + increase / − saving
}

/** One delivery row (R3 inputs). */
export interface ScoreDelivery {
  status: string // dispatched, in_transit, arrived, received, discrepancy
  lines: Array<{ qtyOrdered: number; qtyReceived: number }>
}

/** One invoice row. */
export interface ScoreInvoice {
  status: string // draft, submitted, approved, rejected, paid, disputed
}

export interface MjengoScoreInput {
  now: Date
  /** Milestones with status 'released' (evidence photo ids parsed to counts). */
  releasedMilestones: ScoreMilestone[]
  /** Attendance rows from the trailing 30-day window (service scopes the window). */
  attendances: ScoreAttendance[]
  /** Phases (with tasks) — R1 budget_pace + overall progress reuse. */
  phases: RiskPhase[]
  /** Transactions (spend) — R1 budget_pace reuse. */
  transactions: Array<{ amount: number }>
  /** Project.budget (KES) — the variation-impact denominator. */
  projectBudget: number
  /** Variation orders on the project. */
  variations: ScoreVariation[]
  /** Order deliveries with their lines — R3 discrepancy inputs. */
  deliveries: ScoreDelivery[]
  /** Invoices on the project. */
  invoices: ScoreInvoice[]
}

// ---------------- output shapes ----------------

export type ScoreConfidence = 'low' | 'medium' | 'high'

export type ScoreComponentKey =
  | 'evidence_backed_releases'
  | 'attendance_verification'
  | 'budget_discipline'
  | 'variation_discipline'
  | 'delivery_discrepancy'
  | 'invoice_disputes'

/** One scored component — persisted inside MjengoScore.components (JSON). */
export interface ScoreComponent {
  key: ScoreComponentKey
  label: string
  /** Max deduction this component can contribute (weights sum to 100). */
  weight: number
  /** 0-100 component health (100 = best) · null = no source rows yet (drops out). */
  value: number | null
  /** Points subtracted from 100 (≤ weight; null when value is null). */
  deduction: number | null
  /** The rows behind the number — always cites counts. */
  evidence: string
}

export interface MjengoScoreResult {
  /** 0-100 · null = honest low-confidence state (fewer than 2 components have data). */
  score: number | null
  confidence: ScoreConfidence
  components: ScoreComponent[]
  /** Explanation when score is null (which components still need rows). */
  notes: string | null
  ruleVersion: string
}

// ---------------- documented weights + thresholds ----------------

/**
 * Component weights (max deduction each). They sum to 100 so a project with
 * ALL components at their worst would score 0 — and every deduction is a
 * bounded, traceable share of the total.
 *   · evidence_backed_releases  20 — proof-of-work discipline at money release
 *   · budget_discipline         20 — R1 budget_pace gap (reused, not reinvented)
 *   · attendance_verification   15 — worker-side verified presence
 *   · variation_discipline      15 — approved budget movement vs project budget
 *   · delivery_discrepancy      15 — R3 discrepancy rate over landed deliveries
 *   · invoice_disputes          15 — share of invoices disputed by the client
 */
export const SCORE_WEIGHTS: Record<ScoreComponentKey, number> = {
  evidence_backed_releases: 20,
  budget_discipline: 20,
  attendance_verification: 15,
  variation_discipline: 15,
  delivery_discrepancy: 15,
  invoice_disputes: 15,
}

/**
 * Documented thresholds (each cited in the component evidence):
 *   · attendance window     = trailing 30 days (R5 risk rule uses 10; a trust
 *     score wants a month of habit, not a bad week)
 *   · budget lead cap       = 30 points of spend-ahead (the R1 CRITICAL line —
 *     reaching it deducts the full 20)
 *   · variation cap         = 15% of the project budget moved by APPROVED
 *     variation orders (research: variation orders drive 70–151% of Kenyan
 *     overruns — the bar is deliberately tight)
 *   · discrepancy cap       = 25% of landed deliveries closed discrepant
 *   · dispute cap           = 20% of invoices disputed
 *   · minimum components    = 2 non-null components before a score is quoted
 */
export const ATTENDANCE_WINDOW_DAYS = 30
export const BUDGET_LEAD_CAP_POINTS = 30
export const VARIATION_IMPACT_CAP_RATIO = 0.15
export const DELIVERY_DISCREPANCY_CAP_RATIO = 0.25
export const INVOICE_DISPUTE_CAP_RATIO = 0.2
export const MIN_COMPONENTS_FOR_SCORE = 2

/** Deliveries that have LANDED (evidence exists either way) — the honest denominator. */
export const LANDED_DELIVERY_STATUSES = ['received', 'discrepancy'] as const

function kes(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

function pct1(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

/** Linear deduction: badness ratio (already clamped 0–1) × the component weight. */
function linearDeduction(ratio: number, weight: number): number {
  return Math.round(Math.max(0, Math.min(1, ratio)) * weight * 10) / 10
}

// ---------------- the engine ----------------

/**
 * Compute the MjengoScore from real rows. Pure: no clock reads (now is an
 * input), no DB, no randomness — identical inputs produce an identical
 * result, component for component.
 */
export function computeMjengoScore(input: MjengoScoreInput): MjengoScoreResult {
  const { releasedMilestones, attendances, phases, transactions, projectBudget, variations, deliveries, invoices } = input
  const components: ScoreComponent[] = []

  // ---- 1 · evidence_backed_releases (weight 20) ----
  // Ratio of released milestones that carry ≥1 evidence photo. A release with
  // no photo is money moved on trust alone — the exact thing an underwriter
  // wants to count. No released milestones yet → null (nothing to measure).
  {
    const released = releasedMilestones.length
    if (released > 0) {
      const withEvidence = releasedMilestones.filter((m) => m.evidencePhotoCount > 0).length
      const ratio = withEvidence / released
      components.push({
        key: 'evidence_backed_releases',
        label: 'Evidence-backed releases',
        weight: SCORE_WEIGHTS.evidence_backed_releases,
        value: Math.round(ratio * 100),
        deduction: linearDeduction(1 - ratio, SCORE_WEIGHTS.evidence_backed_releases),
        evidence: `${withEvidence} of ${released} released milestones carry ≥1 evidence photo`,
      })
    } else {
      components.push({
        key: 'evidence_backed_releases', label: 'Evidence-backed releases',
        weight: SCORE_WEIGHTS.evidence_backed_releases, value: null, deduction: null,
        evidence: 'no released milestones yet',
      })
    }
  }

  // ---- 2 · attendance_verification (weight 15, trailing 30 days) ----
  // Verified (worker/kiosk/USSD evidence) share of attendance rows. Reported
  // (manager-says) and exception rows are the honest, unverified remainder.
  {
    const rows = attendances.length
    if (rows > 0) {
      const verified = attendances.filter((a) => a.verification === 'verified').length
      const ratio = verified / rows
      components.push({
        key: 'attendance_verification',
        label: 'Attendance verification',
        weight: SCORE_WEIGHTS.attendance_verification,
        value: Math.round(ratio * 100),
        deduction: linearDeduction(1 - ratio, SCORE_WEIGHTS.attendance_verification),
        evidence: `${verified} of ${rows} attendance rows verified in the last ${ATTENDANCE_WINDOW_DAYS} days (${['verified', 'reported', 'exception'].map((v) => `${v} ${attendances.filter((a) => a.verification === v).length}`).join(' · ')})`,
      })
    } else {
      components.push({
        key: 'attendance_verification', label: 'Attendance verification',
        weight: SCORE_WEIGHTS.attendance_verification, value: null, deduction: null,
        evidence: `no attendance rows in the last ${ATTENDANCE_WINDOW_DAYS} days`,
      })
    }
  }

  // ---- 3 · budget_discipline (weight 20) — R1 budget_pace, reused ----
  // The SAME gap the risk engine's R1 rule computes: spent% of phase budgets
  // minus overall progress%. A 30-point lead is R1's critical line and deducts
  // the full weight. Under-spending (negative lead) deducts nothing.
  {
    const budgetTotal = phases.reduce((s, p) => s + p.budget, 0)
    if (budgetTotal > 0) {
      const spent = transactions.reduce((s, t) => s + t.amount, 0)
      const spentPct = (spent / budgetTotal) * 100
      const progressPct = overallProgress(phases)
      const lead = spentPct - progressPct
      components.push({
        key: 'budget_discipline',
        label: 'Budget discipline',
        weight: SCORE_WEIGHTS.budget_discipline,
        value: Math.max(0, Math.round(100 - (Math.max(0, lead) / BUDGET_LEAD_CAP_POINTS) * 100)),
        deduction: linearDeduction(lead / BUDGET_LEAD_CAP_POINTS, SCORE_WEIGHTS.budget_discipline),
        evidence: `${kes(spent)} spent = ${Math.round(spentPct)}% of ${kes(budgetTotal)} phase budget while work completed is ${progressPct}% — spend ${Math.round(lead)} pts ${lead >= 0 ? 'ahead of' : 'behind'} progress (R1 budget_pace)`,
      })
    } else {
      components.push({
        key: 'budget_discipline', label: 'Budget discipline',
        weight: SCORE_WEIGHTS.budget_discipline, value: null, deduction: null,
        evidence: 'no phase budgets on record',
      })
    }
  }

  // ---- 4 · variation_discipline (weight 15) ----
  // APPROVED variation budgetImpact total vs the project budget (negative
  // savings clamp to 0). No variation orders on record yet → null (nothing to
  // measure); approved variations totalling 15%+ of the budget deducts the
  // full weight.
  {
    if (projectBudget > 0 && variations.length > 0) {
      const approved = variations.filter((v) => v.status === 'approved')
      const approvedImpact = Math.max(0, approved.reduce((s, v) => s + v.budgetImpact, 0))
      const ratio = approvedImpact / projectBudget
      components.push({
        key: 'variation_discipline',
        label: 'Variation discipline',
        weight: SCORE_WEIGHTS.variation_discipline,
        value: Math.max(0, Math.round(100 - (ratio / VARIATION_IMPACT_CAP_RATIO) * 100)),
        deduction: linearDeduction(ratio / VARIATION_IMPACT_CAP_RATIO, SCORE_WEIGHTS.variation_discipline),
        evidence: `${kes(approvedImpact)} approved variation impact (${approved.length} of ${variations.length} approved) on a ${kes(projectBudget)} budget = ${pct1(ratio)}`,
      })
    } else {
      components.push({
        key: 'variation_discipline', label: 'Variation discipline',
        weight: SCORE_WEIGHTS.variation_discipline, value: null, deduction: null,
        evidence: projectBudget > 0 ? 'no variation orders on record' : 'no project budget on record',
      })
    }
  }

  // ---- 5 · delivery_discrepancy (weight 15) — R3 inputs ----
  // Discrepancy deliveries over LANDED deliveries (received or discrepant —
  // in-transit rows are not evidence either way). 25% discrepant deducts the
  // full weight.
  {
    const landed = deliveries.filter((d) => (LANDED_DELIVERY_STATUSES as readonly string[]).includes(d.status))
    if (landed.length > 0) {
      const discrepant = landed.filter((d) => d.status === 'discrepancy').length
      const ratio = discrepant / landed.length
      components.push({
        key: 'delivery_discrepancy',
        label: 'Delivery accuracy',
        weight: SCORE_WEIGHTS.delivery_discrepancy,
        value: Math.round((1 - ratio) * 100),
        deduction: linearDeduction(ratio / DELIVERY_DISCREPANCY_CAP_RATIO, SCORE_WEIGHTS.delivery_discrepancy),
        evidence: `${discrepant} of ${landed.length} landed deliveries closed with a quantity discrepancy (R3 procurement inputs)`,
      })
    } else {
      components.push({
        key: 'delivery_discrepancy', label: 'Delivery accuracy',
        weight: SCORE_WEIGHTS.delivery_discrepancy, value: null, deduction: null,
        evidence: 'no landed deliveries yet',
      })
    }
  }

  // ---- 6 · invoice_disputes (weight 15) ----
  // Disputed share of ALL invoices on the project (a dispute is a client-
  // documented disagreement with a bill — every invoice is the denominator).
  // 20% disputed deducts the full weight.
  {
    const total = invoices.length
    if (total > 0) {
      const disputed = invoices.filter((i) => i.status === 'disputed').length
      const ratio = disputed / total
      components.push({
        key: 'invoice_disputes',
        label: 'Invoice disputes',
        weight: SCORE_WEIGHTS.invoice_disputes,
        value: Math.round((1 - ratio) * 100),
        deduction: linearDeduction(ratio / INVOICE_DISPUTE_CAP_RATIO, SCORE_WEIGHTS.invoice_disputes),
        evidence: `${disputed} of ${total} invoices disputed (${invoices.filter((i) => i.status !== 'disputed').length} not disputed)`,
      })
    } else {
      components.push({
        key: 'invoice_disputes', label: 'Invoice disputes',
        weight: SCORE_WEIGHTS.invoice_disputes, value: null, deduction: null,
        evidence: 'no invoices on record',
      })
    }
  }

  // ---- score = 100 − renormalized weighted deductions ----
  const available = components.filter((c) => c.value !== null)
  const availableWeight = available.reduce((s, c) => s + c.weight, 0)
  const deductionTotal = available.reduce((s, c) => s + (c.deduction ?? 0), 0)

  if (available.length < MIN_COMPONENTS_FOR_SCORE) {
    // Honest low-confidence state: never a fake 0 or 100 — quote nothing.
    const missing = components.filter((c) => c.value === null).map((c) => c.label.toLowerCase())
    return {
      score: null,
      confidence: 'low',
      components,
      notes:
        `Not enough history to quote a score — only ${available.length} of ${components.length} components have data ` +
        `(needs ≥ ${MIN_COMPONENTS_FOR_SCORE}). Still without rows: ${missing.join(', ')}. ` +
        'Compute again once the project records releases, attendance, procurement or invoices.',
      ruleVersion: SCORE_RULE_VERSION,
    }
  }

  // Renormalize over the components that HAVE data so a half-empty project is
  // not padded toward 100 (or dragged toward 0) by components it cannot have.
  const score = Math.max(0, Math.min(100, Math.round(100 * (1 - deductionTotal / availableWeight))))
  const confidence: ScoreConfidence =
    available.length >= 5 ? 'high' : available.length >= 3 ? 'medium' : 'low'

  return { score, confidence, components, notes: null, ruleVersion: SCORE_RULE_VERSION }
}
