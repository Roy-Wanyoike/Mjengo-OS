// Intel module — the deterministic engines (PURE functions, no DB).
//
// Every rule is documented inline with its exact thresholds so any number in
// the UI can be traced back to the rows that produced it. No fake AI mystique:
// same rows in → same numbers out. Intel describes patterns; humans decide.
//
// Rule version '1' — bump RULE_VERSION when a rule changes so history rows
// stay interpretable.

import type {
  FindingSeverity, PriceTrendRow, ProcurementSuggestion, SupplierReliability, ReliabilityComponent,
  SupplierLike,
} from './types'

export const RULE_VERSION = '1'

/** Severity weights for the overall score (subtracted from 100). */
export const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = { info: 5, warning: 15, critical: 30 }

// Status sets shared by the rules (documented, deterministic).
export const OPEN_REQUEST_STATUSES = ['draft', 'submitted', 'approved'] as const
export const OPEN_ORDER_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'confirmed', 'delivering'] as const
const TERMINAL_ORDER_STATUSES = ['delivered', 'closed', 'cancelled'] as const

// ---------------- risk engine (5 rules) ----------------

export interface RiskTask { title: string; status: string; progress: number; dueDate: Date | null }
export interface RiskPhase { name: string; status: string; budget: number; progressManual: number | null; tasks: RiskTask[] }
export interface RiskDelivery { status: string; dispatchedAt: Date | null; receivedAt: Date | null; lines: Array<{ qtyOrdered: number; qtyReceived: number }> }
export interface RiskOrder { orderCode: string; status: string; createdAt: Date; deliveries: RiskDelivery[] }
export interface RiskInput {
  now: Date
  project: { location: string; targetDate: Date }
  phases: RiskPhase[]
  transactions: Array<{ amount: number }>
  orders: RiskOrder[]
  priceTrends: PriceTrendRow[]
  attendances: Array<{ date: string; status: string }> // rows from the last 10 days only
}

export interface EngineFinding {
  rule: string
  severity: FindingSeverity
  title: string
  message: string
  evidence: string
  score: number
}

function phaseProgress(p: RiskPhase): number {
  // Mirrors phaseProgress() in lib/mjengo.ts exactly.
  if (p.progressManual !== null && p.progressManual !== undefined) return p.progressManual
  if (!p.tasks.length) return 0
  return Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length)
}

/** Mirrors overallProgress() in lib/mjengo.ts (local copy avoids a circular import). */
export function overallProgress(phases: RiskPhase[]): number {
  const totalBudget = phases.reduce((s, p) => s + p.budget, 0)
  if (!totalBudget) return 0
  return Math.round(
    (phases.reduce((s, p) => s + (phaseProgress(p) / 100) * p.budget, 0) / totalBudget) * 100,
  )
}

function kes(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

const DAY_MS = 86_400_000

/**
 * Run the 5 deterministic risk rules. One finding per rule at most (sub-checks
 * are combined; the strongest severity wins).
 *
 * R1 budget_pace — spent% (transactions / phase budgets) vs overall progress%:
 *    spent − progress > 15pts → warning; > 30pts → critical.
 * R2 schedule_watch — open tasks in in_progress phases (info), overdue tasks
 *    (warning), and target date within 30d while progress < 80% (warning).
 * R3 procurement_watch — delivery discrepancies (1-2 → warning, ≥3 → critical)
 *    and orders stuck SENT/CONFIRMED > 14d from createdAt (info, ≥3 → warning).
 * R4 price_trend — Cement (tracked region for the project county) up > 5%
 *    over ~30d → warning.
 * R5 attendance_watch — absence rate over the last 10 recorded days > 20% → warning.
 */
export function computeRiskFindings(input: RiskInput): { findings: EngineFinding[]; overallScore: number } {
  const { now, project, phases, transactions, orders, priceTrends, attendances } = input
  const findings: EngineFinding[] = []

  // ---- R1 budget_pace ----
  const budgetTotal = phases.reduce((s, p) => s + p.budget, 0)
  const spent = transactions.reduce((s, t) => s + t.amount, 0)
  if (budgetTotal > 0) {
    const spentPct = (spent / budgetTotal) * 100
    const progressPct = overallProgress(phases)
    const lead = spentPct - progressPct
    if (lead > 30) {
      findings.push({
        rule: 'budget_pace', severity: 'critical',
        title: `Spend ${Math.round(lead)} points ahead of progress`,
        message: `${kes(spent)} spent is ${Math.round(spentPct)}% of the ${kes(budgetTotal)} budget while work completed is ${progressPct}% — the gap exceeds 30 points.`,
        evidence: `${transactions.length} transactions · ${phases.length} phases`,
        score: SEVERITY_WEIGHTS.critical,
      })
    } else if (lead > 15) {
      findings.push({
        rule: 'budget_pace', severity: 'warning',
        title: `Spend ${Math.round(lead)} points ahead of progress`,
        message: `${kes(spent)} spent is ${Math.round(spentPct)}% of the ${kes(budgetTotal)} budget while work completed is ${progressPct}% — spending is running ahead of the work recorded.`,
        evidence: `${transactions.length} transactions · ${phases.length} phases`,
        score: SEVERITY_WEIGHTS.warning,
      })
    }
  }

  // ---- R2 schedule_watch ----
  {
    const activePhases = phases.filter((p) => p.status === 'in_progress')
    const openTasks = activePhases.flatMap((p) => p.tasks.filter((t) => t.status !== 'done').map((t) => ({ phase: p.name, task: t })))
    const overdue = phases.flatMap((p) => p.tasks.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < now))
    const daysToTarget = Math.ceil((project.targetDate.getTime() - now.getTime()) / DAY_MS)
    const progressPct = overallProgress(phases)
    const parts: string[] = []
    const evidence: string[] = []
    let severity: FindingSeverity = 'info'
    let title = 'Schedule on track'

    if (overdue.length > 0) {
      severity = 'warning'
      title = `${overdue.length} task${overdue.length > 1 ? 's' : ''} past due`
      parts.push(`${overdue.length} task${overdue.length > 1 ? 's are' : ' is'} past the due date and not done (${overdue.slice(0, 3).map((t) => t.title).join('; ')}${overdue.length > 3 ? '…' : ''})`)
      evidence.push(`${overdue.length} overdue tasks`)
    }
    if (openTasks.length > 0) {
      const byPhase = new Map<string, number>()
      for (const { phase } of openTasks) byPhase.set(phase, (byPhase.get(phase) ?? 0) + 1)
      const phaseList = Array.from(byPhase.entries()).map(([name, n]) => `${n} in ${name}`).join(', ')
      parts.push(`${openTasks.length} open task${openTasks.length > 1 ? 's' : ''} in the active phase${activePhases.length > 1 ? 's' : ''} (${phaseList})`)
      evidence.push(`${openTasks.length} open tasks · ${activePhases.length} in-progress phases`)
      if (severity === 'info') title = `${openTasks.length} open tasks in the active phase`
    }
    if (daysToTarget >= 0 && daysToTarget <= 30 && progressPct < 80) {
      if (severity !== 'warning') severity = 'warning'
      if (title === 'Schedule on track') title = `Target date in ${daysToTarget} days at ${progressPct}% progress`
      parts.push(`the target date is ${daysToTarget} days away while progress is ${progressPct}% (under 80%)`)
      evidence.push(`target ${project.targetDate.toISOString().slice(0, 10)} · progress ${progressPct}%`)
    }

    if (parts.length > 0) {
      findings.push({
        rule: 'schedule_watch', severity,
        title,
        message: `Schedule watch: ${parts.join('; ')}.`,
        evidence: evidence.join(' · '),
        score: SEVERITY_WEIGHTS[severity],
      })
    }
  }

  // ---- R3 procurement_watch ----
  {
    const discrepancies = orders.flatMap((o) => o.deliveries.filter((d) => d.status === 'discrepancy').map((d) => ({ order: o, delivery: d })))
    const stuck = orders.filter(
      (o) => (o.status === 'sent' || o.status === 'confirmed') && now.getTime() - o.createdAt.getTime() > 14 * DAY_MS,
    )
    const parts: string[] = []
    const evidence: string[] = []
    let severity: FindingSeverity | null = null
    let title = 'Procurement watch'

    if (discrepancies.length > 0) {
      severity = discrepancies.length >= 3 ? 'critical' : 'warning'
      title = `${discrepancies.length} delivery discrepanc${discrepancies.length > 1 ? 'ies' : 'y'} on record`
      const details = discrepancies.slice(0, 2).map(({ order, delivery }) => {
        const counts = delivery.lines.map((l) => `${Math.round(l.qtyReceived)}/${Math.round(l.qtyOrdered)}`).join(', ')
        return `${order.orderCode} (${counts} received/ordered)`
      })
      parts.push(`${discrepancies.length} deliver${discrepancies.length > 1 ? 'ies' : 'y'} closed with a quantity discrepancy (${details.join('; ')})`)
      evidence.push(`${discrepancies.length} discrepancy deliveries · ${orders.length} orders`)
    }
    if (stuck.length > 0) {
      const stuckSev: FindingSeverity = stuck.length >= 3 ? 'warning' : 'info'
      if (severity === null || SEVERITY_WEIGHTS[stuckSev] > SEVERITY_WEIGHTS[severity]) severity = stuckSev
      parts.push(`${stuck.length} order${stuck.length > 1 ? 's are' : ' is'} stuck in ${stuck[0].status.toUpperCase()} for more than 14 days (${stuck.map((o) => o.orderCode).join(', ')})`)
      evidence.push(`${stuck.length} orders > 14d in sent/confirmed`)
      if (title === 'Procurement watch') title = `${stuck.length} order${stuck.length > 1 ? 's' : ''} awaiting supplier action`
    }

    if (severity !== null && parts.length > 0) {
      findings.push({
        rule: 'procurement_watch', severity,
        title,
        message: `Procurement watch: ${parts.join('; ')}.`,
        evidence: evidence.join(' · '),
        score: SEVERITY_WEIGHTS[severity],
      })
    }
  }

  // ---- R4 price_trend (Cement, tracked region closest to the project county) ----
  {
    const cementRows = priceTrends.filter((r) => r.materialName.toLowerCase().includes('cement'))
    if (cementRows.length > 0) {
      const loc = project.location.toLowerCase()
      const inCounty = cementRows.find((r) => loc.includes(r.region.toLowerCase()))
      const row = inCounty ?? cementRows.reduce((best, r) => (r.pointCount > best.pointCount ? r : best), cementRows[0])
      if (row.deltaPct !== null && row.deltaPct > 5) {
        findings.push({
          rule: 'price_trend', severity: 'warning',
          title: `Cement price up ${row.deltaPct.toFixed(1)}%`,
          message: `Cement in ${row.region} moved from ${kes(row.previous ?? 0)} to ${kes(row.current)} per unit over the last ~30 days (more than +5%). Consider scheduling orders early — this is a market trend, not a prediction.`,
          evidence: `${row.materialName} · ${row.region} · ${row.pointCount} price points`,
          score: SEVERITY_WEIGHTS.warning,
        })
      }
    }
  }

  // ---- R5 attendance_watch (last 10 days) ----
  {
    if (attendances.length > 0) {
      const absent = attendances.filter((a) => a.status === 'absent').length
      const rate = (absent / attendances.length) * 100
      if (rate > 20) {
        findings.push({
          rule: 'attendance_watch', severity: 'warning',
          title: `Absence rate ${Math.round(rate)}% over the last 10 days`,
          message: `${absent} of ${attendances.length} attendance rows in the last 10 days are absent — above the 20% watch level. Crew size or motivation may need attention.`,
          evidence: `${attendances.length} attendance rows · ${absent} absent`,
          score: SEVERITY_WEIGHTS.warning,
        })
      }
    }
  }

  const penalty = findings.reduce((s, f) => s + SEVERITY_WEIGHTS[f.severity], 0)
  const overallScore = Math.max(0, 100 - penalty)
  return { findings, overallScore }
}

// ---------------- price trend engine ----------------

export interface PricePointLike { materialName: string; region: string; unitPrice: number; recordedAt: Date; source: string }

/**
 * Group price points by material+region and compute the trend rows:
 * latest price, the most recent point recorded ≥30 days ago ("previous"),
 * the % delta between them and the chronological sparkline series.
 */
export function computePriceTrends(points: PricePointLike[], now: Date): PriceTrendRow[] {
  const groups = new Map<string, PricePointLike[]>()
  for (const p of points) {
    const key = `${p.materialName}\u0000${p.region}`
    const arr = groups.get(key) ?? []
    arr.push(p)
    groups.set(key, arr)
  }
  const cutoff = new Date(now.getTime() - 30 * DAY_MS)
  const rows: PriceTrendRow[] = []
  for (const arr of groups.values()) {
    const chronological = [...arr].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
    const latest = chronological[chronological.length - 1]
    // "previous" = the most recent point recorded at least 30 days ago
    const prevPoint = [...chronological].reverse().find((p) => p.recordedAt.getTime() <= cutoff.getTime())
    const deltaPct = prevPoint && prevPoint.unitPrice > 0 ? ((latest.unitPrice - prevPoint.unitPrice) / prevPoint.unitPrice) * 100 : null
    rows.push({
      materialName: latest.materialName,
      region: latest.region,
      current: latest.unitPrice,
      previous: prevPoint ? prevPoint.unitPrice : null,
      deltaPct: deltaPct === null ? null : Math.round(deltaPct * 10) / 10,
      points: chronological.slice(-12).map((p) => ({ t: p.recordedAt.toISOString(), price: p.unitPrice })),
      lastRecordedAt: latest.recordedAt.toISOString(),
      source: latest.source,
      pointCount: chronological.length,
    })
  }
  return rows.sort((a, b) => a.materialName.localeCompare(b.materialName) || a.region.localeCompare(b.region))
}

// ---------------- procurement suggestions (spec §19, lite) ----------------

export interface SuggestionDoc {
  code: string // request or order code
  kind: 'request' | 'order'
  status: string
  lines: Array<{ materialName: string; qty: number; unit: string }>
}

/**
 * Deterministic cover check: for every price-tracked material, is there an
 * OPEN request line or OPEN PO line that names it (name containment either
 * way — "Cement 50kg" matches "Cement 50kg (32.5N)")? Uncovered materials get
 * a plain-language suggestion. Nothing is auto-created — humans decide.
 */
export function computeSuggestions(trackedMaterials: string[], docs: SuggestionDoc[]): ProcurementSuggestion[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const matches = (a: string, b: string) => {
    const na = norm(a)
    const nb = norm(b)
    return na === nb || (na.length > 3 && nb.includes(na)) || (nb.length > 3 && na.includes(nb))
  }
  return trackedMaterials
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((materialName) => {
      const covers: string[] = []
      for (const doc of docs) {
        for (const line of doc.lines) {
          if (matches(materialName, line.materialName)) {
            covers.push(`${doc.code} (${doc.status}) · ${Math.round(line.qty)} ${line.unit}`)
            break
          }
        }
      }
      if (covers.length > 0) {
        return {
          materialName,
          status: 'covered' as const,
          coverDetail: covers.slice(0, 2).join(' · ') + (covers.length > 2 ? ` +${covers.length - 2} more` : ''),
          hint: 'Open request or PO already names this material.',
        }
      }
      return {
        materialName,
        status: 'uncovered' as const,
        coverDetail: null,
        hint: `No open request or PO covers ${materialName} — consider requesting quotes.`,
      }
    })
}

// ---------------- supplier reliability engine (spec §16) ----------------

export interface SupplierOrderHistory {
  status: string
  createdAt: Date
  deliveries: Array<{ status: string; dispatchedAt: Date | null; receivedAt: Date | null; lines: Array<{ qtyOrdered: number; qtyReceived: number }> }>
}

/**
 * Reliability from ACTUAL platform transaction history — there are NO
 * anonymous ratings anywhere in this computation (Finder spec §16).
 *
 * Components (weights sum to 1):
 *  · deliveryAccuracy 35% — avg qtyReceived/qtyOrdered over the supplier's
 *    delivery lines (over-delivery caps at 100).
 *  · onTime            20% — share of deliveries received within 3 days of
 *    dispatch (OrderDelivery has no stored ETA — 3 days is the documented proxy).
 *  · completion        20% — delivered+closed / terminal orders (delivered,
 *    closed, cancelled). In-flight orders don't count either way.
 *  · disputes          15% — 100 − 25 per DISCREPANCY delivery (floor 0).
 *  · response          10% — from Supplier.responseHours: ≤6h → 100, 48h+ → 25,
 *    linear between.
 *
 * A component with no data contributes a NEUTRAL 50 at its full weight, so a
 * supplier with little history trends toward 50 instead of 0 or 100. A supplier
 * with ZERO orders is held at exactly 50 with an honest note.
 */
const RELIABILITY_WEIGHTS: Array<Omit<ReliabilityComponent, 'value' | 'detail'>> = [
  { key: 'deliveryAccuracy', label: 'Delivery accuracy', weight: 0.35 },
  { key: 'onTime', label: 'On-time (≤3d)', weight: 0.2 },
  { key: 'completion', label: 'Order completion', weight: 0.2 },
  { key: 'disputes', label: 'Dispute-free', weight: 0.15 },
  { key: 'response', label: 'Response speed', weight: 0.1 },
]

export function computeReliability(supplier: SupplierLike, orders: SupplierOrderHistory[]): SupplierReliability {
  const deliveries = orders.flatMap((o) => o.deliveries)
  const lines = deliveries.flatMap((d) => d.lines)

  // delivery accuracy
  let deliveryAccuracy: number | null = null
  let accDetail = 'No delivery lines yet'
  if (lines.length > 0) {
    const avg = lines.reduce((s, l) => s + Math.min(1, l.qtyOrdered > 0 ? l.qtyReceived / l.qtyOrdered : 0), 0) / lines.length
    deliveryAccuracy = Math.round(avg * 100)
    accDetail = `Avg ${Math.round(lines.reduce((s, l) => s + l.qtyReceived, 0))}/${Math.round(lines.reduce((s, l) => s + l.qtyOrdered, 0))} units across ${lines.length} line${lines.length > 1 ? 's' : ''}`
  }

  // on-time: received within 3 days of dispatch
  const received = deliveries.filter((d) => d.receivedAt && d.dispatchedAt)
  let onTime: number | null = null
  let onTimeDetail = 'No received deliveries yet'
  if (received.length > 0) {
    const ok = received.filter((d) => (d.receivedAt as Date).getTime() - (d.dispatchedAt as Date).getTime() <= 3 * DAY_MS).length
    onTime = Math.round((ok / received.length) * 100)
    onTimeDetail = `${ok}/${received.length} received within 3 days of dispatch`
  }

  // completion over terminal orders only
  const terminal = orders.filter((o) => (TERMINAL_ORDER_STATUSES as readonly string[]).includes(o.status))
  let completion: number | null = null
  let compDetail = 'No finished orders yet'
  if (terminal.length > 0) {
    const done = terminal.filter((o) => o.status === 'delivered' || o.status === 'closed').length
    completion = Math.round((done / terminal.length) * 100)
    compDetail = `${done}/${terminal.length} orders delivered or closed`
  }

  // disputes
  const discrepancies = deliveries.filter((d) => d.status === 'discrepancy').length
  let disputes: number | null = null
  let dispDetail = 'No deliveries to dispute yet'
  if (deliveries.length > 0) {
    disputes = Math.max(0, 100 - 25 * discrepancies)
    dispDetail = discrepancies === 0 ? 'No discrepancy deliveries' : `${discrepancies} discrepancy deliver${discrepancies > 1 ? 'ies' : 'y'} (−25 each)`
  }

  // response speed from the recorded responseHours
  const h = supplier.responseHours
  const response = Math.max(25, Math.min(100, Math.round(100 - (h - 6) * (75 / 42))))
  const respDetail = h <= 6 ? `Responds within ${h}h` : `~${h}h average response`

  const values: Record<ReliabilityComponent['key'], { value: number | null; detail: string }> = {
    deliveryAccuracy: { value: deliveryAccuracy, detail: accDetail },
    onTime: { value: onTime, detail: onTimeDetail },
    completion: { value: completion, detail: compDetail },
    disputes: { value: disputes, detail: dispDetail },
    response: { value: response, detail: respDetail },
  }

  const components: ReliabilityComponent[] = RELIABILITY_WEIGHTS.map((w) => ({ ...w, value: values[w.key].value, detail: values[w.key].detail }))

  const noOrders = orders.length === 0
  const score = noOrders
    ? 50
    : Math.max(0, Math.min(100, Math.round(components.reduce((s, c) => s + c.weight * (c.value ?? 50), 0))))

  const note = noOrders
    ? 'No orders yet — held neutral at 50. This score uses actual platform transaction history only, never anonymous ratings.'
    : `From ${orders.length} order${orders.length > 1 ? 's' : ''} and ${deliveries.length} deliver${deliveries.length === 1 ? 'y' : 'ies'} on the platform.`

  return {
    supplierId: supplier.id,
    businessName: supplier.businessName,
    county: supplier.county,
    score,
    storedScore: supplier.reliabilityScore,
    responseHours: supplier.responseHours,
    ordersCount: orders.length,
    deliveriesCount: deliveries.length,
    discrepanciesCount: discrepancies,
    components,
    note,
  }
}

// ---------------- digest aggregation ----------------

export interface DigestCounts {
  pendingApprovals: number
  inTransitOrders: number
  discrepancies: number
}

/** ISO date of the Monday of the week containing `d` (digest weekStart convention). */
export function mondayOf(d: Date): string {
  const date = new Date(d)
  const dow = (date.getDay() + 6) % 7 // Monday = 0
  date.setDate(date.getDate() - dow)
  return date.toISOString().slice(0, 10)
}
