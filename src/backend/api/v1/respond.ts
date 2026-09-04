// /api/v1 response helpers (spec §64 API QUALITY — consistent errors,
// pagination, rate limiting; B5-APIV1). src/app/api/v1/respond.ts was the
// old home — moved into src/backend/api/v1/ by the backend reorg (W-BACKEND);
// the v1 route shims now re-export handlers from this directory.
//
// ERROR SHAPE (deliberate, kept consistent across the whole v1 surface):
//   every error  → { error: string, field?: string [, retryAfterSec?] }
// This matches the shared guard (src/backend/lib/guard.ts 401/403) and rate-limit
// (src/backend/lib/rate-limit.ts 429) bodies exactly, so ALL /api/v1 errors share one
// contract. Success responses keep the wallet-module contract
// { ok: true, data, ... } (modules/wallet/http.ts jsonOk) — the `ok` flag
// means success; errors simply do not carry it. The previous jsonErr-style
// `{ ok: false, error }` bodies are intentionally replaced by this single
// shape (B5-APIV1 audit: shapes differed between routes).
//
// STATUS CODES:
//   400 zod validation / bad cursor / business-rule message (service, honest)
//   401 no session (guard) · 403 role/tenant (guard + client pinning)
//   404 unknown wallet / payment request (message-mapped — see below)
//   422 structurally valid but nonsensical request (e.g. same-wallet transfer)
//   429 rate limited (enforceRateLimit via route-kit's rateLimit slot, per-principal token bucket)
//   500 unexpected failure — generic honest message, details in server logs
//   409 is NOT produced today: a repeated Idempotency-Key unconditionally
//   replays the stored response (modules/wallet/http.ts withIdempotency)
//   even when the payload differs — kept as-is (existing behavior), see the
//   OpenAPI Idempotency-Key description.

import { NextResponse } from 'next/server'

/** v1 error body: { error, field? } — one shape for every failure. */
export function v1Err(status: number, error: string, field?: string): NextResponse {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status })
}

/** Service messages that mean "the addressed object does not exist (here)". */
const NOT_FOUND_MESSAGES = new Set([
  'Wallet not found',
  'Wallet belongs to a different project',
  'Payment request not found',
])

/**
 * Catch-all mapping for service exceptions (honest tone, no stack traces):
 * known not-found messages → 404 with the message; other Error messages
 * (business rules: insufficient balance, already paid…) → 400 with the
 * message; anything non-Error / unexpected → 500 generic + server log.
 */
export function mapServiceError(scope: string, e: unknown, fallback: string): NextResponse {
  if (e instanceof Error) {
    if (NOT_FOUND_MESSAGES.has(e.message)) return v1Err(404, e.message)
    return v1Err(400, e.message)
  }
  console.error(`[api/v1 ${scope}]`, e)
  return v1Err(500, fallback)
}

// ---------------------------------------------------------------- rate limiting

/** Reads: 120 requests/min per principal (session email or IP). */
export const V1_READ_LIMIT = 120
/** Money mutations: 30 requests/min per principal — replayed idempotent
 *  requests count too (the limit fires before the replay, like every gate). */
export const V1_MUTATION_LIMIT = 30

// ---------------------------------------------------------------- pagination

export type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean }

/**
 * Keyset pagination for BOUNDED lists (wallet list): slice the full,
 * deterministically ordered array (unique `code` ascending → total order).
 * `cursor` is the wallet id of the last item of the previous page; a cursor
 * that is not in the (possibly filtered) list → 400 (honest: stale or wrong).
 */
export function pageOf<T extends { id: string }>(
  all: T[],
  limit: number,
  cursor?: string,
): { ok: true; page: Page<T> } | { ok: false; response: NextResponse } {
  let start = 0
  if (cursor) {
    const idx = all.findIndex((item) => item.id === cursor)
    if (idx === -1) {
      return {
        ok: false,
        response: v1Err(400, 'Unknown cursor — it must be the id of a wallet in this list', 'cursor'),
      }
    }
    start = idx + 1
  }
  const items = all.slice(start, start + limit)
  const hasMore = start + limit < all.length
  return { ok: true, page: { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null, hasMore } }
}
