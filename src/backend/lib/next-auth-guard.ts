// Boot guard for NEXTAUTH_SECRET (issue #74, audit BE-2).
//
// NextAuth v4 signs session JWTs with NEXTAUTH_SECRET; without it, v4 THROWS
// in production (auth surface dead) and silently falls back to a weak
// deployment secret in dev. The running environment historically had no
// value set at all (dev.log: `[next-auth][warn][NO_SECRET]`). Other
// fail-closed env checks already exist (JOBS_RUN_TOKEN — src/backend/lib/
// jobs-token.ts, the docker-compose jobs-tick sidecar check); auth had none.
//
// CONTRACT (mirrors the jobs-token posture, one clear BOOT error — NOT a
// per-request check):
//   · NODE_ENV === 'production' (real runtime): a missing or too-short
//     (< 32 chars) NEXTAUTH_SECRET logs ONE clear console.error and THROWS
//     from the module that calls this at load time (the NextAuth route) —
//     the auth routes fail closed with a 500 and an actionable message
//     instead of next-auth's cryptic per-request throw. Session minting is
//     impossible on a weak secret by construction.
//   · Non-production (dev/test): logs ONE console.warn and keeps working —
//     the documented usable-dev behavior.
//   · `next build` (NEXT_PHASE === 'phase-production-build') is EXEMPT: the
//     documented CI invariant is "the build must never need real secrets"
//     (ci.yml / docker.yml build with a dummy NEXTAUTH_SECRET); the guard
//     fires at RUNTIME boot, not while collecting route metadata.
//
// Pure verdict function + one-time enforcement, so the decision is
// unit-testable without a request (same shape as jobs-token.ts).

/** Shortest secret we consider safe to sign 30-day session JWTs with. */
export const MIN_NEXTAUTH_SECRET_LENGTH = 32

/** The build phase Next.js sets while `next build` evaluates route modules. */
const PHASE_PRODUCTION_BUILD = 'phase-production-build'

/** The one clear error/warn log this module is allowed to emit per process. */
const BOOT_ERROR_MESSAGE =
  'NEXTAUTH_SECRET is missing or shorter than 32 characters — production auth ' +
  'cannot start on a weak session secret. Generate one (openssl rand -hex 32, or ' +
  'openssl rand -base64 32), set it in the deployment environment/.env, and restart. ' +
  'Refusing to serve auth routes until then (fail closed, like JOBS_RUN_TOKEN).'

export type NextAuthSecretVerdict =
  | { ok: true }
  | { ok: false; problem: 'missing' | 'too-short'; message: string }

/** Pure secret shape check: 'missing' | 'too-short' | null (acceptable). */
export function nextAuthSecretProblem(
  secret: string | null | undefined,
): 'missing' | 'too-short' | null {
  if (secret === undefined || secret === null || secret.length === 0) return 'missing'
  if (secret.length < MIN_NEXTAUTH_SECRET_LENGTH) return 'too-short'
  return null
}

/**
 * Pure check: does this secret value block this runtime mode? Production
 * fails closed on missing/short values; every other mode passes (dev only
 * warns at enforcement time, never throws).
 */
export function nextAuthSecretVerdict(
  secret: string | null | undefined,
  nodeEnv: string | undefined,
): NextAuthSecretVerdict {
  const problem = nextAuthSecretProblem(secret)
  if (problem === null || nodeEnv !== 'production') return { ok: true }
  return { ok: false, problem, message: BOOT_ERROR_MESSAGE }
}

let bootEnforced = false

/**
 * Enforce the guard ONCE per process at module load of the NextAuth route
 * (src/app/api/auth/[...nextauth]/route.ts). Import-time throw = the auth
 * route fails closed with a clear, actionable boot error; repeat calls are
 * no-ops so the message is logged exactly once, not per request.
 */
export function enforceNextAuthSecretAtBoot(): void {
  if (bootEnforced) return
  bootEnforced = true

  const problem = nextAuthSecretProblem(process.env.NEXTAUTH_SECRET)
  if (problem === null) return

  // `next build` evaluates route modules to collect metadata — the build
  // must never require real secrets (CI builds with a dummy). Skip the
  // throw there; the guard re-runs at real runtime boot.
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return

  if (process.env.NODE_ENV === 'production') {
    // Fail closed: one clear boot error, then refuse to serve auth.
    console.error(`[auth] ${BOOT_ERROR_MESSAGE}`)
    throw new Error(
      `[auth] NEXTAUTH_SECRET boot guard: ${
        problem === 'missing' ? 'no secret is set' : `secret is shorter than ${MIN_NEXTAUTH_SECRET_LENGTH} chars`
      }. ${BOOT_ERROR_MESSAGE}`,
    )
  }

  // Dev/test: usable, but say it once.
  console.warn(
    '[auth] NEXTAUTH_SECRET is not set or too short — dev sessions run on the ' +
      'next-auth fallback secret. Generate one (openssl rand -hex 32) before any ' +
      'real deployment; production boot fails closed without it.',
  )
}
