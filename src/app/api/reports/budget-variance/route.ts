// Thin shim — the budget-variance report lives in
// src/backend/api/budget-variance.ts (route-kit: QS/site-team roles →
// 30/min → required projectId → 404 unknown project).
export { GET } from '@/backend/api/budget-variance'

export const dynamic = 'force-dynamic'
