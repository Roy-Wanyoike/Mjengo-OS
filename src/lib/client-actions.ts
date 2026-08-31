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
]
