// Thin shim — the presigned-upload implementation lives in
// src/backend/api/upload-presign.ts (same backend-owned pattern as
// /api/upload itself). See that file for the flow contract.
export { POST } from '@/backend/api/upload-presign'

export const dynamic = 'force-dynamic'
