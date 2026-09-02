// Shared helpers for the dashboard subfiles (kept prisma-light so the card
// imports stay client-clean).

import { formatKES } from '@/frontend/lib/format'

export const formatKes = formatKES

const ROLE_LABELS: Record<string, string> = {
  supervisor: 'Site Supervisor',
  contractor: 'Contractor',
  client: 'Client',
  finance: 'Finance',
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role
}
