// Thin shim — the Virtual Site Visit (share link) implementation lives in
// src/backend/api/share.ts (route-kit public routes: 30/min per principal,
// client-decision allowlist, redacted errors).
export { GET, POST } from '@/backend/api/share'

export const dynamic = 'force-dynamic'
