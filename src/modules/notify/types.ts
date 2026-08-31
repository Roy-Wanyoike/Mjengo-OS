// Notifications module — types for the notify slice (INTERNAL — the payload
// already carries `notifications`, so this module powers the service layer and
// future notification-center endpoints instead of adding a payload field).
//
// Kinds are open strings; the center (agent 2-e) groups them with icons and
// filters. audienceRole targets who should act; readAt is the read timestamp.

import type { Notification } from '@prisma/client'

// ---- domain enums (open sets — new kinds are append-only) ----

export type NotificationKind =
  | 'recap' | 'milestone' | 'variation' | 'anomaly' | 'comment' | 'attendance'
  | 'share' | 'system'
  // v2 procurement / land kinds:
  | 'approval.requested' | 'approval.decided' | 'quote.received' | 'order.confirmed'
  | 'delivery.dispatched' | 'delivery.discrepancy' | 'invoice.submitted'
  | 'invoice.paid' | 'price.alert' | 'digest.weekly' | 'risk.flagged'

export type NotificationChannel = 'in_app' | 'whatsapp' | 'sms' | 'push'
export type AudienceRole = 'client' | 'contractor' | 'supervisor' | 'finance' | 'all'

// ---- slice shapes ----

/** The notify slice — used by the notify service + notification center (2-e). */
export interface NotifySlice {
  notifications: Notification[]
  unreadCount: number
}

export const EMPTY_NOTIFY_SLICE: NotifySlice = { notifications: [], unreadCount: 0 }

/** Options when emitting a notification (all optional except title/body). */
export interface NotifyOptions {
  kind?: string
  audienceRole?: string
  recipient?: string
  channel?: string
}
