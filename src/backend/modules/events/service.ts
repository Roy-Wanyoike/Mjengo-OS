// Domain event bus — service (spec §59).
//
// emit(projectId, type, payload):
//   1. persists a DomainEvent row (the durable record — "keep events internal"),
//   2. runs the DEFAULT subscriber (the notification-policy map below) plus
//      any subscribers registered via subscribe(type, handler),
//   3. stamps processedAt on the row once the consumers ran.
//
// The bus is synchronous and in-process — there is NO external broker and no
// retries. Subscriber errors are caught + logged so emitting can never break
// the caller. Existing direct notify() calls in other modules stay as they are
// (their files are not ours); migrating those call-sites to emit() is a future
// refactor — the policy map below already speaks their conventions so the
// migration is mechanical.

import { db } from '@/backend/lib/db'
import { notify } from '@/backend/modules/notify/service'
import type {
  DomainEventEnvelope,
  DomainEventHandler,
  DomainEventPayload,
  NotifyPolicyEntry,
} from './types'

// ---------------- notification policy (the default subscriber) ----------------
//
// Event type → in-app notification row. Kinds/audience mirror the conventions
// the domain services already use with notify():
//   · material delivered      → kind delivery.dispatched, contractor (site receives)
//   · inventory updated       → kind delivery.discrepancy-neutral… see map
//   · payment approved        → kind approval.decided, finance
//   · milestone released      → kind milestone, client
//   · order sent              → kind order.sent, contractor
//   · anomaly detected        → kind anomaly, contractor (act on the alert)
//   · recap daily             → kind recap, client (diaspora evening update)
//   · ledger reconciled       → kind ledger.reconciled, contractor
//   · project delayed         → kind project.delayed, contractor
//   · attendance absent       → kind attendance.absent, contractor
//   · budget alert            → kind budget.alert, contractor
//
// `null` policy = the domain service already notifies directly today (e.g. the
// intel digest) — the event row is still written, just no second notification.
const NOTIFY_POLICY: Record<string, NotifyPolicyEntry | null> = {
  'material.delivered': {
    kind: 'delivery.dispatched',
    audienceRole: 'contractor',
    title: (p) => `Delivery received — ${String(p.quantity ?? '?')} ${String(p.unit ?? '')} ${String(p.material ?? 'material')}`.trim(),
    body: (p) => `Material delivery recorded on site${p.supplier ? ` from ${String(p.supplier)}` : ''}. Site Store stock was updated.`,
  },
  'inventory.updated': {
    kind: 'system',
    audienceRole: 'contractor',
    title: (p) => `Site Store updated — ${String(p.materialName ?? 'item')}`,
    body: (p) => `Stock movement ${String(p.movementType ?? 'recorded')}${p.closing !== undefined ? ` — closing ${String(p.closing)} ${String(p.unit ?? '')}` : ''}.`,
  },
  'payment.approved': {
    kind: 'approval.decided',
    audienceRole: 'finance',
    title: (p) => `Payment approved — KSh ${String(p.amount ?? '?')}`,
    body: (p) => `A payment request${p.payee ? ` to ${String(p.payee)}` : ''} was approved and is ready to execute on the ledger.`,
  },
  'milestone.released': {
    kind: 'milestone',
    audienceRole: 'client',
    title: (p) => `Milestone released — ${String(p.name ?? 'milestone')}`,
    body: (p) => `Funds were released from escrow${p.amount ? ` (KSh ${String(p.amount)})` : ''}. The ledger entry is on file.`,
  },
  'order.sent': {
    kind: 'order.sent',
    audienceRole: 'contractor',
    title: (p) => `Purchase order sent — ${String(p.orderCode ?? '')}`,
    body: (p) => `PO sent to ${String(p.supplier ?? 'supplier')}. Confirmations and delivery will be tracked here.`,
  },
  'anomaly.detected': {
    kind: 'anomaly',
    audienceRole: 'contractor',
    title: (p) => `Anomaly scan — ${String(p.count ?? 0)} finding${Number(p.count ?? 0) === 1 ? '' : 's'}`,
    body: (p) => String(p.summary ?? 'Anomaly scan completed — open the alerts card for the findings.'),
  },
  'recap.daily': {
    kind: 'recap',
    audienceRole: 'client',
    channel: 'in_app',
    recipient: (p) => (typeof p.client === 'string' ? p.client : undefined),
    title: (p) => `Daily recap — Day ${String(p.day ?? '')}`,
    body: (p) => String(p.body ?? '').slice(0, 140),
  },
  // The intel digest service already notifies (kind digest.weekly) directly —
  // a second row here would duplicate the bell entry. Event row only.
  'digest.weekly': null,
  'ledger.reconciled': {
    kind: 'ledger.reconciled',
    audienceRole: 'contractor',
    title: (p) => (p.consistent === true ? 'Ledger reconciliation — consistent' : 'Ledger reconciliation — drift found'),
    body: (p) => String(p.note ?? 'Ledger consistency recomputed.'),
  },
  'project.delayed': {
    kind: 'project.delayed',
    audienceRole: 'contractor',
    title: (p) => `${String(p.count ?? 0)} overdue task${Number(p.count ?? 0) === 1 ? '' : 's'}`,
    body: (p) => String(p.detail ?? 'Overdue tasks found — check the schedule.'),
  },
  'attendance.absent': {
    kind: 'attendance.absent',
    audienceRole: 'contractor',
    title: (p) => `${String(p.count ?? 0)} worker${Number(p.count ?? 0) === 1 ? '' : 's'} absent today`,
    body: (p) => String(p.detail ?? 'No check-ins recorded for today.'),
  },
  'budget.alert': {
    kind: 'budget.alert',
    audienceRole: 'contractor',
    title: (p) => `Budget pace ${String(p.pct ?? '?')}% — ${String(p.level ?? 'alert')}`,
    body: (p) => String(p.note ?? 'Spend is running ahead of the plan.'),
  },
}

// ---------------- subscriber registry (future extension) ----------------

const subscribers = new Map<string, DomainEventHandler[]>()

/**
 * Register an in-process subscriber for a domain event type (spec §59:
 * "keep events internal initially"). Handlers run inside emit(); errors are
 * isolated and logged, never thrown to the emitter.
 */
export function subscribe(type: string, handler: DomainEventHandler): void {
  const list = subscribers.get(type) ?? []
  list.push(handler)
  subscribers.set(type, list)
}

/** Test/introspection helper: live handler count for a type. */
export function subscriberCount(type: string): number {
  return subscribers.get(type)?.length ?? 0
}

// ---------------- emit ----------------

/**
 * Emit an internal domain event: persist the DomainEvent row, run the default
 * notification-policy subscriber + registered subscribers, then stamp
 * processedAt. Synchronous + in-process (honest — no broker, no retries).
 */
export async function emit(
  projectId: string | null,
  type: string,
  payload: DomainEventPayload = {},
): Promise<DomainEventEnvelope> {
  const row = await db.domainEvent.create({
    data: {
      projectId,
      type,
      payload: JSON.stringify(payload ?? {}),
    },
  })

  const envelope: DomainEventEnvelope = {
    eventId: row.id,
    projectId,
    type,
    payload,
    occurredAt: row.occurredAt,
  }

  // Default subscriber: notification policy map.
  let processed = true
  const policy = NOTIFY_POLICY[type]
  if (policy && projectId) {
    try {
      await notify(projectId, policy.title(payload), policy.body(payload), {
        kind: policy.kind,
        audienceRole: policy.audienceRole,
        channel: policy.channel ?? 'in_app',
        ...(policy.recipient ? { recipient: policy.recipient(payload) } : {}),
      })
    } catch (e) {
      processed = false
      console.error(`[events] notify policy failed for ${type}`, e)
    }
  }

  // Registered subscribers (extension point).
  for (const handler of subscribers.get(type) ?? []) {
    try {
      await handler(envelope)
    } catch (e) {
      processed = false
      console.error(`[events] subscriber failed for ${type}`, e)
    }
  }

  if (processed) {
    try {
      await db.domainEvent.update({
        where: { id: row.id },
        data: { processedAt: new Date() },
      })
    } catch (e) {
      console.error(`[events] could not stamp processedAt for ${type}`, e)
    }
  }

  return envelope
}
