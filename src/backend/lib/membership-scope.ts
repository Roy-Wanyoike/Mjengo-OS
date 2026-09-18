// Issue #174 (SEC-6) — project-membership read scoping for the site team.
//
// THE CONTRACT (mirrors the client/supplier pins, deliberately — every
// tenant-scoping seam in this codebase follows the same shape):
//   · PORTFOLIO GRANT: contractor/admin read the whole portfolio by an
//     EXPLICIT grant (they run the business, not one site — the W1-PERM
//     role matrix). This is code, not data: no membership row is ever
//     consulted for them, so an empty ProjectMembership table can never
//     widen or narrow their scope.
//   · MEMBERSHIP SCOPE: supervisor/procurement/qs/finance read EXACTLY the
//     projects where a ProjectMembership row exists for their session's
//     userId. FAIL CLOSED: a membership-role session with zero rows sees
//     the honest empty portfolio (empty list, no default project), never
//     everything — the same posture as a client with no pinned project and
//     a supplier with no linked Supplier row.
//   · client/supplier sessions are NOT membership-scoped here: they keep
//     their own session stamps (guard.ts sessionSupplierId / the
//     user.projectId pin), which stay the single source of their pins.
//   · WORKER PII: idNumber / emergencyContactName / emergencyContactPhone
//     are readable ONLY by membership-holders of that worker's project,
//     contractor/admin (portfolio grant) and the project's own client —
//     every other reader gets the fields as nulls (the worker's
//     non-PII roster data stays readable per the read scope above; the
//     null is indistinguishable from a worker with no PII recorded, so
//     the strip leaks nothing).
//
// Called from the v1 project-scoped read families (via
// src/backend/api/v1/scope.ts membershipProjectDenied), /api/project,
// /api/projects, /api/v1/projects and the /api/sync payload refresh — the
// READ surfaces. Mutations (/api/actions, /api/sync outbox items) are NOT
// membership-gated yet: that is the recorded follow-up in SECURITY.md
// (single-org posture, issue #174).
//
// SINGLE-ORG ACCEPTED RISK (SEC-6): the seed (prisma/seed-extras/
// memberships.ts) plants every site-team persona on every seeded project so
// the demo journeys do not regress. Revisit when onboarding becomes
// multi-org or external professionals get accounts — see SECURITY.md.

import { db } from '@/backend/lib/db'

/**
 * Owner roles that keep the PORTFOLIO-WIDE read grant (issue #174): they run
 * the business across all sites. Deliberately NOT derived from OWNER_ROLES
 * (guard.ts) — that list is the "may boot the owner app" matrix; this one is
 * the read-scope split of it, and the two must be able to drift apart
 * without silently re-granting portfolio reads.
 */
export const PORTFOLIO_GRANT_ROLES: readonly string[] = ['contractor', 'admin']

/**
 * Site-team roles whose project READS are membership-scoped (issue #174):
 * supervisor, procurement, qs, finance. They see exactly the projects their
 * ProjectMembership rows name — fail closed on zero rows.
 */
export const MEMBERSHIP_ROLES: readonly string[] = ['supervisor', 'procurement', 'qs', 'finance']

/** Session shape every helper here accepts (GuardSession's user, structurally). */
export type ScopedSession = { user: { id: string; role: string; projectId?: string | null } }

/** The resolved owner-side read scope of one session. */
export type OwnerReadScope =
  /** contractor/admin — the explicit portfolio-wide grant (no row consult). */
  | { kind: 'portfolio' }
  /** supervisor/procurement/qs/finance — EXACTLY these projects ([] = honest empty portfolio). */
  | { kind: 'memberships'; projectIds: string[] }
  /** every other role (client/supplier pin themselves elsewhere; unknown roles keep the route's own contract). */
  | { kind: 'unpinned' }

/**
 * Resolve the membership project ids for one user — the exact set of their
 * ProjectMembership rows, ordered by grant time (createdAt ASC) so the
 * "first membership" default below is deterministic.
 */
async function membershipProjectIds(userId: string): Promise<string[]> {
  const rows = await db.projectMembership.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { projectId: true },
  })
  return rows.map((r) => r.projectId)
}

/**
 * Resolve a session's owner-side read scope (SEC-6). Pure classification
 * first (portfolio roles never touch the membership table — the grant is
 * code, not data); membership roles read their rows once.
 */
export async function ownerReadScope(session: ScopedSession): Promise<OwnerReadScope> {
  if ((PORTFOLIO_GRANT_ROLES as readonly string[]).includes(session.user.role)) {
    return { kind: 'portfolio' }
  }
  if ((MEMBERSHIP_ROLES as readonly string[]).includes(session.user.role)) {
    return { kind: 'memberships', projectIds: await membershipProjectIds(session.user.id) }
  }
  return { kind: 'unpinned' }
}

/**
 * May this session READ project `projectId` on the owner side? (client /
 * supplier / unknown roles answer false here — their pins live in their own
 * helpers; callers apply those first, exactly like the v1 scope chain.)
 */
export async function mayReadProject(session: ScopedSession, projectId: string): Promise<boolean> {
  const scope = await ownerReadScope(session)
  if (scope.kind === 'portfolio') return true
  if (scope.kind === 'memberships') return scope.projectIds.includes(projectId)
  return false
}

/**
 * Does this session HOLD a ProjectMembership row on `projectId`? Answers
 * FALSE for every non-membership role (the v1 membership pin fires only for
 * supervisor/procurement/qs/finance — client/supplier pins are their own
 * helpers, contractor/admin hold the portfolio grant and never consult
 * rows).
 */
export async function membershipHeld(session: ScopedSession, projectId: string): Promise<boolean> {
  if (!(MEMBERSHIP_ROLES as readonly string[]).includes(session.user.role)) return false
  const row = await db.projectMembership.findUnique({
    where: { userId_projectId: { userId: session.user.id, projectId } },
    select: { id: true },
  })
  return row !== null
}

/**
 * May this session see the WORKER PII fields (idNumber,
 * emergencyContactName, emergencyContactPhone) of a worker on `projectId`?
 *
 * YES for: contractor/admin (the portfolio grant), a membership-holder of
 * that exact project, and the project's own client (their workforce — the
 * pre-#174 behavior, unchanged). NO for everyone else — the fields read as
 * nulls (worker-detail.ts), which is byte-identical to a worker with no PII
 * recorded, so the strip is not itself an oracle.
 */
export async function maySeeWorkerPii(session: ScopedSession, projectId: string): Promise<boolean> {
  if ((PORTFOLIO_GRANT_ROLES as readonly string[]).includes(session.user.role)) return true
  if (session.user.role === 'client') return session.user.projectId === projectId
  if (!(MEMBERSHIP_ROLES as readonly string[]).includes(session.user.role)) return false
  const row = await db.projectMembership.findUnique({
    where: { userId_projectId: { userId: session.user.id, projectId } },
    select: { id: true },
  })
  return row !== null
}
