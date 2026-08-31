// Notifications module — service layer (stub, phase-2 agent 2-e fills this in).
//
// Purpose: the single notify() entry point every domain calls on events
// (A-2-lite "events" — in-app rows now, WhatsApp/SMS delivery log later):
//
//   notify(projectId, { kind, title, body, audienceRole?, recipient?, channel? })
//
//   - supply events:  approval.requested / approval.decided / quote.received /
//     order.confirmed / delivery.dispatched / delivery.discrepancy
//   - invoice events: invoice.submitted / invoice.paid
//   - intel events:   price.alert / digest.weekly / risk.flagged
//   - existing kinds (milestone, variation, comment, recap…) keep working
//
// Rules: notifications are per-project scoped; audienceRole says WHO should
// act (client, contractor, finance); read + readAt are set by
// notification.read / readAll actions (already client-allowlisted).
// WhatsApp/SMS channels are DELIVERY LOG STUBS — no provider is called.

import { db } from '@/lib/db'
import type { NotifyOptions } from './types'

/**
 * Emit a notification for a project event. Stub — phase 2 (agent 2-e).
 * Feature agents call this from their action handlers; never write
 * db.notification rows directly.
 */
export async function notify(_projectId: string, _title: string, _body: string, _opts?: NotifyOptions) {
  await db.$queryRaw`SELECT 1` // placeholder so the db import is used; remove when implementing
  throw new Error('Not implemented yet — landing with phase 2')
}

/** Bulk mark-read (used by notification.readAll). Stub — phase 2 (agent 2-e). */
export async function markAllRead(_projectId: string) {
  throw new Error('Not implemented yet — landing with phase 2')
}
