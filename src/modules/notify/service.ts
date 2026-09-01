// Notifications module — service layer.
//
// The single notify() entry point every domain SHOULD call on events
// (A-2-lite "events" — in-app rows now, WhatsApp/SMS delivery log later).
// Domains seeded in F-1 write rows with these kinds:
//
//   supply events:  approval.requested / approval.decided / quote.received /
//                   order.sent / order.confirmed / delivery.dispatched /
//                   delivery.discrepancy
//   invoice events: invoice.submitted / invoice.paid
//   intel events:   price.alert / digest.weekly / risk.flagged
//   platform kinds: milestone, variation, comment, recap, attendance, share…
//
// Rules: notifications are per-project scoped; audienceRole says WHO should
// act (client, contractor, finance, all); `read`/`readAt` are set by the
// notification-center mark-read path (/api/notifications — a client-side
// convenience route, not a domain mutation). WhatsApp/SMS channels are
// DELIVERY LOG STUBS — no provider is called.

import { db } from '@/lib/db'
import type { NotifyOptions } from './types'

/**
 * Emit an in-app notification for a project event. Call this from action
 * handlers — never write db.notification rows directly from feature code.
 *
 * deliveryStatus defaults to 'logged' — an honest in-app row exists; no
 * external provider (WhatsApp/SMS/push) has actually been contacted. When a
 * provider is wired, call markDelivered() with the real outcome.
 */
export async function notify(
  projectId: string,
  title: string,
  body: string,
  opts?: NotifyOptions,
): Promise<{ id: string }> {
  const row = await db.notification.create({
    data: {
      projectId,
      kind: typeof opts?.kind === 'string' && opts.kind ? opts.kind : 'system',
      title,
      body,
      channel: typeof opts?.channel === 'string' && opts.channel ? opts.channel : 'in_app',
      deliveryStatus: typeof opts?.deliveryStatus === 'string' && opts.deliveryStatus ? opts.deliveryStatus : 'logged',
      recipient: typeof opts?.recipient === 'string' ? opts.recipient : null,
      audienceRole: typeof opts?.audienceRole === 'string' ? opts.audienceRole : null,
    },
  })
  return { id: row.id }
}

/**
 * Update a notification's delivery state — the seam for a future provider
 * (WhatsApp/SMS/push) to report the real outcome. 'sent' stamps deliveredAt;
 * any other status just records the state honestly.
 */
export async function markDelivered(
  id: string,
  status: 'logged' | 'sent' | 'failed',
): Promise<{ id: string; deliveryStatus: string } | null> {
  try {
    const row = await db.notification.update({
      where: { id },
      data: { deliveryStatus: status, ...(status === 'sent' ? { deliveredAt: new Date() } : {}) },
    })
    return { id: row.id, deliveryStatus: row.deliveryStatus }
  } catch {
    return null // row gone (deleted project) — nothing to update
  }
}

/**
 * Bulk mark-read for a project — the server-side half of the notification
 * center. Sets BOTH `read` (drives the bell badge) and `readAt` (only where
 * it was still null, so the first-read timestamp is preserved).
 */
export async function markRead(
  projectId: string,
  ids: string[] | 'all',
): Promise<{ updated: number }> {
  const where = ids === 'all' ? { projectId, read: false } : { projectId, id: { in: ids }, read: false }
  const result = await db.notification.updateMany({ where, data: { read: true, readAt: new Date() } })
  return { updated: result.count }
}

/** Mark every notification of a project read (legacy readAll semantics). */
export async function markAllRead(projectId: string): Promise<{ updated: number }> {
  return markRead(projectId, 'all')
}
