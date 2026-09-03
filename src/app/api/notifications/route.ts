// Thin shim — the notification center (mark-read, listing, prefs) lives in
// src/backend/api/notifications.ts (route-kit: guard → per-verb rate limits →
// body contract per verb → safeErrorMessage redaction).
export { GET, POST, PUT } from '@/backend/api/notifications'

export const dynamic = 'force-dynamic'
