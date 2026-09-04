// Thin shim — the offline-sync implementation lives in src/backend/api/sync.ts
// (route-kit: guard → 30/min rate limit → body → deterministic conflict rules).
export { POST } from '@/backend/api/sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
