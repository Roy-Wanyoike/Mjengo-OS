import { db } from '@/lib/db'

export interface AuditActor {
  name: string
  role: string // contractor, foreman, client, system, ai
}

/** Append-only Bias-Free Ledger entry. Never throws — auditing must not break actions. */
export async function logAudit(
  projectId: string,
  kind: string,
  actor: AuditActor,
  summary: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        projectId,
        kind,
        actor: actor.name,
        role: actor.role,
        summary,
        meta: meta ? JSON.stringify(meta) : undefined,
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
    case 'transaction.delete': return `Removed transaction ${p.id?.slice(-6)}`
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
  }
  return map[prefix] ?? 'action'
}
