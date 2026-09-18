// Domain event bus — types (spec §59 event-driven internal architecture).
//
// Internal domain events: emit() writes a DomainEvent row AND runs the
// in-process subscribers registered for that type. The DEFAULT subscriber is
// a notification-policy map (event type → notification row) so domain code can
// migrate from direct notify() calls to emit() one call-site at a time.
//
// This bus is deliberately SYNCHRONOUS and in-process (honest): there is no
// external broker — subscribers run inside emit(), errors are caught and
// logged (the DomainEvent row records processedAt when consumers ran).

/** Canonical domain event types (open set — append-only). */
export type DomainEventType =
  // procurement / site flows (future migration of direct notify() calls)
  | 'material.delivered'
  | 'inventory.updated'
  | 'payment.approved'
  | 'milestone.released'
  | 'order.sent'
  // F-PLATFORM emit points (jobs + AI routes)
  | 'anomaly.detected'
  | 'recap.daily'
  | 'digest.weekly'
  | 'ledger.reconciled'
  | 'escrow.drift'
  | 'project.delayed'
  | 'attendance.absent'
  | 'budget.alert'

/** JSON-ish payload carried on the event row and handed to subscribers. */
export type DomainEventPayload = Record<string, unknown>

/** A subscriber receives the emitted event. Sync or async; errors are isolated. */
export type DomainEventHandler = (
  event: DomainEventEnvelope,
) => void | Promise<void>

/** What emit() hands to subscribers (plus the persisted row id). */
export interface DomainEventEnvelope {
  eventId: string
  projectId: string | null
  type: string
  payload: DomainEventPayload
  occurredAt: Date
}

/** Notification policy entry: maps a domain event to a notify() row. */
export interface NotifyPolicyEntry {
  kind: string
  /**
   * Single-audience policy (the historical shape — every pre-#212 entry).
   * Optional only because multi-audience entries (audienceRoles below) exist
   * since issue #212; exactly ONE of the two fields should be set.
   */
  audienceRole?: string
  /**
   * Multi-audience fan-out (issue #212): when set, emit() writes ONE
   * notification row per role in this list (same title/body/kind, different
   * audienceRole) instead of the single audienceRole row. Used by
   * 'escrow.drift' → finance + contractor.
   */
  audienceRoles?: string[]
  channel?: string
  recipient?: (payload: DomainEventPayload) => string | undefined
  title: (payload: DomainEventPayload) => string
  body: (payload: DomainEventPayload) => string
}
