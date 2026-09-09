// Thin shim — the web push subscribe surface (config probe GET + subscribe
// POST) lives in src/backend/api/push.ts (route-kit: guard → rate limit →
// zod strictObject → upsert on the endpoint).
export { GET, POST } from '@/backend/api/push'

export const dynamic = 'force-dynamic'
