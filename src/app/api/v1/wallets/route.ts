// Thin shim — v1 wallet list + create live in src/backend/api/v1/wallets.ts
// (route-kit: FINANCE_ROLES → v1 rate limits → zod strictObject bodies →
// mapServiceError). Shared v1 helpers: ../respond + ../schemas (same dir).
export { GET, POST } from '@/backend/api/v1/wallets'

export const dynamic = 'force-dynamic'
