// Dev quickstart fallback for NEXTAUTH_SECRET (issue #94).
//
// PROBLEM (browser-verified during QA): a fresh cloner who sets no env at
// all can sign in (next-auth v4 mints the session JWT with its INTERNAL
// fallback secret), but every guarded API 401s — `guard.ts` passed
// `secret: process.env.NEXTAUTH_SECRET` = undefined to `getToken`, which
// cannot decode the JWE. Logged in, but the app shows an empty shell.
//
// FIX (issue #94, option 1 — mirror the minting side): next-auth v4.24's
// `createSecret` (core/lib/utils.js) falls back to
//   sha256(JSON.stringify({ ...url, ...authOptions }))
// where `url` is `parseUrl(detectOrigin(host, proto))` — a plain object —
// and `authOptions` is OUR `buildAuthOptions(secureCookies)` (functions are
// dropped by JSON.stringify, so callbacks/authorize never take part). This
// module mirrors that derivation EXACTLY so `getToken` in the guard can
// verify the same tokens next-auth minted.
//
// SCOPE/POSTURE:
//   · DEV/TEST ONLY — and that means an EXPLICIT `NODE_ENV=development` or
//     `NODE_ENV=test` (audit-2 SEC-2: the old `NODE_ENV !== 'production'`
//     check accepted the fallback on any OTHER runtime too — staging,
//     preview, docker `dev`, or an unset NODE_ENV — where this
//     publicly-derivable key would verify forged admin JWTs). Every other
//     runtime is treated as unauthenticated: candidates() is empty, the
//     guard 401s, and ONE loud console.error per process explains that
//     NEXTAUTH_SECRET must be set.
//   · In production the boot guard (#74) already throws at module load when
//     the secret is missing/short — fail closed. If that guard is bypassed
//     somehow, this module still refuses to derive (candidates = []) and
//     guarded routes keep 401ing.
//   · NEXTAUTH_SECRET set (any env) → no candidates — current behavior is
//     untouched, byte for byte.
//   · The derivation is DETERMINISTIC for the fresh-cloner case: with no
//     NEXTAUTH_URL/VERCEL/AUTH_TRUST_HOST, v4's detectOrigin returns
//     undefined and parseUrl substitutes its hard-coded default
//     (http://localhost:3000/api/auth) — not per-request. With env vars
//     set, the mirror reads the SAME env + request headers next-auth saw.
//   · A small candidate SET covers the two authOptions cookie variants
//     (http/https) × the request-derived and default origins — at most 4
//     JWJ decrypt attempts, each null-safe (`getToken` returns null on a
//     wrong key instead of throwing).
//
// Verified against next-auth 4.24.15 sources: core/lib/utils.js
// (createSecret), utils/parse-url.js, utils/detect-origin.js; the session
// JWT is encoded/decoded SALT-FREE (only OAuth state/PKCE cookies salt).
// tests/unit/nextauth-fallback-secret.test.ts pins the mirror against
// next-auth's own createSecret as a golden test — if v4 changes its
// derivation on an upgrade, the test fails and this file must be revisited.

import { createHash } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { buildAuthOptions } from '@/backend/lib/auth'

/** Dev/test only — the fallback applies ONLY to an explicit development/test runtime (SEC-2). */
export function isDevRuntime(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
}

/**
 * SEC-2: ONE loud console.error per process (per runtime mode) when the
 * forgeable fallback would have been consulted on a non-dev runtime with no
 * env secret — the operator of a staging/preview/misconfigured deployment
 * gets an actionable line instead of silent 401s. The warned runtime is
 * remembered (not a plain boolean) so a test that flips NODE_ENV back and
 * forth still sees the warning exactly once per stretch — in a real process
 * the runtime never changes, so this is once per process.
 */
let warnedNonDevRuntime: string | undefined

function warnFallbackRejectedOnce(): void {
  const runtime = process.env.NODE_ENV ?? '<unset>'
  if (warnedNonDevRuntime === runtime) return
  warnedNonDevRuntime = runtime
  console.error(
    `[auth] NEXTAUTH_SECRET is not set and NODE_ENV is "${runtime}" — the ` +
      `next-auth dev fallback secret is PUBLICLY DERIVABLE from the repo source, ` +
      `so session verification refuses it outside development/test. Every guarded ` +
      `API will answer 401 until a real secret is set. Generate one ` +
      `(openssl rand -hex 32), set NEXTAUTH_SECRET in the deployment environment, ` +
      `and restart.`,
  )
}

/** Mirror of next-auth v4 `utils/detect-origin.js` (4.24.x). */
export function detectOriginMirror(
  host: string | null,
  proto: string | null,
): string | undefined {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL
  const trustHost = process.env.VERCEL ?? process.env.AUTH_TRUST_HOST
  if (trustHost) return `${proto === 'http' ? 'http' : 'https'}://${host ?? ''}`
  return process.env.NEXTAUTH_URL
}

/** Serializable shape of next-auth v4 `utils/parse-url.js` (4.24.x). */
export function parseUrlMirror(url: string | undefined): {
  origin: string
  host: string
  path: string
  base: string
} {
  const defaultUrl = 'http://localhost:3000/api/auth'
  let u = url
  if (u && !u.startsWith('http')) u = `https://${u}`
  const parsed = new URL(u ?? defaultUrl)
  const path = (parsed.pathname === '/' ? '/api/auth' : parsed.pathname).replace(/\/$/, '')
  return {
    origin: parsed.origin,
    host: parsed.host,
    path,
    base: `${parsed.origin}${path}`,
  }
}

/** Mirror of next-auth v4 `core/lib/utils.js createSecret` fallback. */
export function fallbackSecret(
  authOptions: object,
  url: { origin: string; host: string; path: string; base: string },
): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...url, ...authOptions }))
    .digest('hex')
}

/**
 * Candidate fallback secrets for the dev quickstart without NEXTAUTH_SECRET.
 * Empty whenever the fallback must not run (secret set, or any runtime other
 * than an explicit development/test — SEC-2).
 */
export function devFallbackSecretCandidates(req: NextRequest): string[] {
  // Any resolvable env secret (NEXTAUTH_SECRET or v4's AUTH_SECRET alias —
  // same precedence the route handler uses) means no fallback is needed.
  if (process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET) return []
  if (!isDevRuntime()) {
    // SEC-2: staging / preview / unset NODE_ENV — the deterministic fallback
    // is forgeable from public source, so verification fails closed here.
    warnFallbackRejectedOnce()
    return []
  }
  // A dev/test runtime consults the fallback silently — the documented #94
  // quickstart posture. The reset keeps the once-per-stretch warning honest
  // for tests that flip NODE_ENV; a real runtime never changes mid-process.
  warnedNonDevRuntime = undefined

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  const proto = req.headers.get('x-forwarded-proto')

  // Origins next-auth could have derived the minting secret from: the
  // request-derived one (when AUTH_TRUST_HOST/VERCEL is set) and v4's
  // hard-coded localhost default (no env). Set-deduped.
  const origins = new Set<string | undefined>([detectOriginMirror(host, proto), undefined])

  const candidates: string[] = []
  for (const origin of origins) {
    const url = parseUrlMirror(origin)
    // buildAuthOptions varies by cookie policy (http vs https) — the
    // minting side picks per request protocol, so try both variants.
    candidates.push(fallbackSecret(buildAuthOptions(false), url))
    candidates.push(fallbackSecret(buildAuthOptions(true), url))
  }
  return candidates
}
