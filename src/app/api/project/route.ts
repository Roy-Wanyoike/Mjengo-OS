// Thin shim — the project payload + §57 unified timeline live in
// src/backend/api/project.ts (route-kit public route: rate limit →
// session-or-?share= token → tenant pinning).
export { GET } from '@/backend/api/project'

export const dynamic = 'force-dynamic'
