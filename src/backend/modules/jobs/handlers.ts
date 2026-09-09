// Background jobs — handlers (spec §58).
//
// The shared cores for both the AI routes and the JobRecord queue:
//   · runAnomalyScan      — same logic as POST /api/ai/anomaly-scan
//   · runDailyRecap       — same logic as POST /api/ai/recap
//   · runWeeklyDigest     — reuses modules/intel generateDigest (imported)
//   · runReconciliation   — reuses invoices computeLedgerConsistency
//   · runOverdueCheck     — overdue tasks + absent workers today
//   · runBudgetCheck      — budget pace watch (90% / 100%)
//   · runDarajaReconcile  — wallet: re-drive missed M-Pesa STK callbacks
//                           (src/backend/modules/wallet/daraja-reconcile.ts)
//
// Handlers NEVER throw to the job runner (the runner catches + records the
// failure), always return a JSON-able result, and emit their domain events via
// the §59 bus — the event's default notification policy lands the bell row.

import { db } from '@/backend/lib/db'
import { buildProjectDigest, llm } from '@/backend/lib/ai'
import { emit } from '@/backend/modules/events/service'
import { generateDigest } from '@/backend/modules/intel/service'
import { computeLedgerConsistency } from '@/backend/modules/invoices/three-way'
import type { LedgerCheck } from '@/backend/modules/invoices/types'
import {
  computeAttendanceFraudFindings, computeCostVarianceFindings, computeDuplicatePurchaseFindings,
  overallProgress, type AttendanceAuditRow, type CostCategory, type DuplicateOrderRow, type EngineFinding,
} from '@/backend/modules/intel/engine'
import { runDarajaReconcile } from '@/backend/modules/wallet/daraja-reconcile'

/** Nairobi/EAT date string (UTC+3) — the platform's "today". */
function todayEAT(): string {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

/** EAT date string `days` days before now (attendance date strings are EAT-based). */
function dateEATAgo(days: number): string {
  return new Date(Date.now() + 3 * 3600 * 1000 - days * 86_400_000).toISOString().slice(0, 10)
}

/** Alert.type bucket per deterministic rule key (Doc A §16 attendance / §29 budget+cost). */
const RULE_ALERT_TYPE: Record<string, string> = {
  attendance_override_pattern: 'attendance',
  weekend_ghost_pattern: 'attendance',
  budget_category_overrun: 'budget',
  duplicate_purchase_watch: 'anomaly',
}

/** Transaction.type → §29 cost category (costCode can re-route to professional fees). */
function costCategoryOf(type: string, costCode: string | null): CostCategory {
  if (costCode && /professional|consult|architect|engineer|survey|design|fee/i.test(costCode)) return 'professional_fees'
  if (type === 'material') return 'materials'
  if (type === 'wage') return 'labour'
  if (type === 'transport') return 'transport'
  return 'other'
}

/** "Not yet delivered" for the duplicate rule: terminal status or a received delivery. */
const DUPLICATE_DELIVERED_STATUSES = ['delivered', 'closed']

/**
 * B4-INTEL deterministic rules (Doc A §16 anti-fraud attendance + §29 cost
 * control) — the same scan-invoked pattern as the LLM pass: fetch the rows,
 * run the pure engines, write Alert rows. Every finding carries its evidence
 * (counts, dates, amounts, and the budget basis) in the message. Alerts NEVER
 * auto-change money or records — humans decide.
 */
async function runDeterministicScanRules(projectId: string): Promise<EngineFinding[]> {
  const now = new Date()
  const windowStart = dateEATAgo(14)
  const historyStart = dateEATAgo(90)

  const [attendanceRows, weekendHistory, transactions, phases, boq, orders] = await Promise.all([
    db.attendance.findMany({
      where: { projectId, date: { gte: windowStart } },
      select: {
        date: true, status: true, workerId: true, overrideLog: true, recordedBy: true,
        worker: { select: { name: true } },
      },
    }),
    db.attendance.findMany({
      where: { projectId, date: { gte: historyStart, lt: windowStart } },
      select: { date: true, status: true },
    }),
    db.transaction.findMany({ where: { projectId }, select: { type: true, amount: true, costCode: true } }),
    db.phase.findMany({
      where: { projectId },
      select: { budget: true, progressManual: true, tasks: { select: { progress: true } } },
    }),
    db.boq.findMany({
      where: { projectId },
      orderBy: { version: 'desc' },
      include: { lines: { select: { qty: true, estUnitPrice: true } } },
    }),
    db.purchaseOrder.findMany({
      where: { projectId, createdAt: { gte: new Date(now.getTime() - 60 * 86_400_000) } },
      include: { lines: { select: { name: true, lineTotal: true } }, deliveries: { select: { receivedAt: true } } },
    }),
  ])

  // §16 rows — the last 14 days, with worker names for the ghost rule.
  const auditRows: AttendanceAuditRow[] = attendanceRows.map((a) => ({
    date: a.date,
    status: a.status,
    workerId: a.workerId,
    workerName: a.worker.name,
    recordedBy: a.recordedBy,
    isOverride: a.overrideLog !== null,
  }))

  // Weekend baseline from the PRIOR history window (before the 14-day window).
  let weekendRows = 0
  let weekendPresent = 0
  for (const a of weekendHistory) {
    const dow = new Date(`${a.date}T00:00:00.000Z`).getUTCDay()
    if (dow !== 0 && dow !== 6) continue
    weekendRows += 1
    if (a.status === 'present') weekendPresent += 1
  }

  // §29 spend grouped into the 5 categories from the Transaction ledger.
  const spendByCategory: Record<CostCategory, number> = {
    materials: 0, labour: 0, transport: 0, professional_fees: 0, other: 0,
  }
  for (const t of transactions) spendByCategory[costCategoryOf(t.type, t.costCode)] += t.amount

  // Overall progress + phase budget total on the SAME basis as risk rule R1.
  const phaseBudgetTotal = phases.reduce((s, p) => s + p.budget, 0)
  const progressPct = overallProgress(
    phases.map((p) => ({
      name: '',
      status: '',
      budget: p.budget,
      progressManual: p.progressManual,
      tasks: p.tasks.map((t) => ({ title: '', status: 'done', progress: t.progress, dueDate: null })),
    })),
  )

  // Budget basis: the latest APPROVED BOQ (a draft revision with partial lines
  // is not a budget); falls back to the newest version when none is approved.
  const boqRow =
    boq.find((b) => b.status === 'approved' && b.lines.some((l) => l.qty * l.estUnitPrice > 0)) ?? boq[0] ?? null
  const boqEstimate = boqRow
    ? {
      version: boqRow.version,
      status: boqRow.status,
      estTotal: boqRow.lines.reduce((s, l) => s + l.qty * l.estUnitPrice, 0),
    }
    : null

  const duplicateRows: DuplicateOrderRow[] = orders.map((o) => ({
    orderCode: o.orderCode,
    createdAt: o.createdAt,
    total: o.total,
    status: o.status,
    delivered:
      DUPLICATE_DELIVERED_STATUSES.includes(o.status) || o.deliveries.some((d) => d.receivedAt !== null),
    lines: o.lines.map((l) => ({ name: l.name, lineTotal: l.lineTotal })),
  }))

  return [
    ...computeAttendanceFraudFindings({ now, rows: auditRows, weekendBaseline: { rows: weekendRows, present: weekendPresent } }),
    ...computeCostVarianceFindings({ progressPct, phaseBudgetTotal, boq: boqEstimate, spendByCategory }),
    ...computeDuplicatePurchaseFindings(duplicateRows),
  ]
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
  /** Rule keys of the deterministic (non-LLM) findings this scan produced. */
  deterministicRules: string[]
  summary: string
}

/**
 * Anomaly scan shared core: reconcile deliveries vs consumption vs progress
 * vs budget, write up to 4 LLM Alert rows PLUS the B4-INTEL deterministic
 * anti-fraud/cost-control alerts (§16/§29 — attendance overrides, weekend
 * ghosts, category variance, duplicate purchases), then emit
 * 'anomaly.detected' (the event policy notifies the contractor — kind
 * 'anomaly' — so the bell surfaces it).
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

  // B4-INTEL deterministic rules (§16/§29) — every finding states its evidence
  // and rule key in the message, same Alert shape as the LLM pass above.
  const findings = await runDeterministicScanRules(digest.projectId)
  const deterministicRules: string[] = []
  for (const f of findings.slice(0, 6)) {
    const alert = await db.alert.create({
      data: {
        projectId: digest.projectId,
        type: RULE_ALERT_TYPE[f.rule] ?? 'anomaly',
        severity: ['info', 'warning', 'critical'].includes(f.severity) ? f.severity : 'info',
        title: f.title.slice(0, 140),
        message: `${f.message} Evidence: ${f.evidence}. [rule: ${f.rule}]`,
      },
    })
    created.push({ id: alert.id, type: alert.type, severity: alert.severity, title: alert.title })
    deterministicRules.push(f.rule)
  }

  const summaryParts = [result.summary ?? '']
  if (deterministicRules.length > 0) {
    const counts = new Map<string, number>()
    for (const r of deterministicRules) counts.set(r, (counts.get(r) ?? 0) + 1)
    summaryParts.push(
      `Deterministic rules (§16/§29): ${deterministicRules.length} finding(s) — ${Array.from(counts.entries()).map(([r, n]) => `${r}×${n}`).join(', ')}.`,
    )
  } else {
    summaryParts.push('Deterministic rules (§16/§29): 0 findings — attendance overrides, weekend ghosts, category variance and duplicate purchases all within their thresholds.')
  }
  const summary = summaryParts.filter(Boolean).join(' ')

  // §59 domain event → default policy → in-app notification (kind 'anomaly').
  await emit(digest.projectId, 'anomaly.detected', {
    count: created.length,
    summary,
    deterministicRules,
    severity: created.some((a) => a.severity === 'critical')
      ? 'critical'
      : created.some((a) => a.severity === 'warning') ? 'warning' : 'info',
  })

  return { projectId: digest.projectId, alerts: created, deterministicRules, summary }
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
 * HONEST in-app entry (channel in_app, deliveryStatus 'logged'): external
 * delivery is opt-in via the notify channel seam (NOTIFY_SMS_WEBHOOK_URL —
 * see modules/notify/channels.ts) and is attempted only when configured.
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
  overdueTasks: Array<{ id: string; title: string; dueDate: string; phase: string; blocked: boolean }>
  /** Overdue tasks that are also blocked (dependency/reason) — counted separately. */
  blockedCount: number
  absentWorkers: Array<{ id: string; name: string }>
  summary: string
}

/** A task counts as blocked when its status or recorded reason says so (Task v2, §11). */
function isBlockedTaskRow(t: { status: string; blockedReason: string | null }): boolean {
  return t.status === 'blocked' || Boolean(t.blockedReason)
}

/**
 * Overdue tasks + absent workers today → 'project.delayed' and
 * 'attendance.absent' events (each notifies the contractor via policy).
 * Overdue = dueDate before today AND status != done (§11 escalation);
 * blocked overdue tasks are counted separately in the message —
 * "3 overdue (1 blocked)" — so escalation tells blocked from late.
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
        status: { not: 'done' },
      },
      include: { phase: true },
      orderBy: { dueDate: 'asc' },
      take: 20,
    }),
    db.worker.findMany({ where: { projectId: pid, active: true } }),
    db.attendance.findMany({ where: { projectId: pid, date: today } }),
  ])

  const blockedCount = overdueTasks.filter(isBlockedTaskRow).length

  const presentWorkerIds = new Set(todayAttendance.filter((a) => a.status !== 'absent').map((a) => a.workerId))
  const absentWorkers = workers
    .filter((w) => !presentWorkerIds.has(w.id))
    .map((w) => ({ id: w.id, name: w.name }))

  if (overdueTasks.length > 0) {
    await emit(pid, 'project.delayed', {
      count: overdueTasks.length,
      blockedCount,
      detail: `${overdueTasks.length} overdue (${blockedCount} blocked): ${overdueTasks.slice(0, 5).map((t) => `${t.title} (was due ${t.dueDate?.toISOString().slice(0, 10) ?? '?'}${isBlockedTaskRow(t) ? ' · blocked' : ''})`).join('; ')}${overdueTasks.length > 5 ? ` +${overdueTasks.length - 5} more` : ''}`,
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
      blocked: isBlockedTaskRow(t),
    })),
    blockedCount,
    absentWorkers,
    summary: `${overdueTasks.length} overdue task(s) (${blockedCount} blocked), ${absentWorkers.length} absent worker(s)`,
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
  | 'wallet.reconcile'

export const JOB_TYPES: readonly JobType[] = [
  'anomaly_scan', 'digest.weekly', 'recap.daily', 'reconciliation', 'overdue.check', 'budget.check',
  'wallet.reconcile',
]

/** Handler registry — the job runner dispatches on these. */
export const JOB_HANDLERS: Record<JobType, (payload: Record<string, unknown>, projectId?: string | null) => Promise<unknown>> = {
  anomaly_scan: (_payload, projectId) => runAnomalyScan(projectId),
  'digest.weekly': (_payload, projectId) => runWeeklyDigest(projectId),
  'recap.daily': (_payload, projectId) => runDailyRecap(projectId),
  reconciliation: (_payload, projectId) => runReconciliation(projectId),
  'overdue.check': (_payload, projectId) => runOverdueCheck(projectId),
  'budget.check': (_payload, projectId) => runBudgetCheck(projectId),
  // Cross-project money sweep (no projectId — it scans every project's
  // daraja.intent:* rows). Idempotent by construction: it re-drives the
  // callback processor, whose dedupe + ledger idempotency key are the
  // safety rails. See wallet/daraja-reconcile.ts.
  'wallet.reconcile': () => runDarajaReconcile(),
}
