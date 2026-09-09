// Thin shim — the admin audit-log reader lives in src/backend/api/audit.ts
// (route-kit: admin-only → 60/min → keyset pagination + filters). READ-ONLY
// BY DESIGN — see the backend module's immutability note.
export { GET } from '@/backend/api/audit'

export const dynamic = 'force-dynamic'
