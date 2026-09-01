import type { ActionType } from '@/lib/mjengo'

/**
 * Actions a CLIENT may perform — the site-team/owner surface can do these plus
 * everything else. Kept in a server-safe module (no 'use client' imports) so the
 * API routes and the zustand store share ONE list; use-mjengo.ts re-exports it.
 */
export const CLIENT_ACTIONS: readonly ActionType[] = [
  'milestone.decide',
  'variation.decide',
  'comment.add',
  'notification.read',
  'notification.readAll',
  // Invoice lifecycle (2-d): the client decides submitted invoices and
  // records payments — Finder spec §8-§10 ("client pays invoices"). Draft
  // work (create/update/submit) stays site-team.
  'invoice.decide',
  'invoice.pay',
  // Payment requests (F-MONEY): client-role users decide and pay them (mirrors
  // invoice.decide / invoice.pay). Share-link clients stay on the route allowlist.
  'payment.decide',
  'payment.pay',
]
