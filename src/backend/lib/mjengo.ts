import { randomBytes } from 'crypto'

import { db } from '@/backend/lib/db'
import { logAudit, summarizeAction, kindForAction } from '@/backend/lib/audit'
import { TRUST_ACTIONS, applyTrustAction } from '@/backend/actions/trust'
import { MONEY_ACTIONS, applyMoneyAction } from '@/backend/actions/money'
import { EVIDENCE_ACTIONS, applyEvidenceAction } from '@/backend/actions/evidence'
import { LAND_ACTIONS, applyLandAction } from '@/backend/actions/land'
import { PROFESSIONALS_ACTIONS, applyProfessionalsAction } from '@/backend/actions/professionals'
import { SUPPLY_ACTIONS, applySupplyAction } from '@/backend/actions/supply'
import { INVOICE_ACTIONS, applyInvoiceAction } from '@/backend/actions/invoices'
import { INVENTORY_ACTIONS, applyInventoryAction } from '@/backend/actions/inventory'
import { loadInventorySlice, loadBoqSlice } from '@/backend/modules/inventory/repository'
import { loadFinanceSlice } from '@/backend/modules/wallet/repository'
import { WALLET_ACTIONS, applyWalletAction } from '@/backend/actions/wallet'
import { spendExternalInTx, reverseTransaction as reverseTransactionService } from '@/backend/modules/wallet/service'
import { getProvider } from '@/backend/modules/wallet/providers'
import { currentActor } from '@/backend/modules/wallet/session'
import { INTEL_ACTIONS, applyIntelAction } from '@/backend/actions/intel'
import { loadLandSlice } from '@/backend/modules/land/repository'
import { loadProfessionalsSlice } from '@/backend/modules/professionals/repository'
import { loadSupplySlice } from '@/backend/modules/supply/repository'
import { loadInvoicesSlice } from '@/backend/modules/invoices/repository'
import { loadIntelSlice } from '@/backend/modules/intel/repository'
import type { LandSlice } from '@/backend/modules/land/types'
import type { ProfessionalsSlice } from '@/backend/modules/professionals/types'
import type { SupplySlice } from '@/backend/modules/supply/types'
import type { InvoicesSlice } from '@/backend/modules/invoices/types'
import type { IntelSlice } from '@/backend/modules/intel/types'
import type { InventorySlice, BoqSlice } from '@/backend/modules/inventory/types'
import type { FinanceSlice } from '@/backend/modules/wallet/types'
import { supplyCan, type SupplyAction, type SupplyRole } from '@/backend/modules/supply/policy'
import type {
  Alert, Attendance, AuditEvent, Consumption, Delivery, EscrowWallet, Material, Milestone, Notification, OrderDelivery, Phase, PhotoComment, Project, ProjectTeam, Recap, SitePhoto, SiteZone, Task, Transaction, VariationOrder, Worker,
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
  // v3 domain slices (inventory + money core)
  inventory: InventorySlice
  boq: BoqSlice
  finance: FinanceSlice
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

  const [phases, workers, materials, deliveries, consumptions, photos, alerts, transactions, recaps, escrow, milestones, variations, zones, notifications, auditEvents, photoComments, inventory, boq, finance] =
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
      loadInventorySlice(project.id),
      loadBoqSlice(project.id),
      loadFinanceSlice(project.id),
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
    inventory,
    boq,
    finance,
  }
}

// ---------------- B1 domain constants + helpers (Doc A §14/§26/§33) ----------------

/** Roles that may operate the delivery driver leg (§26). */
const DELIVERY_LEG_ROLES: readonly string[] = ['contractor', 'admin', 'supervisor']

/** Driver-leg actions gated above (§26). 'delivery.dispatch' is the supply action. */
const DELIVERY_LEG_ACTIONS: readonly string[] = ['delivery.assign', 'delivery.transit', 'delivery.arrive']

/** Roles that may manage the project team roster (§33). */
const TEAM_ROLES: readonly string[] = ['contractor', 'admin']

/** Team-roster actions gated above (§33). */
const TEAM_ACTIONS: readonly string[] = ['team.add', 'team.update', 'team.remove']

/** §33 professional roles a roster entry may carry. */
const PROJECT_TEAM_ROLES: readonly string[] = ['contractor', 'supervisor', 'qs', 'architect', 'engineer', 'surveyor', 'client_rep']

/** §14 employment terms. */
const WORKER_EMPLOYMENT_TYPES: readonly string[] = ['casual', 'contract', 'full_time']

/** §14 skills caps: max 10 skills, 40 characters each. */
const WORKER_SKILLS_MAX = 10
const WORKER_SKILL_MAX_LEN = 40

/**
 * Validate + normalize the §14 worker-profile fields (idNumber, employmentType,
 * skills, emergency contacts). All optional and additive: an absent field is
 * never touched; null/'' clears it. skills is stored JSON-stringified on the
 * Worker row (Prisma primitive, no list columns). Shared by worker.create and
 * worker.update so both speak the exact same validation.
 */
function workerProfileData(payload: Record<string, unknown>): Partial<Worker> {
  const data: Partial<Worker> = {}
  if (payload.idNumber !== undefined) {
    if (payload.idNumber === null || payload.idNumber === '') {
      data.idNumber = null
    } else {
      if (typeof payload.idNumber !== 'string') throw new Error('idNumber must be a string')
      const v = payload.idNumber.trim()
      if (!v) data.idNumber = null
      else if (v.length > 30) throw new Error('idNumber is too long — at most 30 characters')
      else data.idNumber = v
    }
  }
  if (payload.employmentType !== undefined) {
    if (payload.employmentType === null || payload.employmentType === '') {
      data.employmentType = null
    } else if (
      typeof payload.employmentType !== 'string' ||
      !WORKER_EMPLOYMENT_TYPES.includes(payload.employmentType)
    ) {
      throw new Error(
        `employmentType must be one of ${WORKER_EMPLOYMENT_TYPES.join(', ')} (got ${JSON.stringify(payload.employmentType)})`,
      )
    } else {
      data.employmentType = payload.employmentType
    }
  }
  if (payload.skills !== undefined) {
    if (payload.skills === null) {
      data.skills = null
    } else {
      if (!Array.isArray(payload.skills)) throw new Error('skills must be an array of trade strings')
      if (payload.skills.length > WORKER_SKILLS_MAX) {
        throw new Error(`Too many skills — at most ${WORKER_SKILLS_MAX} are allowed`)
      }
      const skills = payload.skills.map((s) => {
        if (typeof s !== 'string' || !s.trim()) throw new Error('Every skill must be a non-empty string')
        const t = s.trim()
        if (t.length > WORKER_SKILL_MAX_LEN) {
          throw new Error(`Skill "${t.slice(0, 20)}…" is too long — at most ${WORKER_SKILL_MAX_LEN} characters`)
        }
        return t
      })
      data.skills = JSON.stringify(skills)
    }
  }
  if (payload.emergencyContactName !== undefined) {
    if (payload.emergencyContactName === null || payload.emergencyContactName === '') {
      data.emergencyContactName = null
    } else {
      if (typeof payload.emergencyContactName !== 'string') throw new Error('emergencyContactName must be a string')
      const v = payload.emergencyContactName.trim()
      if (!v) data.emergencyContactName = null
      else if (v.length > 80) throw new Error('emergencyContactName is too long — at most 80 characters')
      else data.emergencyContactName = v
    }
  }
  if (payload.emergencyContactPhone !== undefined) {
    if (payload.emergencyContactPhone === null || payload.emergencyContactPhone === '') {
      data.emergencyContactPhone = null
    } else {
      if (typeof payload.emergencyContactPhone !== 'string') throw new Error('emergencyContactPhone must be a string')
      const v = payload.emergencyContactPhone.trim()
      if (!v) data.emergencyContactPhone = null
      else if (v.length > 20) throw new Error('emergencyContactPhone is too long — at most 20 characters')
      else data.emergencyContactPhone = v
    }
  }
  return data
}

/** Load an OrderDelivery scoped to the project (via its order) — honest miss error. */
async function orderDeliveryInProject(deliveryId: string, projectId: string) {
  const delivery = await db.orderDelivery.findFirst({
    where: { id: deliveryId, order: { projectId } },
  })
  if (!delivery) throw new Error('Delivery not found in this project')
  return delivery
}

/** Optional bounded string: absent → skip; null/'' → clear; else validate + trim. */
function optionalBoundedString(
  field: string,
  v: unknown,
  maxLen: number,
): { value: string | null } | null {
  if (v === undefined) return null
  if (v === null || v === '') return { value: null }
  if (typeof v !== 'string') throw new Error(`${field} must be a string`)
  const t = v.trim()
  if (!t) return { value: null }
  if (t.length > maxLen) throw new Error(`${field} is too long — at most ${maxLen} characters`)
  return { value: t }
}

// ---------------- Action dispatcher (online + offline sync) ----------------

export type ActionType =
  | 'task.create'
  | 'task.update'
  | 'task.delete'
  | 'task.assign'
  | 'task.block'
  | 'task.unblock'
  | 'task.verify'
  | 'task.complete'
  | 'phase.update'
  | 'phase.create'
  | 'delivery.create'
  | 'delivery.assign' // §26 driver leg: name who is bringing the load
  | 'delivery.transit' // §26 driver leg: truck en route + validated ETA
  | 'delivery.arrive' // §26 driver leg: on site + arrival stamp
  | 'team.add' // §33 professional roster
  | 'team.update'
  | 'team.remove'
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
  | (typeof INVENTORY_ACTIONS)[number]
  | (typeof WALLET_ACTIONS)[number]

export async function applyAction(type: ActionType, payload: any, projectIdArg?: string): Promise<any> {
  // Project resolution: explicit projectId arg > payload.projectId > first project
  const projectId = await resolveProjectId(projectIdArg, payload)

  // Optional actor override (used by the public share route / client role); never reaches handlers
  const { __actor, __role, ...cleanPayload } = payload ?? {}

  // ---- B1 domain role gates (Doc A §24/§26/§33) ------------------------------
  // The role stamp arrives via __role, written SERVER-side by every entry
  // route (/api/actions, /api/share, /api/sync resolve it from the session
  // and overwrite any payload copy; /api/ussd stamps 'ussd'). No stamp (an
  // internal job or a node-level script) falls back to 'contractor' — the
  // same default the ledger actor uses below.
  const effectiveRole = __role ?? 'contractor'
  if (DELIVERY_LEG_ACTIONS.includes(type) && !DELIVERY_LEG_ROLES.includes(effectiveRole)) {
    throw new Error(
      `Only a contractor, admin or supervisor may run the delivery driver leg — "${effectiveRole}" is not permitted (spec §26)`,
    )
  }
  if (TEAM_ACTIONS.includes(type) && !TEAM_ROLES.includes(effectiveRole)) {
    throw new Error(
      `Only a contractor or admin may manage the project team roster — "${effectiveRole}" is not permitted (spec §33)`,
    )
  }
  // §24 client-direct ordering: a client (or share-link) caller may reach the
  // supply loop ONLY through the seams supplyCan allows — request.create,
  // order.create and request.decide (the CLIENT_ACTIONS band-approval seam).
  // Every other supply action refuses here, server-side, before any handler
  // touches data — the route-layer allowlists stay a convenience gate.
  if (
    (SUPPLY_ACTIONS as readonly string[]).includes(type) &&
    (effectiveRole === 'client' || effectiveRole === 'share_client') &&
    !supplyCan(effectiveRole as SupplyRole, type as SupplyAction)
  ) {
    throw new Error(
      `Clients may raise material requests and place purchase orders — "${type}" stays with the site team (spec §24). ` +
        'Sign in as the site team, or ask them to run it.',
    )
  }

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
  } else if ((INVENTORY_ACTIONS as readonly string[]).includes(type)) {
    result = await applyInventoryAction(type, cleanPayload, projectId)
  } else if ((WALLET_ACTIONS as readonly string[]).includes(type)) {
    result = await applyWalletAction(type, cleanPayload, projectId)
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

// ---------------- money-core helpers (F-MONEY) ----------------

/**
 * Expense posting (expense.create): debit EXPENSE:<projectId>, credit the cash
 * pool for the rail + the legacy Transaction row (costCode, ledgerTxnId) —
 * ONE db.$transaction.
 */
async function postExpenseTransaction(input: {
  projectId: string
  amount: number
  type: string
  method: string
  costCode: string
  note: string | null
  reference: string | null
  date: Date
}): Promise<{ transactionId: string; ledgerRef: string }> {
  const actor = await currentActor()
  const postedBy = actor.name?.trim() || 'Site Manager'
  return db.$transaction(async (tx) => {
    const spend = await spendExternalInTx(tx, input.projectId, {
      amount: input.amount,
      method: input.method,
      description: `Expense (${input.type})${input.note ? ` — ${input.note}` : ''}`,
      postedBy,
      postedRole: actor.role ?? 'contractor',
      idempotencyKey: input.reference ? `expense:${input.projectId}:${input.reference}` : undefined,
    })
    const txnRow =
      (await tx.transaction.findFirst({ where: { ledgerTxnId: spend.ledgerTxnId } })) ??
      (await tx.transaction.create({
        data: {
          projectId: input.projectId,
          type: input.type,
          amount: input.amount,
          method: input.method,
          reference: input.reference ?? spend.ledgerRef,
          costCode: input.costCode,
          ledgerTxnId: spend.ledgerTxnId,
          note: input.note,
          date: input.date,
        },
      }))
    return { transactionId: txnRow.id, ledgerRef: spend.ledgerRef }
  })
}

/**
 * Payroll gate for wages.pay (mirrors trust.ts payroll.approve): refuses to
 * pay while unreviewed attendance exceptions exist, unless forced. The gate
 * result carries the review payload the fundis UI renders.
 */
async function payrollGate(
  projectId: string,
  date: string,
  payload: any,
  force: boolean,
): Promise<{
  blocked: boolean
  result?: { blocked: true; date: string; requiringReview: Array<{ workerId: string; name: string; reason: string | null }>; amount: number; reviewAmount: number }
  unpaid: Array<{ id: string; workerId: string; wage: number }>
  exceptions: Array<{ workerId: string; exceptionReason: string | null }>
  total: number
  names: string
}> {
  const where: { date: string; paid: boolean; projectId: string; workerId?: { in: string[] } } = {
    date,
    paid: false,
    projectId,
  }
  if (Array.isArray(payload?.workerIds) && payload.workerIds.length > 0) {
    where.workerId = { in: payload.workerIds.map(String) }
  }
  const rows = await db.attendance.findMany({ where })
  const unpaid = rows.filter((r) => r.status !== 'absent' && r.status !== 'excused' && r.wage > 0)
  if (unpaid.length === 0) {
    return { blocked: false, unpaid: [], exceptions: [], total: 0, names: '' }
  }
  const exceptions = unpaid
    .filter((r) => r.verification === 'exception')
    .map((r) => ({ workerId: r.workerId, exceptionReason: r.exceptionReason }))
  const total = unpaid.reduce((s, u) => s + u.wage, 0)
  const workers = await db.worker.findMany({ where: { id: { in: unpaid.map((u) => u.workerId) } } })
  const names = unpaid.map((u) => workers.find((w) => w.id === u.workerId)?.name.split(' ')[0] ?? '?').join(', ')

  if (exceptions.length > 0 && !force) {
    return {
      blocked: true,
      result: {
        blocked: true,
        date,
        requiringReview: exceptions.map((e) => ({
          workerId: e.workerId,
          name: workers.find((w) => w.id === e.workerId)?.name ?? 'Unknown',
          reason: e.exceptionReason,
        })),
        amount: total, // payroll on hold
        reviewAmount: unpaid
          .filter((u) => exceptions.some((e) => e.workerId === u.workerId))
          .reduce((s, u) => s + u.wage, 0),
      },
      unpaid,
      exceptions,
      total,
      names,
    }
  }
  return { blocked: false, unpaid, exceptions, total, names }
}

// ---------------- task v2 helpers (Doc A §11 — priority, assignment,
// dependencies, blockers, verification) ----------------

const TASK_PRIORITIES: readonly string[] = ['low', 'normal', 'high', 'urgent']

/** Roles that may verify completed work (§11 verification workflow). */
const TASK_VERIFY_ROLES: readonly string[] = ['contractor', 'admin', 'supervisor']

/** Maximum blockedBy chain depth (cycle guard). */
const TASK_DEPENDENCY_MAX_DEPTH = 5

/** Load a task scoped to the project (via its phase) — honest miss error. */
async function taskInProject(taskId: string, projectId: string) {
  const task = await db.task.findUnique({ where: { id: taskId }, include: { phase: true } })
  if (!task || task.phase.projectId !== projectId) throw new Error('Task not found in this project')
  return task
}

/** Validate a priority; undefined/null normalizes to 'normal'. */
function normalizePriority(p: unknown): string {
  if (p === undefined || p === null || p === '') return 'normal'
  if (typeof p !== 'string' || !TASK_PRIORITIES.includes(p)) {
    throw new Error(`priority must be one of ${TASK_PRIORITIES.join(', ')} (got ${JSON.stringify(p)})`)
  }
  return p
}

/** An assignee must exist AND belong to this project (tenant scoping). */
async function assertWorkerInProject(workerId: string, projectId: string) {
  const worker = await db.worker.findUnique({ where: { id: workerId } })
  if (!worker || worker.projectId !== projectId) throw new Error('Assignee not found in this project')
  return worker
}

/** Parse a due date (ISO string | Date | null) — honest error on garbage. */
function parseDueDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new Error(`dueDate is not a valid date (got ${JSON.stringify(v)})`)
  return d
}

/**
 * Dependency guard (§11): blockedById may not be the task itself, may not
 * point at a task that is itself blocked, and the blockedBy chain may not
 * loop back to the task or exceed TASK_DEPENDENCY_MAX_DEPTH levels. The walk
 * is depth-capped, so a pre-existing cycle terminates — never hangs.
 */
async function assertDependencyOk(taskId: string | null, blockedById: string, projectId: string) {
  const target = await taskInProject(blockedById, projectId)
  if (taskId && blockedById === taskId) {
    throw new Error('A task cannot depend on itself — pick a different blocker')
  }
  if (target.status === 'blocked' || target.blockedById) {
    throw new Error(`Cannot depend on "${target.title}" — that task is itself blocked. Dependencies must point at unblocked work.`)
  }
  // Walk the blockedBy chain from the candidate (plain rows — only scalars needed)
  let current: Task = target
  for (let depth = 1; depth <= TASK_DEPENDENCY_MAX_DEPTH && current.blockedById; depth++) {
    if (taskId && current.id === taskId) {
      throw new Error('Dependency cycle rejected — this link would loop back to the task')
    }
    if (depth === TASK_DEPENDENCY_MAX_DEPTH) {
      throw new Error(`Dependency chain too deep — at most ${TASK_DEPENDENCY_MAX_DEPTH} levels are allowed`)
    }
    const next = await db.task.findUnique({ where: { id: current.blockedById } })
    if (!next) break
    current = next
  }
}

async function applyCoreAction(type: ActionType, payload: any, projectId: string): Promise<any> {
  switch (type) {
    case 'task.create': {
      const { phaseId, title, priority, assignedToId, dueDate, blockedById } = payload
      if (!phaseId || !title) throw new Error('phaseId and title required')
      if (typeof title !== 'string' || !title.trim()) throw new Error('title required')
      // Phase must belong to the resolved project (tenant scoping)
      const phase = await db.phase.findUnique({ where: { id: phaseId } })
      if (!phase || phase.projectId !== projectId) throw new Error('Phase not found in this project')
      const data: {
        phaseId: string
        title: string
        status: string
        progress: number
        priority: string
        dueDate: Date | null
        assignedToId?: string
        blockedById?: string
      } = {
        phaseId,
        title: title.trim(),
        status: 'pending',
        progress: 0,
        priority: normalizePriority(priority),
        dueDate: parseDueDate(dueDate),
      }
      if (assignedToId) {
        await assertWorkerInProject(String(assignedToId), projectId)
        data.assignedToId = String(assignedToId)
      }
      if (blockedById) {
        // A new task cannot participate in a cycle — still scope + freshness checks
        await assertDependencyOk(null, String(blockedById), projectId)
        data.blockedById = String(blockedById)
      }
      const task = await db.task.create({ data })
      return { id: task.id }
    }

    case 'task.update': {
      const { id, title, status, progress, priority, dueDate, assignedToId, blockedById } = payload
      if (!id) throw new Error('task id required')
      const existing = await taskInProject(id, projectId)
      const data: Partial<Task> = {}
      if (title !== undefined) {
        if (typeof title !== 'string' || !title.trim()) throw new Error('title cannot be empty')
        data.title = title.trim()
      }
      if (priority !== undefined) data.priority = normalizePriority(priority)
      if (dueDate !== undefined) data.dueDate = parseDueDate(dueDate)
      if (assignedToId !== undefined) {
        if (assignedToId === null || assignedToId === '') data.assignedToId = null
        else {
          await assertWorkerInProject(String(assignedToId), projectId)
          data.assignedToId = String(assignedToId)
        }
      }
      if (blockedById !== undefined) {
        if (blockedById === null || blockedById === '') data.blockedById = null
        else {
          const depId = String(blockedById)
          await assertDependencyOk(id, depId, projectId)
          data.blockedById = depId
        }
      }
      if (typeof status === 'string') {
        if (status === 'blocked') {
          throw new Error('Blocking needs a reason — use the block action (a reason is required)')
        }
        data.status = status
        // Verification is a property of the COMPLETED work: reopening a task
        // retires the badge (the verify action + audit rows keep the history).
        if (status !== 'done') {
          data.verifiedAt = null
          data.verifiedByName = null
        }
      }
      if (typeof progress === 'number') {
        data.progress = Math.max(0, Math.min(100, Math.round(progress)))
        if (data.progress === 100) data.status = 'done'
        if (data.progress > 0 && data.status === undefined && status === undefined) {
          if (existing.status === 'pending') data.status = 'in_progress'
        }
        if (data.progress < 100) {
          // completed work at <100% is no longer the verified state
          data.verifiedAt = null
          data.verifiedByName = null
        }
      }
      // Entity version (outbox conflict metadata): every mutation of a
      // versioned row bumps it — online edits and offline sync flushes share
      // this applier, so both bump. /api/sync rejects stale baseVersions.
      data.version = existing.version + 1
      const task = await db.task.update({ where: { id }, data })
      return { id: task.id }
    }

    case 'task.assign': {
      const { id, assignedToId } = payload
      if (!id) throw new Error('task id required')
      const existing = await taskInProject(id, projectId) // scoping + existence
      let workerId: string | null = null
      if (assignedToId !== null && assignedToId !== undefined && assignedToId !== '') {
        workerId = String(assignedToId)
        await assertWorkerInProject(workerId, projectId)
      }
      const task = await db.task.update({ where: { id }, data: { assignedToId: workerId, version: existing.version + 1 } })
      return { id: task.id, assignedToId: workerId }
    }

    case 'task.block': {
      const { id, reason, blockedById } = payload
      if (!id) throw new Error('task id required')
      const existing = await taskInProject(id, projectId) // scoping + existence
      if (typeof reason !== 'string' || !reason.trim()) {
        throw new Error('A block reason is required — record why work stopped')
      }
      const data: Partial<Task> = { status: 'blocked', blockedReason: reason.trim().slice(0, 500) }
      if (blockedById !== undefined && blockedById !== null && blockedById !== '') {
        const depId = String(blockedById)
        await assertDependencyOk(id, depId, projectId)
        data.blockedById = depId
      }
      data.version = existing.version + 1
      const task = await db.task.update({ where: { id }, data })
      return { id: task.id }
    }

    case 'task.unblock': {
      const { id } = payload
      if (!id) throw new Error('task id required')
      const existing = await taskInProject(id, projectId)
      const data: Partial<Task> = { blockedReason: null, blockedById: null }
      if (existing.status === 'blocked') {
        // work resumes where it left off
        data.status = existing.progress > 0 ? 'in_progress' : 'pending'
      }
      data.version = existing.version + 1
      const task = await db.task.update({ where: { id }, data })
      return { id: task.id }
    }

    case 'task.complete': {
      const { id } = payload
      if (!id) throw new Error('task id required')
      const existing = await taskInProject(id, projectId)
      if (existing.status === 'blocked' || existing.blockedReason) {
        throw new Error(
          `"${existing.title}" is blocked${existing.blockedReason ? `: ${existing.blockedReason}` : ''} — unblock it before completing`,
        )
      }
      if (existing.blockedById) {
        const blocker = await db.task.findUnique({ where: { id: existing.blockedById } })
        if (blocker && blocker.status !== 'done') {
          throw new Error(`Cannot complete "${existing.title}" — it depends on "${blocker.title}", which is not done yet`)
        }
      }
      const task = await db.task.update({ where: { id }, data: { status: 'done', progress: 100, version: existing.version + 1 } })
      return { id: task.id }
    }

    case 'task.verify': {
      const { id } = payload
      if (!id) throw new Error('task id required')
      const existing = await taskInProject(id, projectId)
      if (existing.status !== 'done') {
        throw new Error(`Only completed work can be verified — "${existing.title}" is ${existing.status.replace('_', ' ')}`)
      }
      // Role gate (§11): contractor | admin | supervisor. Resolved from the
      // signed-in session cookie (currentActor), NEVER the payload — the
      // client/finance roles and share-link callers are refused honestly.
      const actor = await currentActor()
      if (!actor.role || !TASK_VERIFY_ROLES.includes(actor.role)) {
        throw new Error(
          `Only a contractor, admin or supervisor may verify work${actor.role ? ` — you are signed in as ${actor.role}` : ' — sign in first'}`,
        )
      }
      const task = await db.task.update({
        where: { id },
        data: { verifiedAt: new Date(), verifiedByName: actor.name?.trim() || actor.role, version: existing.version + 1 },
      })
      return { id: task.id, verifiedBy: task.verifiedByName }
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
            method: payload.method || 'app', wage: worker.dailyRate,
            verification: 'verified', // worker-initiated check-in carries device evidence
            evidence: JSON.stringify([payload.method === 'ussd' ? 'ussd' : payload.method === 'kiosk_pin' ? 'pin' : 'device', 'device']),
          },
        })
      } else if (toggle === 'out' && !att.checkOut) {
        att = await db.attendance.update({ where: { id: att.id }, data: { checkOut: new Date(), version: att.version + 1 } })
      } else if (toggle === 'in' && !att.checkIn) {
        att = await db.attendance.update({ where: { id: att.id }, data: { checkIn: new Date(), status: 'present', wage: worker.dailyRate, version: att.version + 1 } })
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
          data: { status, wage, overrideLog: JSON.stringify(overrideLog), version: att.version + 1 },
        })
      }
      return { id: att.id }
    }

    case 'worker.create': {
      const { name, role, phone, dailyRate, pin } = payload
      if (!name) throw new Error('name required')
      // §14 worker record depth: idNumber / employmentType / skills /
      // emergency contact ride along on creation (all optional, validated by
      // the shared normalizer so create and update speak one contract).
      const w = await db.worker.create({
        data: {
          projectId,
          name,
          role: role || 'Mtumishi (Labourer)',
          phone: phone || '',
          dailyRate: Number(dailyRate) || 800,
          pin: typeof pin === 'string' && /^\d{4}$/.test(pin) ? pin : null,
          ...workerProfileData(payload),
        },
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
      // §14 worker record depth — same validation as worker.create
      Object.assign(data, workerProfileData(payload))
      const w = await db.worker.update({ where: { id }, data })
      return { id: w.id }
    }

    case 'delivery.assign': {
      // §26 driver leg: name who is bringing the load (and in what). The
      // driver can be set/changed while the truck is en route; after arrival
      // or receipt the record is history and refuses edits.
      const { deliveryId, driverName, driverPhone, vehicleReg } = payload
      if (!deliveryId) throw new Error('deliveryId required')
      const delivery = await orderDeliveryInProject(String(deliveryId), projectId)
      if (!['dispatched', 'in_transit'].includes(delivery.status)) {
        throw new Error(
          `A driver can only be assigned while the truck is en route — this delivery is ${delivery.status.toUpperCase()}`,
        )
      }
      if (driverName === undefined || driverName === null || driverName === '') {
        throw new Error('driverName required — name who is bringing the load')
      }
      const name = typeof driverName === 'string' ? driverName.trim() : ''
      if (!name) throw new Error('driverName required — name who is bringing the load')
      if (name.length > 60) throw new Error('driverName is too long — at most 60 characters')
      const data: Partial<OrderDelivery> = { driverName: name }
      const phone = optionalBoundedString('driverPhone', driverPhone, 20)
      if (phone) data.driverPhone = phone.value
      const reg = optionalBoundedString('vehicleReg', vehicleReg, 20)
      if (reg) data.vehicleReg = reg.value
      const updated = await db.orderDelivery.update({ where: { id: delivery.id }, data })
      return { id: updated.id, driverName: updated.driverName }
    }

    case 'delivery.transit': {
      // §26 driver leg: the truck is en route, with a validated ETA.
      const { deliveryId, etaAt } = payload
      if (!deliveryId) throw new Error('deliveryId required')
      const delivery = await orderDeliveryInProject(String(deliveryId), projectId)
      if (!['dispatched', 'in_transit'].includes(delivery.status)) {
        throw new Error(
          `Only DISPATCHED or IN_TRANSIT deliveries can report transit — this one is ${delivery.status.toUpperCase()}`,
        )
      }
      if (etaAt === undefined || etaAt === null || etaAt === '') {
        throw new Error('etaAt required — when is the truck expected on site?')
      }
      const eta = new Date(String(etaAt))
      if (Number.isNaN(eta.getTime())) {
        throw new Error(`etaAt is not a valid date (got ${JSON.stringify(etaAt)})`)
      }
      const updated = await db.orderDelivery.update({
        where: { id: delivery.id },
        data: { status: 'in_transit', etaAt: eta },
      })
      return { id: updated.id, status: 'in_transit', etaAt: updated.etaAt }
    }

    case 'delivery.arrive': {
      // §26 driver leg: the truck is on site. Optional GPS pins the arrival;
      // the physical count still happens at delivery.receive (§13).
      const { deliveryId, gpsLat, gpsLng } = payload
      if (!deliveryId) throw new Error('deliveryId required')
      const delivery = await orderDeliveryInProject(String(deliveryId), projectId)
      if (!['dispatched', 'in_transit'].includes(delivery.status)) {
        throw new Error(
          `Only en-route deliveries can arrive — this one is ${delivery.status.toUpperCase()}`,
        )
      }
      const data: Partial<OrderDelivery> = { status: 'arrived', arrivedAt: new Date() }
      if (gpsLat !== undefined && gpsLat !== null) {
        const lat = Number(gpsLat)
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
          throw new Error(`gpsLat must be a number between -90 and 90 (got ${JSON.stringify(gpsLat)})`)
        }
        data.gpsLat = lat
      }
      if (gpsLng !== undefined && gpsLng !== null) {
        const lng = Number(gpsLng)
        if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
          throw new Error(`gpsLng must be a number between -180 and 180 (got ${JSON.stringify(gpsLng)})`)
        }
        data.gpsLng = lng
      }
      const updated = await db.orderDelivery.update({ where: { id: delivery.id }, data })
      return { id: updated.id, status: 'arrived', arrivedAt: updated.arrivedAt }
    }

    case 'team.add': {
      // §33 professional assignment: who is on the project team, in which
      // professional role, with contact details. Distinct from app Users —
      // this is the site roster (people, not logins).
      const { name, role, phone, email, note } = payload
      if (!name || typeof name !== 'string' || !name.trim()) throw new Error('name required')
      if (name.trim().length > 80) throw new Error('name is too long — at most 80 characters')
      if (role === undefined || role === null || role === '') {
        throw new Error('role required — the professional role on the team')
      }
      const teamRole =
        typeof role === 'string' && PROJECT_TEAM_ROLES.includes(role)
          ? role
          : undefined
      if (!teamRole) {
        throw new Error(`role must be one of ${PROJECT_TEAM_ROLES.join(', ')} (got ${JSON.stringify(role)})`)
      }
      const data: { projectId: string; name: string; role: string; phone: string | null; email: string | null; note: string | null } = {
        projectId,
        name: name.trim(),
        role: teamRole,
        phone: null,
        email: null,
        note: null,
      }
      const phoneV = optionalBoundedString('phone', phone, 20)
      if (phoneV) data.phone = phoneV.value
      const emailV = optionalBoundedString('email', email, 120)
      if (emailV) data.email = emailV.value
      const noteV = optionalBoundedString('note', note, 300)
      if (noteV) data.note = noteV.value
      const member = await db.projectTeam.create({ data })
      return { id: member.id }
    }

    case 'team.update': {
      const { id, name, role, phone, email, note } = payload
      if (!id) throw new Error('team member id required')
      const existing = await db.projectTeam.findFirst({ where: { id: String(id), projectId } })
      if (!existing) throw new Error('Team member not found in this project')
      const data: Partial<ProjectTeam> = {}
      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) throw new Error('name cannot be empty')
        if (name.trim().length > 80) throw new Error('name is too long — at most 80 characters')
        data.name = name.trim()
      }
      if (role !== undefined) {
        if (typeof role !== 'string' || !PROJECT_TEAM_ROLES.includes(role)) {
          throw new Error(`role must be one of ${PROJECT_TEAM_ROLES.join(', ')} (got ${JSON.stringify(role)})`)
        }
        data.role = role
      }
      const phoneV = optionalBoundedString('phone', phone, 20)
      if (phoneV) data.phone = phoneV.value
      const emailV = optionalBoundedString('email', email, 120)
      if (emailV) data.email = emailV.value
      const noteV = optionalBoundedString('note', note, 300)
      if (noteV) data.note = noteV.value
      if (!Object.keys(data).length) {
        throw new Error('Nothing to update — provide name, role, phone, email or note')
      }
      const member = await db.projectTeam.update({ where: { id: existing.id }, data })
      return { id: member.id }
    }

    case 'team.remove': {
      const { id } = payload
      if (!id) throw new Error('team member id required')
      const existing = await db.projectTeam.findFirst({ where: { id: String(id), projectId } })
      if (!existing) throw new Error('Team member not found in this project')
      await db.projectTeam.delete({ where: { id: existing.id } })
      return { id: existing.id }
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
      const { type, amount, method, note, reference, date, costCode } = payload
      if (!['material', 'wage', 'other', 'transport'].includes(type)) throw new Error("type must be 'material' | 'wage' | 'other' | 'transport'")
      if (typeof amount !== 'number' || !(amount > 0)) throw new Error('amount must be a positive number')
      const payMethod = ['mpesa', 'cash', 'bank'].includes(method) ? method : 'mpesa'
      // F2/F-MONEY: the expense posts a balanced double-entry ledger txn
      // (debit EXPENSE:<projectId>, credit the cash pool for the rail) and the
      // legacy Transaction row (costCode + ledgerTxnId) in ONE db.$transaction.
      const posted = await postExpenseTransaction({
        projectId,
        amount,
        type,
        method: payMethod,
        costCode: typeof costCode === 'string' && costCode.trim() ? costCode.trim() : type,
        note: note || null,
        reference: reference || null,
        date: date ? new Date(date) : new Date(),
      })
      return { id: posted.transactionId, ledgerRef: posted.ledgerRef }
    }

    case 'transaction.delete': {
      // F1 (audit finding): this used to hard-delete ANY transaction with no
      // project scoping. History is immutable now (spec §39) — the action name
      // stays for UI compatibility, but it ALWAYS writes a compensating
      // reversal via the wallet service (project-scoped lookup). Even an admin
      // asking for `confirmHardDelete: true` is refused.
      const { id, confirmHardDelete, reason } = payload
      if (!id) throw new Error('transaction id required')
      if (confirmHardDelete === true) {
        throw new Error(
          'Hard deletes are refused — financial history is immutable (spec §39). ' +
            'A compensating reversal entry is posted instead.',
        )
      }
      const reversal = await reverseTransactionService(projectId, {
        id,
        reason: typeof reason === 'string' && reason.trim() ? reason.trim() : 'correction (transaction.delete)',
      })
      return { id: reversal.reversalTransactionId, ledgerRef: reversal.ledgerRef, reversed: true }
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
      // payload: { workerIds?: string[], date?, force? } — pays unpaid attendance
      // wages for today (or the given date). F-MONEY: the payroll gate (unreviewed
      // exceptions block unless forced) + the ledger posting + the Transaction row
      // (costCode 'wages') run in ONE db.$transaction, and the payout goes through
      // the PaymentProvider seam (simulated rail, honestly labelled).
      const date = typeof payload?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.date) ? payload.date : todayStr()
      const force = Boolean(payload?.force)
      const gate = await payrollGate(projectId, date, payload, force)
      if (gate.blocked) return gate.result

      const initiation = await getProvider('mpesa').initiatePayment({
        amount: gate.total,
        currency: 'KES',
        method: 'mpesa',
        payee: `${gate.unpaid.length} fundi(s)`,
        reference: `PAYROLL-${date}`,
        description: `Wages ${date}`,
      })
      if (initiation.status !== 'succeeded') {
        throw new Error(`Provider did not accept the payroll: ${initiation.detail}`)
      }

      const posted = await db.$transaction(async (tx) => {
        const paid = await tx.attendance.updateMany({
          where: { id: { in: gate.unpaid.map((u) => u.id) } },
          data: { paid: true, version: { increment: 1 } }, // payroll stamps are row mutations too
        })
        void paid
        const spend = await spendExternalInTx(tx, projectId, {
          amount: gate.total,
          method: 'mpesa',
          description: `Wages ${date} — ${gate.unpaid.length} fundi(s)${gate.exceptions.length > 0 ? ' (forced past exceptions)' : ''}`,
          postedBy: 'Site Manager',
          postedRole: 'contractor',
          idempotencyKey: `wages.pay:${projectId}:${date}:${gate.unpaid.map((u) => u.id).join(',')}`,
        })
        const txnRow =
          (await tx.transaction.findFirst({ where: { ledgerTxnId: spend.ledgerTxnId } })) ??
          (await tx.transaction.create({
            data: {
              projectId,
              type: 'wage',
              amount: gate.total,
              method: 'mpesa',
              reference: `PAY-${date.replace(/-/g, '')}-${spend.ledgerRef.slice(-4)}`,
              costCode: 'wages',
              ledgerTxnId: spend.ledgerTxnId,
              note: `Wages ${date}${gate.exceptions.length > 0 ? ' (forced past exceptions)' : ''} — ${gate.names}`,
              date: new Date(),
            },
          }))
        return { ledgerRef: spend.ledgerRef, transactionId: txnRow.id }
      })

      return {
        blocked: false,
        paid: gate.unpaid.length,
        amount: gate.total,
        forced: force && gate.exceptions.length > 0,
        ledgerRef: posted.ledgerRef,
      }
    }

    case 'share.regenerate': {
      // Rotate the read-only client share link (invalidates the old token)
      const { id } = payload
      if (!id) throw new Error('project id required')
      const existing = await db.project.findUnique({ where: { id } })
      if (!existing) throw new Error('Project not found')
      // crypto-strong 96-bit token (Math.random is predictable — this is a read-only capability secret)
      const shareToken = `c${randomBytes(12).toString('hex')}`
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
