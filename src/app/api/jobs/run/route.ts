// Background-job runner endpoint (spec §58) — the cron-callee.
//
// This shim owns POST auth selection; GET (the recent-jobs list) stays
// the session-guarded handler re-exported from src/backend/api/jobs.ts.
//
// POST accepts EITHER credential:
//   1. SESSION (contractor/admin) — the historical path, byte-identical:
//      it literally IS the withGuard POST from src/backend/api/jobs.ts.
//   2. BEARER TOKEN (opt-in machine path) — schedulers cannot hold a
//      NextAuth session, so when env JOBS_RUN_TOKEN is set, a request
//      presenting `Authorization: Bearer <token>` that matches it in
//      constant time (src/backend/lib/jobs-token.ts) runs the SAME
//      pipeline (origin gate → 10/min rate limit → tolerate-invalid
//      body → redacting error path) via route-kit's session-optional
//      publicRoute. A presented-but-invalid token 401s — fail closed.
//      Unset env = the bearer path is disabled entirely and the request
//      flows through the session path unchanged (no default token).
//
// What actually schedules the drain: the docker-compose `jobs-tick`
// sidecar, deploy/systemd/mjengo-jobs.timer, or any external cron —
// see DEPLOYMENT.md "Background jobs scheduler".
//
// NOTE: the bearer pipeline re-declares the POST handler from
// src/backend/api/jobs.ts (verbatim). That file is owned by another
// wave; when editing either copy, edit both — the durable fix is for
// jobs.ts to export its raw handler so this file can reuse it (noted
// in worklog task 6-a).

import { NextRequest, NextResponse } from 'next/server'
import { POST as guardedSessionPost } from '@/backend/api/jobs'
import { db } from '@/backend/lib/db'
import { bearerTokenFromAuthorization, secretsMatch } from '@/backend/lib/jobs-token'
import { publicRoute, safeError } from '@/backend/lib/route-kit'
import { enqueue, isJobType, runDueJobs } from '@/backend/modules/jobs/service'

export { GET } from '@/backend/api/jobs'

// ---------------------------------------------------------------- bearer path

// Same pipeline opts as src/backend/api/jobs.ts's POST (log scope, the
// 10/min bucket, tolerate-invalid body contract, redacting 500 path) —
// minus `roles`, which only the session guard consumes: a matching
// bearer token IS the authorization here.
const bearerPost = publicRoute(
  {
    scope: 'api/jobs/run POST',
    // Rate limit (S-SEC): 10 runs/min — each call drains up to 10
    // background jobs (expensive), and an unvalidated projectId
    // otherwise reaches prisma on every request.
    rateLimit: { bucket: 'jobs.run', limit: 10, windowMs: 60_000 },
    body: { tolerateInvalid: true }, // the historical contract: unparseable body = {}
    onError: safeError(500, 'Job run failed'),
  },
  // Handler body: VERBATIM COPY of src/backend/api/jobs.ts's POST
  // handler (it ignores the session, so it is safe to run under the
  // machine principal). The session, when a cookie rides along with a
  // valid token, is decoded best-effort by publicRoute and likewise
  // ignored — the token takes precedence.
  async (_req, _session, body) => {
    const parsed = (body ?? {}) as { type?: unknown; projectId?: unknown }

    const type = typeof parsed.type === 'string' ? parsed.type.trim() : ''
    const projectId = typeof parsed.projectId === 'string' && parsed.projectId.trim() ? parsed.projectId.trim() : null

    // Existence check (4b) — an unknown projectId is a 400, never a redacted 500.
    if (projectId) {
      const exists = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
      if (!exists) return NextResponse.json({ error: 'Project not found' }, { status: 400 })
    }

    if (type) {
      if (!isJobType(type)) {
        return NextResponse.json({ error: `Unknown job type "${type}"` }, { status: 400 })
      }
      // Enqueue-then-run: the drain below picks the row up (runAt = now).
      await enqueue(type, projectId, {})
    }

    const { ran, results } = await runDueJobs(10)
    return NextResponse.json({ ok: true, ran, results })
  },
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
