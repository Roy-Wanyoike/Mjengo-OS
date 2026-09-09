// /api/v1 Phase B — client-role tenant pin (shared by the projects + supply
// resources) + the W5-3 supplier-role pins (project-scope deny / row pins).
// Mirrors the v1 payments precedent (payments.ts resolves the request first,
// then 403s a client whose session is not pinned to its project) and the
// webapp's project guard (/api/project pins a client-role session to
// session.user.projectId, ignoring any client-supplied scope).

import type { NextResponse } from 'next/server'
import { v1Err } from './respond'

/**
 * v1 client-role tenant pin: returns the 403 'Not permitted for this project'
 * response when a CLIENT session may not see `projectId` (no pinned project,
 * or a different one); null for every other role and for the client's own
 * project. Non-client roles are never pinned (the webapp shows them the
 * whole portfolio).
 */
export function clientProjectDenied(
  session: { user: { role: string; projectId: string | null } },
  projectId: string,
): NextResponse | null {
  if (session.user.role !== 'client') return null
  if (!session.user.projectId || session.user.projectId !== projectId) {
    return v1Err(403, 'Not permitted for this project')
  }
  return null
}

/**
 * v1 supplier-role pin (W5-3) for PROJECT-scoped buyer resources — the detail
 * reads the client pin guards (projects/tasks/milestones/escrow). A supplier
 * session is not a project reader at all: none of that data is theirs, so the
 * answer is a uniform 403 for every project id (existing or not — nothing
 * about the project is revealed). Returns null for every other role.
 *
 * The supplier-OWNED families (supply orders/deliveries, invoices) do NOT use
 * this helper — they row-pin instead: a supplier sees exactly their own rows
 * (supply-orders.ts / project-deliveries.ts / project-invoices.ts filter by
 * supplierId; the detail routes 404 a foreign id with the same body as an
 * unknown one — indistinguishable from a miss).
 */
export function supplierProjectDenied(
  session: { user: { role: string } },
): NextResponse | null {
  if (session.user.role !== 'supplier') return null
  return v1Err(403, 'Not permitted for this supplier account')
}

/**
 * v1 supplier-row pin helper (W5-3): the supplierId a supplier session is
 * pinned to, or null when the account has no link. List routes 403 on null
 * (fail closed, mirroring the client no-project pin); detail routes treat a
 * foreign row exactly like a miss (404).
 */
export function supplierSessionId(
  session: { user: { role: string; supplierId?: string | null } },
): string | null {
  if (session.user.role !== 'supplier') return null
  const id = session.user.supplierId
  return typeof id === 'string' && id.trim() ? id.trim() : null
}
