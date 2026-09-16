// Background-job runner endpoint (spec §58) — the cron-callee.
//
// This shim owns POST auth selection; GET (the recent-jobs list) stays
// the session-guarded handler re-exported from src/backend/api/jobs.ts.
//
// POST accepts EITHER credential:
//   1. SESSION (contractor/admin) — the historical path: the withGuard POST
//      re-exported from src/backend/api/jobs.ts.
//   2. BEARER TOKEN (opt-in machine path) — schedulers cannot hold a
//      NextAuth session, so when env JOBS_RUN_TOKEN is set, a request
//      presenting `Authorization: Bearer <token>` that matches it in
//      constant time (src/backend/lib/jobs-token.ts) runs the SAME
//      pipeline (10/min rate limit → tolerate-invalid body → redacting
//      error path; the SEC-1 mutation gate is skipped on BOTH paths —
//      machine route) via route-kit's session-optional publicRoute. A
//      presented-but-invalid token 401s — fail closed. Unset env = the
//      bearer path is disabled entirely and the request flows through the
//      session path unchanged (no default token).
//
// What actually schedules the drain: the docker-compose `jobs-tick`
// sidecar, deploy/systemd/mjengo-jobs.timer, or any external cron —
// see DEPLOYMENT.md "Background jobs scheduler".
//
// API-9 (issue #160): the POST handler body is NOT duplicated here anymore —
// src/backend/api/jobs.ts exports the raw handleJobsRunPost(req, body) and
// BOTH wrappers (the session route() export and the bearer publicRoute
// below) delegate to it, so a behavior change can never land in one copy
// and silently diverge the other.

import { NextRequest, NextResponse } from 'next/server'
import { POST as guardedSessionPost, handleJobsRunPost } from '@/backend/api/jobs'
import { bearerTokenFromAuthorization, secretsMatch } from '@/backend/lib/jobs-token'
import { publicRoute, safeError } from '@/backend/lib/route-kit'

export { GET } from '@/backend/api/jobs'

// ---------------------------------------------------------------- bearer path

// Same pipeline opts as src/backend/api/jobs.ts's POST (log scope, the
// 10/min bucket, tolerate-invalid body contract, redacting 500 path) —
// minus `roles`, which only the session guard consumes: a matching
// bearer token IS the authorization here.
const bearerPost = publicRoute(
  {
    scope: 'api/jobs/run POST',
    // SEC-1: machine route (same skip as the session twin in
    // src/backend/api/jobs.ts) — the scheduler's POST carries no
    // browser-shaped headers by design.
    skipMutationSafety: true,
    // Rate limit (S-SEC): 10 runs/min — each call drains up to 10
    // background jobs (expensive), and an unvalidated projectId
    // otherwise reaches prisma on every request.
    rateLimit: { bucket: 'jobs.run', limit: 10, windowMs: 60_000 },
    body: { tolerateInvalid: true }, // the historical contract: unparseable body = {}
    onError: safeError(500, 'Job run failed'),
  },
  // The SHARED handler from src/backend/api/jobs.ts (API-9: one
  // implementation). It ignores the session, so it is safe to run under
  // the machine principal; the session, when a cookie rides along with a
  // valid token, is decoded best-effort by publicRoute and likewise
  // ignored — the token takes precedence.
  async (req, _session, body) => handleJobsRunPost(req, body),
)

// ---------------------------------------------------------------- POST export

/**
 * Auth selection for the job drain, in order:
 *   · JOBS_RUN_TOKEN unset → session path only (byte-identical to the
 *     pre-token behavior; an Authorization header is simply ignored).
 *   · token set + no bearer credential presented → session path (the
 *     browser/Intel-card flow — browsers never send Authorization).
 *   · token set + presented + constant-time match → bearer pipeline.
 *   · token set + presented + mismatch → 401 (fail closed; the session
 *     path is NOT used as a fallback for a failed machine credential).
 * Both paths end in the SAME handleJobsRunPost (src/backend/api/jobs.ts).
 */
export async function POST(req: NextRequest, ctx: unknown): Promise<NextResponse> {
  const configured = process.env.JOBS_RUN_TOKEN
  if (configured) {
    const presented = bearerTokenFromAuthorization(req.headers.get('authorization'))
    if (presented !== null) {
      if (!secretsMatch(presented, configured)) {
        // Invalid jobs token — honest single-line error (the 64-hex
        // secret itself is never echoed back).
        return NextResponse.json({ error: 'Invalid jobs token' }, { status: 401 })
      }
      return bearerPost(req, ctx)
    }
  }
  return guardedSessionPost(req, ctx)
}

export const dynamic = 'force-dynamic'
export const maxDuration = 120
