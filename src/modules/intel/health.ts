// Intel module — PROJECT HEALTH SCORE (spec §48).
//
// Six transparent dimensions (Progress, Budget, Schedule, Procurement, Issues,
// Evidence), each 0-100 with a grade (Good ≥80 / Attention 50-79 / Poor <50)
// and a one-line summary that cites the real numbers behind it. Nothing here
// is an opaque "AI score": every dimension documents its exact inputs so the
// Overview card can render a "How this is computed" section from the same data.
//
// computeHealth(projectId) reads live rows (same query patterns as the risk
// engine in engine.ts / service.ts), then persists a ProjectHealth snapshot
// (one row per project — upsert-per-compute, replaced on every run) so the
// value shown is always the latest computation, traceable to computedAt.

import { db } from '@/lib/db'
import { OPEN_REQUEST_STATUSES, OPEN_ORDER_STATUSES, overallProgress } from './engine'
import { parseRiskFindings, HEALTH_INPUTS, HEALTH_DIMENSION_LABELS, type HealthDimension, type HealthGrade, type HealthSnapshot } from './types'

const DAY_MS = 86_400_000

export const HEALTH_RULE_VERSION = '1'

export function gradeFor(score: number): HealthGrade {
  if (score >= 80) return 'good'
  if (score >= 50) return 'attention'
  return 'poor'
}

function kes(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n))
}

function dim(key: HealthDimension['key'], score: number, summary: string): HealthDimension {
  const s = Math.round(clamp(score))
  return { key, label: HEALTH_DIMENSION_LABELS[key], score: s, grade: gradeFor(s), summary }
}

/**
 * Compute the 6-dimension health score for a project from its live rows and
 * persist a ProjectHealth snapshot (replaces the previous snapshot — the model
 * has no unique constraint on projectId, so "upsert" here is replace-on-write).
 */
export async function computeHealth(projectId: string): Promise<HealthSnapshot> {
  const now = new Date()
  const [project, phases, transactions, requests, orders, alerts, risk, photos] = await Promise.all([
    db.project.findUnique({ where: { id: projectId } }),
    db.phase.findMany({ where: { projectId }, include: { tasks: true } }),
    db.transaction.findMany({ where: { projectId } }),
    db.materialRequest.findMany({ where: { projectId }, include: { lines: true } }),
    db.purchaseOrder.findMany({
      where: { projectId },
      include: { deliveries: { include: { lines: true } } },
    }),
    db.alert.findMany({ where: { projectId } }),
    db.riskAssessment.findFirst({ where: { projectId }, orderBy: { computedAt: 'desc' } }),
    db.sitePhoto.findMany({ where: { projectId } }),
  ])
  if (!project) throw new Error('Project not found')

  // ---- Progress: budget-weighted phase progress (same rule as overallProgress) ----
  const riskPhases = phases.map((p) => ({
    name: p.name, status: p.status, budget: p.budget, progressManual: p.progressManual,
    tasks: p.tasks.map((t) => ({ title: t.title, status: t.status, progress: t.progress, dueDate: t.dueDate })),
  }))
  const progressPct = overallProgress(riskPhases)
  const phasesDone = phases.filter((p) => p.status === 'done').length
  const allTasks = phases.flatMap((p) => p.tasks)
  const openTasks = allTasks.filter((t) => t.status !== 'done')
  const progress = dim('progress', progressPct,
    `${progressPct}% complete — ${phasesDone}/${phases.length} phases done, ${openTasks.length} of ${allTasks.length} tasks still open.`)

  // ---- Budget: spend pace vs linear plan + committed on open POs ----
  const budgetTotal = phases.reduce((s, p) => s + p.budget, 0)
  const spent = transactions.reduce((s, t) => s + t.amount, 0)
  const dayCount = Math.max(1, Math.ceil((now.getTime() - project.startDate.getTime()) / DAY_MS))
  const totalDays = Math.max(
    dayCount,
    Math.ceil((project.targetDate.getTime() - project.startDate.getTime()) / DAY_MS),
  )
  const plannedPct = budgetTotal ? Math.round((dayCount / totalDays) * 100) : 0
  const spentPct = budgetTotal ? Math.round((spent / budgetTotal) * 100) : 0
  const openOrders = orders.filter((o) => (OPEN_ORDER_STATUSES as readonly string[]).includes(o.status))
  const committed = openOrders.reduce((s, o) => s + o.total, 0)
  const committedPct = budgetTotal ? Math.round((committed / budgetTotal) * 100) : 0
  const lead = spentPct - plannedPct
  const overCommit = Math.max(0, spentPct + committedPct - 100)
  const budgetScore = budgetTotal
    ? 100 - Math.max(0, lead) * 2.5 - overCommit * 1.5
    : 100
  const budget = dim('budget', budgetScore,
    budgetTotal
      ? `${kes(spent)} spent (${spentPct}% of ${kes(budgetTotal)}) vs ${plannedPct}% calendar pace${lead > 0 ? ` — ${lead}pts ahead` : lead < 0 ? ` — ${-lead}pts behind pace` : ''}; ${kes(committed)} committed on ${openOrders.length} open order${openOrders.length === 1 ? '' : 's'}.`
      : 'No phase budgets recorded yet — budget health cannot be scored.')

  // ---- Schedule: overdue tasks vs total ----
  const overdue = allTasks.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < now)
  const overdueRatio = allTasks.length ? overdue.length / allTasks.length : 0
  const daysRemaining = Math.max(0, Math.ceil((project.targetDate.getTime() - now.getTime()) / DAY_MS))
  const schedule = dim('schedule', 100 - overdueRatio * 200,
    allTasks.length
      ? `${overdue.length} of ${allTasks.length} tasks past their due date and not done; target ${project.targetDate.toISOString().slice(0, 10)} (${daysRemaining} days left).`
      : 'No tasks recorded yet — schedule health cannot be scored.')

  // ---- Procurement: open requests/orders + delivery discrepancies + stuck orders ----
  const openRequests = requests.filter((r) => (OPEN_REQUEST_STATUSES as readonly string[]).includes(r.status))
  const discrepancyRows = orders.flatMap((o) =>
    o.deliveries
      .filter((d) => d.status === 'discrepancy')
      .map((d) => ({ orderCode: o.orderCode, lines: d.lines })),
  )
  const stuck = orders.filter(
    (o) => (o.status === 'sent' || o.status === 'confirmed') && now.getTime() - o.createdAt.getTime() > 14 * DAY_MS,
  )
  const procurement = dim('procurement',
    100 - discrepancyRows.length * 15 - stuck.length * 10,
    `${openRequests.length} open request${openRequests.length === 1 ? '' : 's'}, ${openOrders.length} open order${openOrders.length === 1 ? '' : 's'}; ${discrepancyRows.length} delivery discrepanc${discrepancyRows.length === 1 ? 'y' : 'ies'} on record${stuck.length ? `, ${stuck.length} order${stuck.length === 1 ? '' : 's'} stuck >14 days` : ''}.`)

  // ---- Issues: unacked alerts + risk findings severity ----
  const unacked = alerts.filter((a) => !a.acknowledged).length
  const findings = risk ? parseRiskFindings(risk.findings) : []
  const critical = findings.filter((f) => f.severity === 'critical').length
  const warnings = findings.filter((f) => f.severity === 'warning').length
  const issues = dim('issues',
    100 - unacked * 10 - critical * 15 - warnings * 5,
    `${unacked} unacknowledged alert${unacked === 1 ? '' : 's'}; latest risk assessment (score ${risk?.overallScore ?? '—'}) flags ${critical} critical / ${warnings} warning finding${critical + warnings === 1 ? '' : 's'}.`)

  // ---- Evidence: photo coverage per phase ----
  const phasesWithPhotos = new Set(photos.map((p) => p.phaseId).filter(Boolean)).size
  const coverage = phases.length ? (phasesWithPhotos / phases.length) * 100 : 0
  const evidence = dim('evidence', coverage,
    `${photos.length} site photo${photos.length === 1 ? '' : 's'} on record; ${phasesWithPhotos}/${phases.length} phase${phases.length === 1 ? '' : 's'} carry photo evidence${photos.length ? ` (latest ${photos[0].createdAt.toISOString().slice(0, 10)})` : ''}.`)

  const dimensions = [progress, budget, schedule, procurement, issues, evidence]
  const overall = Math.round(dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length)

  // Persist the snapshot (replace-on-write keeps exactly one row per project).
  await db.projectHealth.deleteMany({ where: { projectId } })
  const row = await db.projectHealth.create({
    data: {
      projectId,
      overall,
      dimensions: JSON.stringify(dimensions),
    },
  })

  return {
    projectId,
    computedAt: row.computedAt.toISOString(),
    overall,
    dimensions,
  }
}

/** Read the persisted snapshot without recomputing (null when never computed). */
export async function readHealth(projectId: string): Promise<HealthSnapshot | null> {
  const row = await db.projectHealth.findFirst({ where: { projectId }, orderBy: { computedAt: 'desc' } })
  if (!row) return null
  let dimensions: HealthDimension[] = []
  try {
    const parsed = JSON.parse(row.dimensions)
    if (Array.isArray(parsed)) dimensions = parsed as HealthDimension[]
  } catch { /* malformed legacy row → empty dimensions */ }
  return {
    projectId: row.projectId,
    computedAt: row.computedAt.toISOString(),
    overall: row.overall,
    dimensions,
  }
}
