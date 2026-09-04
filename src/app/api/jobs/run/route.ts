// Thin shim — the background-job runner lives in src/backend/api/jobs.ts
// (route-kit: POST contractor/admin + 10/min + honest unknown-projectId 400;
// GET any role with client tenant pinning).
export { GET, POST } from '@/backend/api/jobs'

export const dynamic = 'force-dynamic'
export const maxDuration = 120
