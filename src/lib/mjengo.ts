import { db } from '@/lib/db'
import { logAudit, summarizeAction, kindForAction } from '@/lib/audit'
import { TRUST_ACTIONS, applyTrustAction } from '@/lib/actions/trust'
import { MONEY_ACTIONS, applyMoneyAction } from '@/lib/actions/money'
import { EVIDENCE_ACTIONS, applyEvidenceAction } from '@/lib/actions/evidence'
import { LAND_ACTIONS, applyLandAction } from '@/lib/actions/land'
import { PROFESSIONALS_ACTIONS, applyProfessionalsAction } from '@/lib/actions/professionals'
import { SUPPLY_ACTIONS, applySupplyAction } from '@/lib/actions/supply'
import { INVOICE_ACTIONS, applyInvoiceAction } from '@/lib/actions/invoices'
import { INTEL_ACTIONS, applyIntelAction } from '@/lib/actions/intel'
import { loadLandSlice } from '@/modules/land/repository'
import { loadProfessionalsSlice } from '@/modules/professionals/repository'
import { loadSupplySlice } from '@/modules/supply/repository'
import { loadInvoicesSlice } from '@/modules/invoices/repository'
import { loadIntelSlice } from '@/modules/intel/repository'
import type { LandSlice } from '@/modules/land/types'
import type { ProfessionalsSlice } from '@/modules/professionals/types'
import type { SupplySlice } from '@/modules/supply/types'
import type { InvoicesSlice } from '@/modules/invoices/types'
import type { IntelSlice } from '@/modules/intel/types'
import type {
  Alert, Attendance, AuditEvent, Consumption, Delivery, EscrowWallet, Material, Milestone, Notification, Phase, PhotoComment, Project, Recap, SitePhoto, SiteZone, Task, Transaction, VariationOrder, Worker,
} from '@prisma/client'

// ---------------- Types (client contract) ----------------

export interface PhaseWithTasks extends Phase {
  tasks: Task[]
  progress: number
}

export interface WorkerWithAttendance extends Worker {
  attendances: Attendance[]
  todayStatus: { status: string | null; checkIn: string | null; checkOut: string | null; method: string | null; wage: number; paid: boolean; verification: string | null; exceptionReason: string | null }
  weekEarnings: number
}

export interface MaterialRow extends Material {
  deliveredQty: number
  deliveredCost: number
  consumedQty: number
  onSiteQty: number
  stockValue: number
  deliveries: Delivery[]
}

export interface ProjectSummary {
  dayCount: number
  daysRemaining: number
  progressPct: number
  budgetTotal: number
  budgetSpent: number
  budgetSpentPct: number
  plannedSpendPct: number
  spendVsPlanDelta: number
  fundisToday: number
  fundisExpected: number
  wagesToday: number
  wagesUnpaid: number
  fundisVerified: number
  fundisReported: number
  fundisException: number
  wagesVerified: number
  wagesPendingReview: number
  materialSpend: number
  spendTrend: { label: string; planned: number; actual: number }[]
  unackedAlerts: number
}

export interface ProjectPayload {
  project: Project
  phases: PhaseWithTasks[]
  workers: WorkerWithAttendance[]
  materials: MaterialRow[]
  consumptions: (Consumption & { materialName: string; unit: string })[]
  deliveries: Delivery[]
  photos: (SitePhoto & { phaseName: string | null })[]
  alerts: Alert[]
  transactions: Transaction[]
  recaps: Recap[]
  summary: ProjectSummary
  escrow: EscrowWallet | null
  milestones: Milestone[]
  variations: VariationOrder[]
  zones: SiteZone[]
  notifications: Notification[]
  auditEvents: AuditEvent[]
  photoComments: PhotoComment[]
  // v2 domain slices (land / professionals / supply / invoices / intel)
  land: LandSlice
  professionals: ProfessionalsSlice
  supply: SupplySlice
  invoices: InvoicesSlice
  intel: IntelSlice
}

export interface ProjectListItem {
  id: string; name: string; client: string; clientType: string; location: string;
  status: string; startDate: string; targetDate: string;
  budgetTotal: number; budgetSpent: number; progressPct: number; dayCount: number;
  fundisCount: number; unackedAlerts: number; photoCount: number;
}

// ---------------- Helpers ----------------

function todayStr() {
  const d = new Date()
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10) // EAT
}

/** Resolve a project id: explicit arg > payload.projectId > first project (createdAt asc). */
export async function resolveProjectId(projectId?: string | null, payload?: any): Promise<string> {
  const candidate = projectId || payload?.projectId || null
  if (candidate) {
    const found = await db.project.findUnique({ where: { id: String(candidate) } })
    if (!found) throw new Error('Project not found')
    return found.id
  }
  const first = await db.project.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!first) throw new Error('No project found')
  return first.id
}

/** Lightweight roster of every project (for switchers / dashboards). */
export async function getProjectsList(): Promise<ProjectListItem[]> {
  const [projects, phases, transactions, workers, alerts, photos] = await Promise.all([
    db.project.findMany({ orderBy: { createdAt: 'asc' } }),
    db.phase.findMany({ include: { tasks: true } }),
    db.transaction.findMany(),
    db.worker.findMany(),
    db.alert.findMany(),
    db.sitePhoto.findMany(),
  ])
  return projects.map((p) => {
    const pPhases = phases.filter((f) => f.projectId === p.id)
    const pTx = transactions.filter((t) => t.projectId === p.id)
    const pWorkers = workers.filter((w) => w.projectId === p.id)
    const pAlerts = alerts.filter((a) => a.projectId === p.id)
    const pPhotos = photos.filter((ph) => ph.projectId === p.id)
    return {
      id: p.id,
      name: p.name,
      client: p.client,
      clientType: p.clientType,
      location: p.location,
      status: p.status,
      startDate: p.startDate.toISOString(),
      targetDate: p.targetDate.toISOString(),
      budgetTotal: pPhases.reduce((s, f) => s + f.budget, 0),
      budgetSpent: pTx.reduce((s, t) => s + t.amount, 0),
      progressPct: overallProgress(pPhases),
      dayCount: Math.max(1, Math.ceil((Date.now() - p.startDate.getTime()) / 86400000)),
      fundisCount: pWorkers.length,
      unackedAlerts: pAlerts.filter((a) => !a.acknowledged).length,
      photoCount: pPhotos.length,
    }
  })
}

function phaseProgress(p: Phase & { tasks: Task[] }): number {
  if (p.progressManual !== null && p.progressManual !== undefined) return p.progressManual
  if (!p.tasks.length) return 0
  return Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length)
}

export function overallProgress(phases: Array<Phase & { tasks: Task[] }>): number {
  const totalBudget = phases.reduce((s, p) => s + p.budget, 0)
  if (!totalBudget) return 0
  return Math.round(
    (phases.reduce((s, p) => s + (phaseProgress(p) / 100) * p.budget, 0) / totalBudget) * 100,
  )
}

// ---------------- Payload ----------------

/**
 * Full project payload. With an explicit projectId, scopes to that project
 * (returns null if it doesn't exist); without one, falls back to the first
 * project for backward compatibility.
 */
export async function getProjectPayload(projectId?: string | null): Promise<ProjectPayload | null> {
  const project = projectId
    ? await db.project.findUnique({ where: { id: String(projectId) } })
    : await db.project.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!project) return null

  const [phases, workers, materials, deliveries, consumptions, photos, alerts, transactions, recaps, escrow, milestones, variations, zones, notifications, auditEvents, photoComments] =
    await Promise.all([
      db.phase.findMany({ where: { projectId: project.id }, orderBy: { order: 'asc' }, include: { tasks: { orderBy: { createdAt: 'asc' } } } }),
      db.worker.findMany({ where: { projectId: project.id }, orderBy: { name: 'asc' }, include: { attendances: { orderBy: { date: 'desc' } } } }),
      db.material.findMany({ orderBy: { name: 'asc' } }),
      db.delivery.findMany({ where: { projectId: project.id }, orderBy: { date: 'desc' } }),
      db.consumption.findMany({ where: { projectId: project.id }, orderBy: { date: 'desc' } }),
      db.sitePhoto.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' } }),
      db.alert.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' } }),
      db.transaction.findMany({ where: { projectId: project.id }, orderBy: { date: 'desc' } }),
      db.recap.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
      db.escrowWallet.findUnique({ where: { projectId: project.id } }),
      db.milestone.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } }),
      db.variationOrder.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' } }),
      db.siteZone.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } }),
      db.notification.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 60 }),
      db.auditEvent.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' }, take: 120 }),
      db.photoComment.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'desc' } }),
    ])

  const today = todayStr()

  // Materials rollup
  const materialRows: MaterialRow[] = materials.map((m) => {
    const md = deliveries.filter((d) => d.materialId === m.id)
    const deliveredQty = md.reduce((s, d) => s + d.quantity, 0)
    const deliveredCost = md.reduce((s, d) => s + d.totalCost, 0)
    const consumedQty = consumptions.filter((c) => c.materialId === m.id).reduce((s, c) => s + c.quantity, 0)
    const onSiteQty = Math.max(0, deliveredQty - consumedQty)
    return {
      ...m,
      deliveredQty,
      deliveredCost,
      consumedQty,
      onSiteQty,
      stockValue: onSiteQty * m.unitPrice,
      deliveries: md,
    }
  })

  // Workers today + week earnings
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 6)
  const workerRows: WorkerWithAttendance[] = workers.map((w) => {
    const t = w.attendances.find((a) => a.date === today)
    const weekEarnings = w.attendances
      .filter((a) => new Date(a.date) >= weekAgo)
      .reduce((s, a) => s + a.wage, 0)
    return {
      ...w,
      attendances: w.attendances.slice(0, 14),
      todayStatus: {
        status: t?.status ?? null,
        checkIn: t?.checkIn?.toISOString() ?? null,
        checkOut: t?.checkOut?.toISOString() ?? null,
        method: t?.method ?? null,
        wage: t?.wage ?? 0,
        paid: t?.paid ?? false,
        verification: t?.verification ?? null,
        exceptionReason: t?.exceptionReason ?? null,
      },
      weekEarnings,
    }
  })

  // Summary + trend
  const dayCount = Math.max(
    1,
    Math.ceil((Date.now() - project.startDate.getTime()) / 86400000),
  )
  const totalDays = Math.max(
    dayCount,
    Math.ceil((project.targetDate.getTime() - project.startDate.getTime()) / 86400000),
  )
  const budgetSpent = transactions.reduce((s, t) => s + t.amount, 0)
  const budgetTotal = phases.reduce((s, p) => s + p.budget, 0)
  const progressPct = overallProgress(phases)

  // Weekly spend trend (planned linear vs actual cumulative)
  const weeksTotal = Math.max(2, Math.ceil(totalDays / 7))
  const currentWeek = Math.min(weeksTotal, Math.ceil(dayCount / 7))
  const spendTrend: ProjectSummary['spendTrend'] = []
  for (let w = 1; w <= currentWeek; w++) {
    const planned = Math.round((w / weeksTotal) * budgetTotal)
    const cutoff = new Date(project.startDate.getTime() + w * 7 * 86400000)
    cutoff.setHours(23, 59, 59, 999)
    const actual = transactions.filter((t) => t.date <= cutoff).reduce((s, t) => s + t.amount, 0)
    spendTrend.push({ label: `W${w}`, planned, actual })
  }

  const fundisToday = workerRows.filter((w) => w.todayStatus.status && w.todayStatus.status !== 'absent').length
  const wagesToday = workerRows.reduce((s, w) => s + w.todayStatus.wage, 0)
  const allAttendances = workers.flatMap((w) => w.attendances)
  const wagesUnpaid = allAttendances.filter((a) => !a.paid).reduce((s, a) => s + a.wage, 0)
  const plannedSpendPct = Math.round((dayCount / totalDays) * 100)

  // v2 domain slices (land / professionals / supply / invoices / intel)
  const [land, professionals, supply, invoices, intel] = await Promise.all([
    loadLandSlice(project.id),
    loadProfessionalsSlice(project.id),
    loadSupplySlice(project.id),
    loadInvoicesSlice(project.id),
    loadIntelSlice(project.id),
  ])

  // Workforce Trust: reported vs verified presence (today)
  const todayRows = allAttendances.filter((a) => a.date === today && a.status !== 'absent' && a.status !== 'excused')
  const fundisVerified = todayRows.filter((a) => a.verification === 'verified').length
  const fundisReported = todayRows.filter((a) => a.verification === 'reported').length
  const fundisException = todayRows.filter((a) => a.verification === 'exception').length
  const wagesVerified = todayRows.filter((a) => a.verification === 'verified').reduce((s, a) => s + a.wage, 0)
  const wagesPendingReview = todayRows.filter((a) => a.verification !== 'verified').reduce((s, a) => s + a.wage, 0)

  return {
    project,
    phases: phases.map((p) => ({ ...p, tasks: p.tasks, progress: phaseProgress(p) })),
    workers: workerRows,
    materials: materialRows,
    consumptions: consumptions.map((c) => ({
      ...c,
      materialName: materials.find((m) => m.id === c.materialId)?.name ?? 'Unknown',
      unit: materials.find((m) => m.id === c.materialId)?.unit ?? '',
    })),
    deliveries,
    photos: photos.map((ph) => ({
      ...ph,
      phaseName: phases.find((p) => p.id === ph.phaseId)?.name ?? null,
    })),
    alerts,
    transactions,
    recaps,
    summary: {
      dayCount,
      daysRemaining: Math.max(0, totalDays - dayCount),
      progressPct,
      budgetTotal,
      budgetSpent,
      budgetSpentPct: budgetTotal ? Math.round((budgetSpent / budgetTotal) * 100) : 0,
      plannedSpendPct,
      spendVsPlanDelta: budgetTotal ? Math.round(((budgetSpent - (plannedSpendPct / 100) * budgetTotal) / budgetTotal) * 100) : 0,
      fundisToday,
      fundisExpected: workerRows.filter((w) => w.active).length,
      wagesToday,
      wagesUnpaid,
      materialSpend: transactions.filter((t) => t.type === 'material').reduce((s, t) => s + t.amount, 0),
      spendTrend,
      unackedAlerts: alerts.filter((a) => !a.acknowledged).length,
      fundisVerified,
      fundisReported,
      fundisException,
      wagesVerified,
      wagesPendingReview,
    },
    escrow,
    milestones,
    variations,
    zones,
    notifications,
    auditEvents,
    photoComments,
    land,
    professionals,
    supply,
    invoices,
    intel,
  }
}

// ---------------- Action dispatcher (online + offline sync) ----------------

export type ActionType =
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'phase.update'
  | 'phase.create'
  | 'delivery.create'
  | 'consumption.create'
  | 'attendance.checkin'
  | 'attendance.setStatus'
  | 'worker.create'
  | 'worker.update'
  | 'wages.pay'
  | 'expense.create'
  | 'transaction.delete'
  | 'material.create'
  | 'project.update'
  | 'share.regenerate'
  | 'alert.ack'
  | 'photo.apply'
  | (typeof TRUST_ACTIONS)[number]
  | (typeof MONEY_ACTIONS)[number]
  | (typeof EVIDENCE_ACTIONS)[number]
  | (typeof LAND_ACTIONS)[number]
  | (typeof PROFESSIONALS_ACTIONS)[number]
  | (typeof SUPPLY_ACTIONS)[number]
  | (typeof INVOICE_ACTIONS)[number]
  | (typeof INTEL_ACTIONS)[number]

export async function applyAction(type: ActionType, payload: any, projectIdArg?: string): Promise<any> {
  // Project resolution: explicit projectId arg > payload.projectId > first project
  const projectId = await resolveProjectId(projectIdArg, payload)

  // Optional actor override (used by the public share route / client role); never reaches handlers
  const { __actor, __role, ...cleanPayload } = payload ?? {}

  let result: any
  if ((TRUST_ACTIONS as readonly string[]).includes(type)) {
    result = await applyTrustAction(type, cleanPayload, projectId)
  } else if ((MONEY_ACTIONS as readonly string[]).includes(type)) {
    result = await applyMoneyAction(type, cleanPayload, projectId)
  } else if ((EVIDENCE_ACTIONS as readonly string[]).includes(type)) {
    result = await applyEvidenceAction(type, cleanPayload, projectId)
  } else if ((LAND_ACTIONS as readonly string[]).includes(type)) {
    result = await applyLandAction(type, cleanPayload, projectId)
  } else if ((PROFESSIONALS_ACTIONS as readonly string[]).includes(type)) {
    result = await applyProfessionalsAction(type, cleanPayload, projectId)
  } else if ((SUPPLY_ACTIONS as readonly string[]).includes(type)) {
    result = await applySupplyAction(type, cleanPayload, projectId)
  } else if ((INVOICE_ACTIONS as readonly string[]).includes(type)) {
    result = await applyInvoiceAction(type, cleanPayload, projectId)
  } else if ((INTEL_ACTIONS as readonly string[]).includes(type)) {
    result = await applyIntelAction(type, cleanPayload, projectId)
  } else {
    result = await applyCoreAction(type, cleanPayload, projectId)
  }

  // Bias-Free Ledger: every successful action is logged, append-only
  await logAudit(
    projectId,
    kindForAction(type),
    { name: __actor ?? 'Site Manager', role: __role ?? 'contractor' },
    summarizeAction(type, cleanPayload, result),
    { type },
  )
  return result
}

async function applyCoreAction(type: ActionType, payload: any, projectId: string): Promise<any> {
  switch (type) {
    case 'task.create': {
      const { phaseId, title } = payload
      if (!phaseId || !title) throw new Error('phaseId and title required')
      const task = await db.task.create({ data: { phaseId, title, status: 'pending', progress: 0 } })
      return { id: task.id }
    }

    case 'task.update': {
      const { id, status, progress } = payload
      if (!id) throw new Error('task id required')
      const data: Partial<Task> = {}
      if (typeof status === 'string') data.status = status
      if (typeof progress === 'number') {
        data.progress = Math.max(0, Math.min(100, Math.round(progress)))
        if (data.progress === 100) data.status = 'done'
        if (data.progress > 0 && data.status === undefined && status === undefined) {
          const existing = await db.task.findUnique({ where: { id } })
          if (existing && existing.status === 'pending') data.status = 'in_progress'
        }
      }
      const task = await db.task.update({ where: { id }, data })
      return { id: task.id }
    }

    case 'phase.update': {
      const { id, status, progressManual } = payload
      if (!id) throw new Error('phase id required')
      const data: Partial<Phase> = {}
      if (typeof status === 'string') data.status = status
      if (typeof progressManual === 'number') data.progressManual = Math.max(0, Math.min(100, Math.round(progressManual)))
      const phase = await db.phase.update({ where: { id }, data })
      return { id: phase.id }
    }

    case 'phase.create': {
      const { name, budget, order } = payload
      if (!name || typeof name !== 'string' || !name.trim()) throw new Error('phase name required')
      if (typeof budget !== 'number' || budget < 0) throw new Error('budget (number >= 0) required')
      const last = await db.phase.findFirst({ where: { projectId }, orderBy: { order: 'desc' } })
      const phase = await db.phase.create({
        data: {
          projectId,
          name: name.trim(),
          order: typeof order === 'number' && order > 0 ? Math.round(order) : (last?.order ?? 0) + 1,
          budget,
          status: 'pending',
        },
      })
      return { id: phase.id }
    }

    case 'task.delete': {
      const { id } = payload
      if (!id) throw new Error('task id required')
      const task = await db.task.delete({ where: { id } })
      return { id: task.id }
    }

    case 'delivery.create': {
      const { materialId, quantity, unitCost, supplier, source, rawTranscript, date } = payload
      if (!materialId || typeof quantity !== 'number' || quantity <= 0) throw new Error('materialId and positive quantity required')
      const material = await db.material.findUnique({ where: { id: materialId } })
      if (!material) throw new Error('Unknown material')
      const cost = typeof unitCost === 'number' && unitCost > 0 ? unitCost : material.unitPrice
      const delivery = await db.delivery.create({
        data: {
          projectId,
          materialId,
          quantity,
          unitCost: cost,
          totalCost: quantity * cost,
          supplier: supplier || 'Unknown supplier',
          date: date ? new Date(date) : new Date(),
          source: source || 'manual',
          rawTranscript: rawTranscript || null,
        },
      })
      await db.transaction.create({
        data: {
          projectId,
          type: 'material',
          amount: delivery.totalCost,
          method: 'mpesa',
          reference: `AUTO-${delivery.id.slice(-6).toUpperCase()}`,
          note: `${material.name} × ${quantity} ${material.unit} — ${delivery.supplier}`,
          date: delivery.date,
        },
      })
      return { id: delivery.id }
    }

    case 'consumption.create': {
      const { materialId, quantity, phaseName, note } = payload
      if (!materialId || typeof quantity !== 'number' || quantity <= 0) throw new Error('materialId and positive quantity required')
      const c = await db.consumption.create({
        data: { projectId, materialId, quantity, phaseName: phaseName || null, note: note || null, date: new Date() },
      })
      return { id: c.id }
    }

    case 'attendance.checkin': {
      const { workerId, toggle } = payload // toggle: 'in' | 'out'
      if (!workerId) throw new Error('workerId required')
      const worker = await db.worker.findUnique({ where: { id: workerId } })
      if (!worker) throw new Error('Unknown worker')
      const today = todayStr()
      let att = await db.attendance.findFirst({ where: { workerId, date: today } })
      if (!att) {
        if (toggle === 'out') throw new Error('No open attendance for today')
        att = await db.attendance.create({
          data: {
            workerId, projectId, date: today, checkIn: new Date(), status: 'present',
            method: payload.method || 'geofence', wage: worker.dailyRate,
            verification: 'verified', // worker-initiated check-in carries device evidence
            evidence: JSON.stringify([payload.method === 'ussd' ? 'ussd' : payload.method === 'kiosk_pin' ? 'pin' : 'gps', 'device']),
          },
        })
      } else if (toggle === 'out' && !att.checkOut) {
        att = await db.attendance.update({ where: { id: att.id }, data: { checkOut: new Date() } })
      } else if (toggle === 'in' && !att.checkIn) {
        att = await db.attendance.update({ where: { id: att.id }, data: { checkIn: new Date(), status: 'present', wage: worker.dailyRate } })
      }
      return { id: att.id }
    }

    case 'attendance.setStatus': {
      const { workerId, status } = payload // present | absent | half_day
      if (!workerId || !['present', 'absent', 'half_day'].includes(status)) throw new Error('workerId and valid status required')
      const worker = await db.worker.findUnique({ where: { id: workerId } })
      if (!worker) throw new Error('Unknown worker')
      const today = todayStr()
      const wage = status === 'present' ? worker.dailyRate : status === 'half_day' ? worker.dailyRate * 0.5 : 0
      let att = await db.attendance.findFirst({ where: { workerId, date: today } })
      if (!att) {
        att = await db.attendance.create({
          data: {
            workerId, projectId, date: today, status, wage,
            checkIn: status === 'absent' ? null : new Date(),
            method: payload.method || 'app',
            verification: 'reported', // manager-set status is reported, not verified
            recordedBy: payload.recordedBy || 'Site Manager',
          },
        })
      } else {
        const overrideLog = JSON.parse(att.overrideLog || '[]') as Array<Record<string, unknown>>
        if (att.status !== status) {
          overrideLog.push({ at: new Date().toISOString(), by: payload.recordedBy || 'Site Manager', from: att.status, to: status, reason: payload.reason || 'status corrected' })
        }
        att = await db.attendance.update({
          where: { id: att.id },
          data: { status, wage, overrideLog: JSON.stringify(overrideLog) },
        })
      }
      return { id: att.id }
    }

    case 'worker.create': {
      const { name, role, phone, dailyRate, pin } = payload
      if (!name) throw new Error('name required')
      const w = await db.worker.create({
        data: { projectId, name, role: role || 'Mtumishi (Labourer)', phone: phone || '', dailyRate: Number(dailyRate) || 800, pin: typeof pin === 'string' && /^\d{4}$/.test(pin) ? pin : null },
      })
      return { id: w.id }
    }

    case 'worker.update': {
      const { id, name, role, phone, dailyRate, active, pin } = payload
      if (!id) throw new Error('worker id required')
      const existing = await db.worker.findUnique({ where: { id } })
      if (!existing) throw new Error('Worker not found')
      const data: Partial<Worker> = {}
      if (typeof name === 'string' && name.trim()) data.name = name.trim()
      if (typeof role === 'string' && role.trim()) data.role = role.trim()
      if (typeof phone === 'string') data.phone = phone
      if (typeof dailyRate === 'number' && dailyRate >= 0) data.dailyRate = dailyRate
      if (typeof active === 'boolean') data.active = active
      if (typeof pin === 'string') data.pin = /^\d{4}$/.test(pin) ? pin : null
      const w = await db.worker.update({ where: { id }, data })
      return { id: w.id }
    }

    case 'project.update': {
      const { id, name, client, clientType, location, budget, startDate, targetDate, status } = payload
      if (!id) throw new Error('project id required')
      const existing = await db.project.findUnique({ where: { id } })
      if (!existing) throw new Error('Project not found')
      const data: Partial<Project> = {}
      if (typeof name === 'string' && name.trim()) data.name = name.trim()
      if (typeof client === 'string' && client.trim()) data.client = client.trim()
      if (typeof clientType === 'string' && ['diaspora', 'local', 'company'].includes(clientType)) data.clientType = clientType
      if (typeof location === 'string' && location.trim()) data.location = location.trim()
      if (typeof startDate === 'string') data.startDate = new Date(startDate)
      if (typeof targetDate === 'string') data.targetDate = new Date(targetDate)
      if (typeof status === 'string' && ['active', 'completed', 'on_hold'].includes(status)) data.status = status
      if (typeof budget === 'number' && budget > 0) {
        data.budget = budget
        // Phase budgets are the source of truth for budgetTotal — rescale them
        // proportionally so the roll-up matches the new project budget.
        const phases = await db.phase.findMany({ where: { projectId: id }, orderBy: { order: 'asc' } })
        const currentTotal = phases.reduce((s, p) => s + p.budget, 0)
        if (currentTotal > 0 && phases.length) {
          const scale = budget / currentTotal
          for (const p of phases) {
            await db.phase.update({ where: { id: p.id }, data: { budget: Math.round(p.budget * scale) } })
          }
        }
      }
      const project = await db.project.update({ where: { id }, data })
      return { id: project.id }
    }

    case 'expense.create': {
      const { type, amount, method, note, reference, date } = payload
      if (!['material', 'wage', 'other', 'transport'].includes(type)) throw new Error("type must be 'material' | 'wage' | 'other' | 'transport'")
      if (typeof amount !== 'number' || !(amount > 0)) throw new Error('amount must be a positive number')
      const tx = await db.transaction.create({
        data: {
          projectId,
          type,
          amount,
          method: ['mpesa', 'cash', 'bank'].includes(method) ? method : 'mpesa',
          note: note || null,
          reference: reference || null,
          date: date ? new Date(date) : new Date(),
        },
      })
      return { id: tx.id }
    }

    case 'transaction.delete': {
      const { id } = payload
      if (!id) throw new Error('transaction id required')
      const tx = await db.transaction.delete({ where: { id } })
      return { id: tx.id }
    }

    case 'material.create': {
      const { name, unit, unitPrice } = payload
      if (!name || typeof name !== 'string' || !name.trim()) throw new Error('material name required')
      if (!unit || typeof unit !== 'string') throw new Error('unit required')
      if (typeof unitPrice !== 'number' || unitPrice < 0) throw new Error('unitPrice (number >= 0) required')
      // Global catalog — reject duplicate names case-insensitively (SQLite has no insensitive mode)
      const all = await db.material.findMany()
      if (all.some((m) => m.name.toLowerCase() === name.trim().toLowerCase())) {
        throw new Error(`Material "${name.trim()}" already exists in the catalog`)
      }
      const m = await db.material.create({ data: { name: name.trim(), unit, unitPrice } })
      return { id: m.id }
    }

    case 'wages.pay': {
      // payload: { workerIds?: string[] } — pays unpaid attendance wages for today (or given date)
      const date = payload?.date || todayStr()
      const where = { date, paid: false, projectId }
      const rows = await db.attendance.findMany({
        where: payload?.workerIds?.length ? { ...where, workerId: { in: payload.workerIds } } : where,
      })
      const unpaid = rows.filter((r) => r.wage > 0)
      if (!unpaid.length) return { paid: 0, amount: 0 }
      await db.attendance.updateMany({ where: { id: { in: unpaid.map((u) => u.id) } }, data: { paid: true } })
      const workers = await db.worker.findMany({ where: { id: { in: unpaid.map((u) => u.workerId) } } })
      const total = unpaid.reduce((s, u) => s + u.wage, 0)
      await db.transaction.create({
        data: {
          projectId,
          type: 'wage',
          amount: total,
          method: 'mpesa',
          reference: `B2C-${Date.now().toString().slice(-8)}`,
          note: `Wages ${date} — ${unpaid.map((u) => workers.find((w) => w.id === u.workerId)?.name.split(' ')[0]).join(', ')}`,
          date: new Date(),
        },
      })
      return { paid: unpaid.length, amount: total }
    }

    case 'share.regenerate': {
      // Rotate the read-only client share link (invalidates the old token)
      const { id } = payload
      if (!id) throw new Error('project id required')
      const existing = await db.project.findUnique({ where: { id } })
      if (!existing) throw new Error('Project not found')
      const shareToken = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}` // cuid-style
      const project = await db.project.update({ where: { id }, data: { shareToken } })
      return { shareToken: project.shareToken }
    }

    case 'alert.ack': {
      const { id } = payload
      if (!id) throw new Error('alert id required')
      await db.alert.update({ where: { id }, data: { acknowledged: true } })
      return { id }
    }

    case 'photo.apply': {
      // Apply AI photo analysis: { photoId, phaseId, progressPct, analysis (object), caption }
      const { photoId, phaseId, progressPct, analysis, caption, url } = payload
      let photo
      if (photoId) {
        photo = await db.sitePhoto.update({
          where: { id: photoId },
          data: {
            phaseId: phaseId || null,
            progressPct: typeof progressPct === 'number' ? progressPct : null,
            analysis: analysis ? JSON.stringify(analysis) : undefined,
          },
        })
      } else if (url) {
        photo = await db.sitePhoto.create({
          data: {
            projectId,
            phaseId: phaseId || null,
            url,
            caption: caption || 'AI-analyzed site photo',
            progressPct: typeof progressPct === 'number' ? progressPct : null,
            analysis: analysis ? JSON.stringify(analysis) : null,
          },
        })
      } else {
        throw new Error('photoId or url required')
      }
      // Bump phase progress if the photo shows more progress than recorded
      if (phaseId && typeof progressPct === 'number') {
        const phase = await db.phase.findUnique({ where: { id: phaseId } })
        if (phase) {
          const current = phase.progressManual ?? 0
          if (progressPct > current) {
            await db.phase.update({
              where: { id: phaseId },
              data: { progressManual: Math.min(100, progressPct), status: progressPct >= 100 ? 'done' : 'in_progress' },
            })
          }
        }
      }
      return { id: photo.id }
    }

    default:
      throw new Error(`Unknown action type: ${type}`)
  }
}
