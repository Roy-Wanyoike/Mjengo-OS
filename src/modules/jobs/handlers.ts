// Background jobs — handlers (spec §58).
//
// The shared cores for both the AI routes and the JobRecord queue:
//   · runAnomalyScan      — same logic as POST /api/ai/anomaly-scan
//   · runDailyRecap       — same logic as POST /api/ai/recap
//   · runWeeklyDigest     — reuses modules/intel generateDigest (imported)
//   · runReconciliation   — reuses invoices computeLedgerConsistency
//   · runOverdueCheck     — overdue tasks + absent workers today
//   · runBudgetCheck      — budget pace watch (90% / 100%)
//
// Handlers NEVER throw to the job runner (the runner catches + records the
// failure), always return a JSON-able result, and emit their domain events via
// the §59 bus — the event's default notification policy lands the bell row.

import { db } from '@/lib/db'
import { buildProjectDigest, llm } from '@/lib/ai'
import { emit } from '@/modules/events/service'
import { generateDigest } from '@/modules/intel/service'
import { computeLedgerConsistency } from '@/modules/invoices/three-way'
import type { LedgerCheck } from '@/modules/invoices/types'

/** Nairobi/EAT date string (UTC+3) — the platform's "today". */
function todayEAT(): string {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

/** Resolve the project a job runs against (explicit id > first project). */
async function resolveProjectId(projectId?: string | null): Promise<string> {
  if (projectId) {
    const p = await db.project.findUnique({ where: { id: String(projectId) } })
    if (p) return p.id
  }
  const first = await db.project.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!first) throw new Error('No project found')
  return first.id
}

// ---------------- anomaly_scan ----------------

export interface AnomalyScanResult {
  projectId: string
  alerts: Array<{ id: string; type: string; severity: string; title: string }>
  summary: string
}

/**
 * Anomaly scan shared core: reconcile deliveries vs consumption vs progress
 * vs budget, write up to 4 Alert rows, then emit 'anomaly.detected' (the event
 * policy notifies the contractor — kind 'anomaly' — so the bell surfaces it).
 */
export async function runAnomalyScan(projectId?: string | null): Promise<AnomalyScanResult> {
  const digest = await buildProjectDigest(projectId)

  const system = `You are MjengoOS's construction auditor AI for Kenyan residential builds (machine-cut stone masonry).
You reconcile the shared ledger: material deliveries, site consumption logs, attendance, spend and progress.
Typical consumption norms for a 3BR bungalow: foundation ≈ 95-110 cement bags; walling ≈ 7-9 bags per 10% progress; mortar sand ≈ 1 tonne per 12 bags cement; stones ≈ 55-70 per m² of wall.
Detect anomalies:
1. Material variance (delivered vs consumed vs expected for progress) — possible loss, theft or unlogged usage.
2. Ghost workers (wages paid vs plausible crew for progress).
3. Budget trajectory (spend % vs progress % — flag if spend leads progress by >8 points).
4. Suspicious supplier pricing vs catalog.
Respond with STRICT JSON only:
{"alerts": [{"type": "anomaly|budget|attendance|safety", "severity": "info|warning|critical", "title": "<short title>", "message": "<2-4 sentence explanation with KES figures>"}], "summary": "<overall site integrity verdict in 2-3 sentences>"}
Max 4 alerts, ordered by severity. Only flag genuine discrepancies — do not invent problems when numbers reconcile.`

  const result = await llm(system, `Project ledger digest:\n${JSON.stringify(digest, null, 1)}`, true) as {
    alerts: Array<{ type: string; severity: string; title: string; message: string }>
    summary: string
  }

  const created: Array<{ id: string; type: string; severity: string; title: string }> = []
  for (const a of (result.alerts ?? []).slice(0, 4)) {
    const alert = await db.alert.create({
      data: {
        projectId: digest.projectId,
        type: ['anomaly', 'budget', 'attendance', 'safety'].includes(a.type) ? a.type : 'anomaly',
        severity: ['info', 'warning', 'critical'].includes(a.severity) ? a.severity : 'info',
        title: a.title?.slice(0, 140) || 'Anomaly detected',
        message: a.message || '',
      },
    })
    created.push({ id: alert.id, type: alert.type, severity: alert.severity, title: alert.title })
  }

  // §59 domain event → default policy → in-app notification (kind 'anomaly').
  await emit(digest.projectId, 'anomaly.detected', {
    count: created.length,
    summary: result.summary ?? '',
    severity: created.some((a) => a.severity === 'critical')
      ? 'critical'
      : created.some((a) => a.severity === 'warning') ? 'warning' : 'info',
  })

  return { projectId: digest.projectId, alerts: created, summary: result.summary ?? '' }
}

// ---------------- digest.weekly ----------------

export interface DigestJobResult {
  projectId: string
  digestId: string
  weekStart: string
  summary: string
}

/** Weekly intel digest — reuses modules/intel generateDigest as-is. */
export async function runWeeklyDigest(projectId?: string | null): Promise<DigestJobResult> {
  const pid = await resolveProjectId(projectId)
  const digest = await generateDigest(pid)
  // 'digest.weekly' policy is null: the intel service already notifies
  // (kind digest.weekly) — the event row records the job ran it.
  await emit(pid, 'digest.weekly', { weekStart: digest.weekStart, summary: digest.summary })
  return { projectId: pid, digestId: digest.id, weekStart: digest.weekStart, summary: digest.summary }
}

// ---------------- recap.daily ----------------

export interface RecapJobResult {
  projectId: string
  recapId: string
  day: number
  content: string
}

/**
 * Daily 6 PM client recap shared core: writes the Recap row, then emits
 * 'recap.daily' — the event policy lands the notification-center row as an
 * HONEST in-app entry (channel in_app, deliveryStatus 'logged'): nothing is
 * sent on WhatsApp until a provider is wired.
 */
export async function runDailyRecap(projectId?: string | null): Promise<RecapJobResult> {
  const digest = await buildProjectDigest(projectId)

  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)
  const todayAttendance = digest.attendanceLastDays.filter((a) => a.date === today)
  const todayDeliveries = digest.deliveries.filter((d) => d.daysAgo === 0)

  const system = `You are MjengoOS. Every evening at 6 PM (EAT) you send the client a WhatsApp-style daily site recap.
The client is a Kenyan in the diaspora paying for a bungalow back home — warm, clear, trustworthy tone with light Swahili flavor (Habari ya leso style, but professional).
Format: plain text WhatsApp message, 5-8 short lines, using the actual bullets/emojis WhatsApp supports (📍 ✅ 🚚 💰 🧱 ⚠️). Always include: day number, crew checked in, what was done (infer from progress/tasks), any deliveries today, spend position, and one trust line (photo evidence on file). If there are unacknowledged critical/warning alerts, mention them as ⚠️. End with "— MjengoOS". No markdown headers or code blocks.`

  const user = `Today (${today}) data:
- Day ${digest.project.day} of build "${digest.project.name}" (${digest.project.location})
- Overall progress: ${digest.overallProgressPct}%
- Crew today: ${todayAttendance.length} workers (${todayAttendance.map((a) => `${a.worker?.split(' ')[0]} (${a.status})`).join(', ') || 'no check-ins yet'})
- Wages today: KES ${todayAttendance.reduce((s, a) => s + a.wageKES, 0)}
- Deliveries today: ${todayDeliveries.length ? todayDeliveries.map((d) => `${d.qty} ${d.unit} ${d.material}`).join('; ') : 'none'}
- Total spend: KES ${digest.spend.totalKES.toLocaleString()} of KES ${digest.project.budgetKES.toLocaleString()} budget
- Open alerts: ${digest.recentAlerts.filter((a) => a.severity !== 'info').map((a) => a.title).join('; ') || 'none'}
- Current phase tasks in progress: ${digest.phases.flatMap((p) => p.tasks.filter((t) => t.status === 'in_progress').map((t) => t.title)).join('; ') || 'phase transitions'}

Write today's recap.`

  const content = await llm(system, user, false)

  const recap = await db.recap.create({
    data: { projectId: digest.projectId, day: digest.project.day, content },
  })

  // §59 event → policy notify (channel in_app, recipient = client, honest).
  await emit(digest.projectId, 'recap.daily', {
    day: digest.project.day,
    body: content,
    client: digest.project.client,
    recapId: recap.id,
  })

  return { projectId: digest.projectId, recapId: recap.id, day: digest.project.day, content }
}

// ---------------- reconciliation ----------------

export interface ReconciliationResult {
  projectId: string
  consistent: boolean
  drift: number
  note: string
  breakdown: LedgerCheck['breakdown']
}

/**
 * Ledger consistency recompute — same projection the invoices module feeds
 * the 3-way match chip (computeLedgerConsistency, imported). Emits
 * 'ledger.reconciled' so the notification center records the outcome.
 */
export async function runReconciliation(projectId?: string | null): Promise<ReconciliationResult> {
  const pid = await resolveProjectId(projectId)

  const [transactions, wallet, milestones, invoices] = await Promise.all([
    db.transaction.findMany({ where: { projectId: pid }, orderBy: { date: 'desc' } }),
    db.escrowWallet.findUnique({ where: { projectId: pid } }),
    db.milestone.findMany({ where: { projectId: pid }, select: { id: true, status: true } }),
    db.invoice.findMany({ where: { projectId: pid }, select: { status: true, paymentReference: true } }),
  ])

  const check = computeLedgerConsistency({
    walletBalance: wallet?.balance ?? 0,
    transactions: transactions.map((t) => ({
      type: t.type,
      method: t.method,
      amount: t.amount,
      reference: t.reference,
    })),
    releasedMilestoneIds: milestones.filter((m) => m.status === 'released').map((m) => m.id),
    paidInvoiceReferences: invoices
      .filter((i) => i.status === 'paid')
      .map((i) => i.paymentReference ?? ''),
  })

  await emit(pid, 'ledger.reconciled', {
    consistent: check.consistent,
    drift: check.drift,
    note: check.note,
  })

  return { projectId: pid, consistent: check.consistent, drift: check.drift, note: check.note, breakdown: check.breakdown }
}

// ---------------- overdue.check ----------------

export interface OverdueCheckResult {
  projectId: string
  overdueTasks: Array<{ id: string; title: string; dueDate: string; phase: string }>
  absentWorkers: Array<{ id: string; name: string }>
}

/**
 * Overdue tasks + absent workers today → 'project.delayed' and
 * 'attendance.absent' events (each notifies the contractor via policy).
 */
export async function runOverdueCheck(projectId?: string | null): Promise<OverdueCheckResult> {
  const pid = await resolveProjectId(projectId)
  const today = todayEAT()
  const startOfToday = new Date(`${today}T00:00:00.000Z`)

  const [overdueTasks, workers, todayAttendance] = await Promise.all([
    db.task.findMany({
      where: {
        phase: { projectId: pid },
        dueDate: { lt: startOfToday },
        status: { in: ['pending', 'in_progress', 'blocked'] },
      },
      include: { phase: true },
      orderBy: { dueDate: 'asc' },
      take: 20,
    }),
    db.worker.findMany({ where: { projectId: pid, active: true } }),
    db.attendance.findMany({ where: { projectId: pid, date: today } }),
  ])

  const presentWorkerIds = new Set(todayAttendance.filter((a) => a.status !== 'absent').map((a) => a.workerId))
  const absentWorkers = workers
    .filter((w) => !presentWorkerIds.has(w.id))
    .map((w) => ({ id: w.id, name: w.name }))

  if (overdueTasks.length > 0) {
    await emit(pid, 'project.delayed', {
      count: overdueTasks.length,
      detail: `Overdue: ${overdueTasks.slice(0, 5).map((t) => `${t.title} (was due ${t.dueDate?.toISOString().slice(0, 10) ?? '?'})`).join('; ')}${overdueTasks.length > 5 ? ` +${overdueTasks.length - 5} more` : ''}`,
      taskIds: overdueTasks.map((t) => t.id),
    })
  }

  if (absentWorkers.length > 0) {
    await emit(pid, 'attendance.absent', {
      count: absentWorkers.length,
      detail: `No check-in today (${today}): ${absentWorkers.slice(0, 5).map((w) => w.name).join(', ')}${absentWorkers.length > 5 ? ` +${absentWorkers.length - 5} more` : ''}`,
      workerIds: absentWorkers.map((w) => w.id),
    })
  }

  return {
    projectId: pid,
    overdueTasks: overdueTasks.map((t) => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? '',
      phase: t.phase.name,
    })),
    absentWorkers,
  }
}

// ---------------- budget.check ----------------

export interface BudgetCheckResult {
  projectId: string
  spent: number
  budget: number
  pacePct: number
  level: 'ok' | 'watch' | 'over'
}

/**
 * Budget pace watch: spend vs project budget. >90% → 'watch', >100% → 'over';
 * both emit 'budget.alert' (policy notifies the contractor).
 */
export async function runBudgetCheck(projectId?: string | null): Promise<BudgetCheckResult> {
  const pid = await resolveProjectId(projectId)
  const [project, agg] = await Promise.all([
    db.project.findUnique({ where: { id: pid } }),
    db.transaction.aggregate({ where: { projectId: pid }, _sum: { amount: true } }),
  ])
  if (!project) throw new Error('Project not found')

  const spent = agg._sum.amount ?? 0
  const budget = project.budget
  const pacePct = budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 0
  const level: BudgetCheckResult['level'] = pacePct > 100 ? 'over' : pacePct > 90 ? 'watch' : 'ok'

  if (level !== 'ok') {
    await emit(pid, 'budget.alert', {
      pct: pacePct,
      level,
      note: `Spend KSh ${Math.round(spent).toLocaleString('en-KE')} of KSh ${Math.round(budget).toLocaleString('en-KE')} budget (${pacePct}%).${level === 'over' ? ' Budget is already exceeded — review expenses before more commitments.' : ' Above 90% — remaining spend should go through approval bands.'}`,
      spent,
      budget,
    })
  }

  return { projectId: pid, spent, budget, pacePct, level }
}

// ---------------- registry ----------------

export type JobType =
  | 'anomaly_scan'
  | 'digest.weekly'
  | 'recap.daily'
  | 'reconciliation'
  | 'overdue.check'
  | 'budget.check'

export const JOB_TYPES: readonly JobType[] = [
  'anomaly_scan', 'digest.weekly', 'recap.daily', 'reconciliation', 'overdue.check', 'budget.check',
]

/** Handler registry — the job runner dispatches on these. */
export const JOB_HANDLERS: Record<JobType, (payload: Record<string, unknown>, projectId?: string | null) => Promise<unknown>> = {
  anomaly_scan: (_payload, projectId) => runAnomalyScan(projectId),
  'digest.weekly': (_payload, projectId) => runWeeklyDigest(projectId),
  'recap.daily': (_payload, projectId) => runDailyRecap(projectId),
  reconciliation: (_payload, projectId) => runReconciliation(projectId),
  'overdue.check': (_payload, projectId) => runOverdueCheck(projectId),
  'budget.check': (_payload, projectId) => runBudgetCheck(projectId),
}
