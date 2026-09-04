// /api/v1 Phase B — client-role tenant pin (shared by the projects + supply
// resources). Mirrors the v1 payments precedent (payments.ts resolves the
// request first, then 403s a client whose session is not pinned to its
// project) and the webapp's project guard (/api/project pins a client-role
// session to session.user.projectId, ignoring any client-supplied scope).

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
