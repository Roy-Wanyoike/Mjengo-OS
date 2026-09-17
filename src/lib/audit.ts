import { AsyncLocalStorage } from 'node:async_hooks'
import { db } from '@/lib/db'

export interface AuditActor {
  name: string
  role: string // contractor, foreman, client, system, ai, finance, supervisor
}

/**
 * Request context threaded into audit entries (spec §43): where the action
 * came from and what entity it touched. All fields optional — callers
 * persist what they honestly know.
 */
export interface AuditContext {
  ip?: string
  userAgent?: string
  requestId?: string
  entity?: string
  entityId?: string
  before?: unknown
  after?: unknown
}

// ---------------- request-scoped audit context (F-PLATFORM §43) ----------------

/**
 * AsyncLocalStorage holding the CURRENT request's audit context. The actions
 * route wraps applyAction in withAuditContext(...); applyAction's own
 * logAudit call (lib/mjengo.ts — untouched) then picks the context up here.
 * Correct across concurrent requests — no shared mutable module state.
 */
const auditContextStorage = new AsyncLocalStorage<AuditContext>()

/** Run `fn` with an audit context — every logAudit inside it persists it. */
export async function withAuditContext<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> {
  return auditContextStorage.run(ctx, fn)
}

/** The ambient audit context (undefined outside a withAuditContext run). */
export function getAuditContext(): AuditContext | undefined {
  return auditContextStorage.getStore()
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function asJson(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  try {
    return JSON.stringify(v)
  } catch {
    return undefined
  }
}

/** Append-only Bias-Free Ledger entry. Never throws — auditing must not break actions.
 *
 * ctx (optional, last param — backwards compatible): explicit per-call context,
 * merged over the ambient withAuditContext() store. Persists the §43 fields
 * ip/userAgent/requestId/entity/entityId/before/after when present.
 */
export async function logAudit(
  projectId: string,
  kind: string,
  actor: AuditActor,
  summary: string,
  meta?: Record<string, unknown>,
  ctx?: AuditContext,
): Promise<void> {
  try {
    const ambient = auditContextStorage.getStore() ?? {}
    const merged: AuditContext = ctx ? { ...ambient, ...ctx } : ambient
    await db.auditEvent.create({
      data: {
        projectId,
        kind,
        actor: actor.name,
        role: actor.role,
        summary,
        meta: meta ? JSON.stringify(meta) : undefined,
        entity: asString(merged.entity),
        entityId: asString(merged.entityId),
        before: asJson(merged.before),
        after: asJson(merged.after),
        ip: asString(merged.ip),
        userAgent: asString(merged.userAgent),
        requestId: asString(merged.requestId),
      },
    })
  } catch (e) {
    console.error('[audit] failed to log', kind, e)
  }
}

/** Human-readable one-liner for any action, for the ledger. */
export function summarizeAction(type: string, payload: any, result: any): string {
  const p = payload ?? {}
  switch (type) {
    case 'task.create': return `Added task "${p.title}"`
    case 'task.update': return `Updated task${p.progress !== undefined ? ` → ${p.progress}%` : ''}${p.status ? ` (${p.status})` : ''}`
    case 'task.delete': return `Deleted task ${p.id?.slice(-6)}`
    case 'phase.update': return `Updated phase progress${p.progressManual !== undefined ? ` → ${p.progressManual}%` : ''}`
    case 'phase.create': return `Added phase "${p.name}" (KSh ${p.budget})`
    case 'delivery.create': return `Logged delivery: ${p.quantity}× ${p.materialId ? 'material ' + p.materialId.slice(-6) : 'material'} from ${p.supplier ?? 'supplier'}`
    case 'consumption.create': return `Recorded consumption: ${p.quantity}× material ${p.materialId?.slice(-6)}`
    case 'attendance.checkin': return `Check-in ${p.toggle === 'out' ? 'out' : 'in'} recorded`
    case 'attendance.setStatus': return `Attendance marked ${p.status}`
    case 'worker.create': return `Added worker "${p.name}" (${p.role ?? 'crew'})`
    case 'worker.update': return `Updated worker ${p.id?.slice(-6)}`
    case 'wages.pay': return `Paid wages${result?.amount ? ` — KSh ${result.amount}` : ''}`
    case 'alert.ack': return `Acknowledged alert ${p.id?.slice(-6)}`
    case 'photo.apply': return `Site photo evidence attached${p.progressPct !== undefined ? ` (${p.progressPct}% phase progress)` : ''}`
    case 'project.update': return `Project details updated`
    case 'project.create': return `Project created`
    case 'expense.create': return `Expense recorded: KSh ${p.amount} (${p.type})`
    case 'transaction.delete': return `Reversed transaction ${p.id?.slice(-6)} — compensating entry posted${result?.ledgerRef ? ` (ledger ${result.ledgerRef})` : ''}`
    case 'material.create': return `Material "${p.name}" added to catalog`
    case 'share.regenerate': return `Share link regenerated`
    // Trust module
    case 'attendance.record': return `Muster roll recorded (${p.records ? JSON.parse(p.records).length : '?'} workers, ${p.verification ?? 'reported'})`
    case 'attendance.exception': return `Attendance exception logged for worker ${p.workerId?.slice(-6)} (${p.reason})`
    case 'attendance.override': return `Attendance OVERRIDE — history preserved`
    case 'payroll.approve': return `Payroll approved${result?.amount ? ` — KSh ${result.amount}` : ''}`
    // Money module
    case 'escrow.topup': return `MjengoPay top-up KSh ${p.amount}`
    case 'milestone.create': return `Milestone "${p.name}" created (KSh ${p.amount})`
    case 'milestone.evidence': return `Proof-of-work evidence attached to milestone ${p.id?.slice(-6)}`
    case 'milestone.requestRelease': return `Milestone release REQUESTED (awaiting client approval)`
    case 'milestone.decide': return `Milestone ${p.decision ?? 'decided'} by client`
    case 'variation.submit': return `Variation submitted: "${p.title}" (${p.budgetImpact >= 0 ? '+' : ''}KSh ${p.budgetImpact})`
    case 'variation.decide': return `Variation ${p.decision} by client`
    // Evidence module
    case 'comment.add': return `Photo comment by ${p.author ?? 'client'}`
    case 'comment.resolve': return `Photo comment resolved`
    case 'notification.read': return `Notification marked read`
    case 'notification.readAll': return `All notifications marked read`
    case 'zone.create': return `Site map zone "${p.name}" added`
    case 'zone.delete': return `Site map zone removed`
    // Inventory module (v3)
    case 'inventory.open': return `Opening stock recorded: ${p.qty}× ${p.materialName}`
    case 'inventory.receive': return `Stock received: ${p.qty}× ${p.materialName ?? 'item'}${p.reference ? ` (ref ${p.reference})` : ''}`
    case 'inventory.consume': return `Stock consumed: ${p.qty}× item ${p.inventoryItemId?.slice(-6)}`
    case 'inventory.transfer': return `Stock transferred: ${p.qty}× → ${p.toLocation}`
    case 'inventory.return': return `Stock returned to supplier: ${p.qty}× item ${p.inventoryItemId?.slice(-6)}`
    case 'inventory.damage': return `Damaged stock recorded: ${p.qty}× — ${p.damageNote ?? 'no note'}`
    case 'inventory.adjust': return `Stock count adjusted ${p.qty > 0 ? '+' : ''}${p.qty} — ${p.reason ?? 'correction'}`
    // BOQ module (v3)
    case 'boq.create': return `BOQ "${p.name}" created (${(p.lines ?? []).length} lines)`
    case 'boq.line.upsert': return `BOQ line ${p.id ? 'updated' : 'added'}: ${p.qty}× ${p.materialName}`
    case 'boq.line.delete': return `BOQ line removed (${p.id?.slice(-6)})`
    case 'boq.approve': return `BOQ approved (${p.id?.slice(-6)})`
    case 'boq.to_request': return `BOQ → material request generated (${result?.requestCode ?? ''})`
    // Supplier shortlist / quotes (v3)
    case 'supplier.save': return `Supplier saved to shortlist (${p.supplierId?.slice(-6)})`
    case 'supplier.unsave': return `Supplier removed from shortlist`
    case 'quote.update': return `Quote detail updated (${p.id?.slice(-6)})`
    // Money core (v3)
    case 'payment.request': return `Payment request created: KSh ${p.amount} to ${p.payee}`
    case 'payment.decide': return `Payment request ${p.decision ?? 'decided'}${p.note ? ` — ${p.note}` : ''}`
    case 'payment.pay': return `Payment recorded${result?.ledgerRef ? ` (ledger ${result.ledgerRef})` : ''}`
    case 'wallet.create': return `Wallet ${result?.code ?? ''} created`
    case 'wallet.deposit': return `Wallet deposit KSh ${p.amount}${result?.ledgerRef ? ` (ledger ${result.ledgerRef})` : ''}`
    case 'wallet.withdraw': return `Wallet withdrawal KSh ${p.amount}`
    case 'wallet.transfer': return `Wallet transfer KSh ${p.amount} ${result?.from ?? ''} → ${result?.to ?? ''}`
    case 'transaction.reverse': return `Transaction REVERSED — ${p.reason ?? 'correction'} (ledger ${result?.ledgerRef ?? ''})`
    case 'ledger.post': return `Manual journal posted (ledger ${result?.ref ?? ''})`
    default: return `Action: ${type}`
  }
}

export function kindForAction(type: string): string {
  const prefix = type.split('.')[0]
  const map: Record<string, string> = {
    task: 'task', phase: 'phase', delivery: 'delivery', consumption: 'material',
    attendance: 'attendance', worker: 'worker', wages: 'wage', alert: 'alert',
    photo: 'photo', project: 'project', expense: 'expense', transaction: 'transaction',
    material: 'material', share: 'share', escrow: 'escrow', milestone: 'milestone',
    variation: 'variation', comment: 'comment', notification: 'notification', zone: 'site_map',
    payroll: 'wage',
    inventory: 'inventory', boq: 'boq', payment: 'payment', wallet: 'wallet', ledger: 'ledger',
  }
  return map[prefix] ?? 'action'
}
