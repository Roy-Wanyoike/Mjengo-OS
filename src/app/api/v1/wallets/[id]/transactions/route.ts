// Thin shim — the cursor-paginated transaction list lives in
// src/backend/api/v1/wallet-transactions.ts.
export { GET } from '@/backend/api/v1/wallet-transactions'

export const dynamic = 'force-dynamic'
