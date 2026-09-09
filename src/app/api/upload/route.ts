// Thin shim — the upload implementation (legacy photo path + document mode)
// lives in src/backend/api/upload.ts. This completes the backend reorg a
// prior attempt started by deleting the whole route (the merge-conflict root
// cause): the handler is now backend-owned like every other route, with the
// W-AUDIT #4 fixes (raw-body cap before decode, magic-number sniff on the
// photo path) applied there.
export { POST } from '@/backend/api/upload'

export const dynamic = 'force-dynamic'
