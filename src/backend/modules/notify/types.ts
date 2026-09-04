// Notifications module — types for the notify slice (INTERNAL — the payload
// already carries `notifications`, so this module powers the service layer and
// future notification-center endpoints instead of adding a payload field).
//
// Kinds are open strings; the notification center groups them with icons and
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
  // v3 platform kinds (domain-event bus + background jobs, F-PLATFORM):
  | 'project.delayed' | 'attendance.absent' | 'budget.alert' | 'ledger.reconciled'

export type NotificationChannel = 'in_app' | 'whatsapp' | 'sms' | 'push'
export type AudienceRole = 'client' | 'contractor' | 'supervisor' | 'finance' | 'all'

// ---- slice shapes ----

/** The notify slice — used by the notify service + notification center. */
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
  /** Honest channel state — defaults to 'logged' (in-app row, nothing sent externally). */
  deliveryStatus?: string
  /**
   * Additionally attempt a real SMS delivery to this number (E.164
   * recommended). Only honored when an SMS provider is configured
   * (NOTIFY_SMS_WEBHOOK_URL — see channels.ts); otherwise the row honestly
   * stays 'logged' and nothing is sent. The attempt never throws into the
   * caller — the outcome lands in deliveryStatus/deliveryDetail.
   */
  sms?: { to: string }
}

/** Delivery lifecycle of an external channel row (in-app 'logged' is the default). */
export type DeliveryStatus = 'logged' | 'sent' | 'failed'
