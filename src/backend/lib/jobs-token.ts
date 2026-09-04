// Bearer-token auth for the background-job runner (POST /api/jobs/run).
//
// An external scheduler — the docker-compose `jobs-tick` sidecar, the
// deploy/systemd timer, any cron (see DEPLOYMENT.md "Background jobs
// scheduler") — cannot hold a NextAuth session, so the endpoint ALSO
// accepts an opt-in machine credential when the server sets
// JOBS_RUN_TOKEN:
//     Authorization: Bearer <JOBS_RUN_TOKEN>
// The session path (withGuard: contractor/admin) is untouched — this
// module only powers the additional machine path.
//
// FAIL CLOSED, NO DEFAULT TOKEN: when JOBS_RUN_TOKEN is unset or empty,
// no presented credential can ever match — the bearer path is disabled
// entirely and the route behaves exactly as it did before.
//
// Everything here is a pure function (header string + configured token
// in, verdict out) so the auth decision is unit-testable without
// building a request or seeding process.env — the route passes
// `req.headers.get('authorization')` and `process.env.JOBS_RUN_TOKEN`.

import { timingSafeEqual } from 'node:crypto'

/**
 * Extract the bearer token from an Authorization header value:
 * `Bearer <token>` (scheme is case-insensitive per RFC 7235, any run of
 * spaces/tabs may separate it from the token). Anything else — Basic
 * schemes, a bare "Bearer", null/undefined/empty — is "no bearer
 * credential presented" and yields null.
 */
export function bearerTokenFromAuthorization(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const match = /^Bearer[ \t]+(.+)$/i.exec(value.trim())
  return match ? match[1].trim() : null
}

/**
 * Constant-time equality of two secrets. `crypto.timingSafeEqual` only
 * accepts buffers of EQUAL length (it throws otherwise), so the lengths
 * are compared first — that leaks the token's LENGTH (not its content)
 * to a timing observer, the standard trade-off of the length-matched-
 * buffer approach. An empty secret is never a match.
 */
export function secretsMatch(presented: string, configured: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(configured, 'utf8')
  if (a.length === 0 || a.length !== b.length) return false // fail fast, never throw
  return timingSafeEqual(a, b)
}

/**
 * The full bearer verdict for POST /api/jobs/run as ONE pure function:
 * does this Authorization header authenticate against this configured
 * token? False whenever a bearer credential is not presented, the
 * credential is not a bearer token, or the path is disabled (unset or
 * empty configured token) — never an accidental grant.
 */
export function jobsBearerTokenMatches(
  authorizationHeader: string | null | undefined,
  configuredToken: string | null | undefined,
): boolean {
  const presented = bearerTokenFromAuthorization(authorizationHeader)
  if (presented === null) return false // no bearer credential presented
  if (!configuredToken) return false // path disabled — fail closed, no default token
  return secretsMatch(presented, configuredToken)
}
