// Idempotency-Key principal scoping (issue #177 / audit SEC-10) — the ONE
// seam every IdempotencyRecord write and lookup derives its keyspace from.
//
// BEFORE #177 the replay keyspace was GLOBAL (`key` alone was unique): one
// actor's caller-chosen key could collide with / claim another actor's
// replay record — a foreign actor presenting someone else's key received
// that actor's stored result (a cross-actor information oracle), and
// owner-role sessions additionally received the full current project
// payload of whatever project the key belonged to. Money was never
// re-applied, but the confusion hazard was real.
//
// AFTER #177 the record is keyed by the composite (principal, scope, key)
// — Prisma's `@@unique([principal, scope, key])` — and this module is the
// single place the principal string is derived, so the write and the lookup
// cannot drift. A foreign actor's (principal, scope, key) simply MISSES:
// their request is treated as fresh (a new record lands in THEIR
// namespace), never a cross-actor replay.
//
// Principal grammar (stable, collision-free across kinds — the kind prefix
// is part of the string, never a bare email/id):
//   user:<email>                 — a signed-in session (email lowercased,
//                                  the same identity convention as the
//                                  rate limiter's principalFor)
//   user:<email>|<resource>      — the same actor scoped to the resource
//                                  the route acts on (wallet:<id>,
//                                  wallets:<from>><to>, payment:<id>,
//                                  project:<id|none>) — replay protection
//                                  is per wallet/actor on the v1 money
//                                  routes, per project/actor on /api/actions
//   share:<sha256(token)>        — a share-link caller (hash, never the raw
//                                  secret — the token already lives on the
//                                  Project row; rotating the link mints a
//                                  fresh principal by construction)
//   sync:<projectId|global>      — the offline-outbox dedupe markers; the
//                                  key itself already embeds the project
//                                  (`sync:<projectId>:<itemId>`), and this
//                                  derivation matches that segment exactly
//                                  so migration 17's backfill preserved
//                                  every existing marker's replay
//   system                       — server-generated internal markers (the
//                                  Daraja intent/callback/unresolved rows,
//                                  keyed by provider refs, never
//                                  caller-chosen)
//   legacy                       — pre-#177 caller-key rows backfilled by
//                                  migration 17; UNREACHABLE by the
//                                  namespaced lookups (fail-closed — see
//                                  the migration's header for the honest
//                                  in-flight-retry story)
import { createHash } from 'node:crypto'
import type { GuardSession } from './guard'

/**
 * Session principal — `user:<email>` (the stable identity; mirrors
 * rate-limit.ts principalFor's convention, email lowercased so a case-swapped
 * login cannot fork an actor's keyspace). `resource` optionally scopes the
 * SAME actor to the thing the route acts on (a wallet, a payment request, a
 * project) per the issue's "per wallet/actor" requirement: the same key
 * presented against a DIFFERENT resource is a fresh request, not a replay of
 * the other resource's stored result.
 */
export function principalForSession(
  session: { user: { email: string } },
  resource?: string | null,
): string {
  const base = `user:${session.user.email.trim().toLowerCase()}`
  return resource ? `${base}|${resource}` : base
}

/**
 * Share-link principal — `share:<sha256hex(token)>`. The raw token is never
 * stored here (it is a bearer capability; only its one-way hash rides the
 * idempotency row). Share callers have no session, so the token IS the
 * principal; each minted/rotated link is its own keyspace.
 */
export function shareTokenPrincipal(token: string): string {
  return `share:${createHash('sha256').update(token).digest('hex')}`
}

/**
 * Offline-sync dedupe principal — `sync:<projectId|global>`, matching the
 * project segment the sync keys themselves already carry
 * (`sync:<projectId>:<itemId>` / `syncfp:<projectId>:<type>:<hash>`), so the
 * derivation is stable across migration 17's backfill. These markers are
 * server-generated (never caller-chosen) and store no response body — a
 * cross-actor "replay" here would return a bare ok, nothing to leak; the
 * project segment is the honest scope for the offline dedupe.
 */
export function syncPrincipal(projectId: string | null | undefined): string {
  return `sync:${projectId ?? 'global'}`
}

/** Principal for server-generated internal markers (Daraja intents, callbacks). */
export const SYSTEM_PRINCIPAL = 'system'

/**
 * The /api/actions principal. ONE derivation used by BOTH the replay lookup
 * (top of the route) and the post-apply write, so the two can never disagree:
 *
 *   · session caller — `user:<email>|project:<id|none>`, where the project is
 *     the caller's PINNED project for client-role sessions (the body
 *     projectId is ignored for them, exactly like the fresh-dispatch branch)
 *     and the body projectId for everyone else — the value the write's
 *     targetProjectId will hold for that same caller;
 *   · share-link caller — `share:<sha256(token)>` (the token maps 1:1 to one
 *     project's client grant, so no project suffix is needed — and the replay
 *     lookup runs BEFORE the token is validated, when the project is not
 *     resolved yet);
 *   · null session without a token — null: there is no principal to scope a
 *     replay against, and the request is doomed to 401 in the fresh-dispatch
 *     branch anyway. Skipping the lookup (rather than inventing an 'anon'
 *     keyspace) also closes the pre-#177 behavior where a sessionless,
 *     tokenless caller could replay a stored result with NO auth at all.
 */
export function actionsPrincipal(
  session: GuardSession,
  projectId: string | null | undefined,
  shareToken?: string | null,
): string | null {
  if (!session) {
    return typeof shareToken === 'string' && shareToken ? shareTokenPrincipal(shareToken) : null
  }
  const project =
    session.user.role === 'client' ? session.user.projectId : (projectId ?? null)
  return principalForSession(session, `project:${project ?? 'none'}`)
}
