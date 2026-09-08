// Thin shim — the web push unsubscribe surface (revoke the stored row) lives
// in src/backend/api/push.ts (route-kit: guard → rate limit → zod
// strictObject → deleteMany scoped to the session user).
export { POSTUnsubscribe as POST } from '@/backend/api/push'

export const dynamic = 'force-dynamic'
