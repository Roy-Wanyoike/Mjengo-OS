// Thin shim — the supplier-role portal payload lives in
// src/backend/api/supplier.ts (route-kit guarded route: session → supplier
// role + supplierId pin → scoped payload).
export { GET } from '@/backend/api/supplier'

export const dynamic = 'force-dynamic'
