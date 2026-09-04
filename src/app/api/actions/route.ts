// Thin shim — the owner-action implementation lives in src/backend/api/actions.ts
// (route-kit: rate limit → session-or-shareToken branching → idempotency → apply).
export { POST } from '@/backend/api/actions'

export const dynamic = 'force-dynamic'
