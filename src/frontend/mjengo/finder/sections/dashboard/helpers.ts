// Shared helpers for the dashboard subfiles (kept prisma-light so the card
// imports stay client-clean).

import { formatKES } from '@/frontend/lib/format'
import type { TranslateFn } from '@/frontend/i18n/types'

export const formatKes = formatKES

const ROLE_KEYS: readonly string[] = ['supervisor', 'contractor', 'client', 'finance']

/** Localized role label (role.* dict keys — #125). EN fallback kept for any
 *  role outside the approval-band set (same honesty as before). */
export function roleLabel(role: string, t?: TranslateFn): string {
  if (t && ROLE_KEYS.includes(role)) return t(`role.${role}`)
  const EN: Record<string, string> = {
    supervisor: 'Site Supervisor',
    contractor: 'Contractor',
    client: 'Client',
    finance: 'Finance',
  }
  return EN[role] ?? role
}
