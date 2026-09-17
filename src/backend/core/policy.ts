/**
 * Authorization + transport policy for MjengoOS APIs.
 *
 * ROLE MODEL (see prisma schema · User.role)
 *  · contractor — the site team / owner. Full control of site tools.
 *  · admin      — platform staff. Same API surface as contractor.
 *  · client     — the buyer. Read-mostly view of THEIR project only,
 *                 plus the client-decision allowlist (see lib/client-actions).
 *
 * CLIENT_HIDDEN_TABS in the frontend (copilot/supply/intel/ussd) must always
 * be mirrored here by SITE_ROLES on the matching APIs — hiding a tab is UI,
 * rejecting the call is security.
 */

/** APIs only the site team may call (supply, intel, ussd, copilot, sync…). */
export const SITE_ROLES = ['contractor', 'admin'] as const

/** Every authenticated role (client included) — e.g. the land read surface. */
export const SIGNED_IN_ROLES = ['contractor', 'client', 'admin'] as const

/**
 * Rate-limit presets (requests per minute, per user or per IP).
 * Generous vs. real usage — they exist to stop scripts, not people.
 */
export const LIMITS = {
  /** Cheap authenticated reads (SQLite, indexed). */
  read: { limit: 240, windowMs: 60_000 },
  /** Substantive writes (orders, verifications, reviews). */
  write: { limit: 30, windowMs: 60_000 },
  /** Registry lookups (title / professional boards). */
  search: { limit: 20, windowMs: 60_000 },
  /** USSD simulator keypresses — one flow can be ~10 calls. */
  ussd: { limit: 90, windowMs: 60_000 },
  /** LLM-backed copilot calls cost real money per request. */
  ai: { limit: 12, windowMs: 60_000 },
  /** Photo uploads (base64 bodies). */
  upload: { limit: 20, windowMs: 60_000 },
  /** Offline queue flushes. */
  sync: { limit: 30, windowMs: 60_000 },
  /**
   * The action dispatcher (POST /api/actions) — the store's single write path
   * and the sync fallback for offline queues; one burst can carry dozens of
   * queued actions, so it sits well above LIMITS.write.
   */
  actions: { limit: 120, windowMs: 60_000 },
  /** Unauthenticated share-link reads (also brute-force guard for tokens). */
  share: { limit: 30, windowMs: 60_000 },
  /** Public health checks. */
  health: { limit: 60, windowMs: 60_000 },
} as const
