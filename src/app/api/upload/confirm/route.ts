// Thin shim — the presigned-upload confirmation implementation lives in
// src/backend/api/upload-confirm.ts (same backend-owned pattern as
// /api/upload itself). See that file for the verification contract.
export { POST } from '@/backend/api/upload-confirm'

export const dynamic = 'force-dynamic'
