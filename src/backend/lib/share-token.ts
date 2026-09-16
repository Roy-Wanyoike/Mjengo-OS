import { db } from '@/backend/lib/db'

// Share-token lifecycle (issue #172 / SEC-3r residual) — the ONE seam every
// share-token lookup goes through. A share link is a sessionless BEARER
// CAPABILITY that can approve milestone/variation decisions (escrow money),
// so it must not live forever: every mint stamps an expiry, and an expired
// token resolves to exactly what an unknown token resolves to (null → the
// routes' existing 404/401 copy — no oracle, no distinct "expired" answer).
//
// This module owns three things:
//   1. the TTL knob: SHARE_TOKEN_TTL_DAYS (env, default 90, read at CALL time
//      so operators/tests retune without a re-import; invalid/zero/unset →
//      default — never 0/NaN, which would mint already-dead tokens);
//   2. the live-token lookup findLiveProjectByShareToken() — replaces the
//      raw db.project.findUnique({ where: { shareToken } }) at every route
//      seam (share.ts GET/POST, project.ts GET, actions.ts POST);
//   3. the confirm-before-decide gate for money decisions from a link.

/** Default link lifetime (days) when SHARE_TOKEN_TTL_DAYS is unset/invalid. */
const DEFAULT_SHARE_TOKEN_TTL_DAYS = 90

/**
 * Resolve the share-token TTL in days from SHARE_TOKEN_TTL_DAYS. Read at call
 * time (the jobs' resolveHandlerTimeoutMs idiom). A value < 1 or non-numeric
 * falls back to the default — an operator typo never mints dead-on-arrival
 * links.
 */
export function shareTokenTtlDays(): number {
  const raw = Number.parseInt(process.env.SHARE_TOKEN_TTL_DAYS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SHARE_TOKEN_TTL_DAYS
}

/** The expiry Date to stamp on the NEXT mint (creation or regeneration). */
export function shareTokenExpiryFromNow(now: Date = new Date()): Date {
  return new Date(now.getTime() + shareTokenTtlDays() * 24 * 3600 * 1000)
}

/** True when the row's token is past its expiry (NULL = grandfathered → false). */
export function isShareTokenExpired(
  project: { shareTokenExpiresAt?: Date | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!project?.shareTokenExpiresAt) return false
  return project.shareTokenExpiresAt.getTime() <= now.getTime()
}

/**
 * Resolve a share token to its project, LIVE-only: the token must exist AND
 * not be past its expiry. An expired token answers null — byte-identical to
 * an unknown token at every caller (the 404 'Invalid or expired link' family
 * / project.ts's 401), so a leaked-then-expired link is indistinguishable
 * from one that was never real (no existence oracle).
 *
 * NULL shareTokenExpiresAt = a grandfathered token (minted before migration
 * 11 / by seeds): it keeps the historical never-expires contract and picks up
 * a TTL the moment the link is rotated (share.regenerate re-stamps both the
 * token and its expiry) — see prisma/migrations/11_share_token_expiry.
 */
export async function findLiveProjectByShareToken(token: string, now: Date = new Date()) {
  const project = await db.project.findUnique({ where: { shareToken: token } })
  if (!project) return null
  return isShareTokenExpired(project, now) ? null : project
}

// ---- confirm-before-decide (money decisions from a bearer link) -----------

/**
 * Decision-grade client actions: from a share link these release escrow
 * (milestone.decide approve) or move the budget (variation.decide approve),
 * so the server demands an explicit `confirm: true` in the payload — a link
 * should let a client LOOK; deciding takes intent. The logged-in client-role
 * path (session-gated, own dialog flow) is NOT affected.
 */
export const SHARE_DECISION_ACTIONS: readonly string[] = ['milestone.decide', 'variation.decide']

/**
 * True when this share-link dispatch is a money decision WITHOUT the explicit
 * confirmation flag. STRICTLY `confirm === true` — a truthy string or 1 is
 * not an explicit confirmation. Callers refuse with the honest 400 below
 * (the share error family: 400/403/404).
 */
export function shareDecisionMissingConfirm(type: string, payload: unknown): boolean {
  if (!SHARE_DECISION_ACTIONS.includes(type)) return false
  return (payload as { confirm?: unknown } | null | undefined)?.confirm !== true
}

/** The honest refusal copy for an unconfirmed share-link money decision. */
export const SHARE_DECISION_CONFIRM_ERROR =
  'Money decisions from a share link require an explicit confirmation — retry with confirm: true after reviewing the decision dialog'
