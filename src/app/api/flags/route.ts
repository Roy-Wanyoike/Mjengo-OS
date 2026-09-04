// Thin shim — feature-flag read/toggle lives in src/backend/api/flags.ts
// (route-kit: GET admin+contractor (matches the owner-app popover surface),
// POST admin-only + 10/min rate limit).
export { GET, POST } from '@/backend/api/flags'

export const dynamic = 'force-dynamic'
