// Thin shim — project list + create live in src/backend/api/projects.ts
// (route-kit: guard/roles → rate limit on create → zod-style validation).
export { GET, POST } from '@/backend/api/projects'

export const dynamic = 'force-dynamic'
