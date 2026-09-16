import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { forbidden } from '@/backend/lib/guard'
import { route, safeError } from '@/backend/lib/route-kit'
import { enqueue, isJobType, loadRecentJobs, runDueJobs } from '@/backend/modules/jobs/service'

// Background-job runner (spec §58) — the cron-callee endpoint.
// src/app/api/jobs/run/route.ts is the shim.
//
// POST (contractor/admin): drains due jobs.
//   · body {}                  → run everything queued + due
//   · body {type, projectId?}  → enqueue-then-run that job now
//   Returns { ran, results } with per-job status/result/lastError.
// The handler pipeline itself is the exported handleJobsRunPost below — also
// reused verbatim by the bearer wrapper in src/app/api/jobs/run/route.ts
// (API-9, issue #160: ONE implementation, two auth selectors).
//
// GET (any signed-in role): the recent JobRecord list for the project —
// client-role sessions are pinned to their own project (tenant isolation).
// BE-3 (issue #104): supplier sessions get the honest W5-3 403 instead —
// job rows are buyer-side operational records (the site team's queue), not
// supplier rows, so there is no jobs surface for them to read. Previously a
// supplier fell into the site-team branch below and read global job rows.
//
// HONEST copy: nothing schedules this route automatically today — the Intel
// "Background jobs" card triggers it on demand; in production a cron would
// call POST /api/jobs/run on an interval.
//
// W-BACKEND 4b: a body projectId that references no Project used to trip a
// Prisma FK error inside enqueue → redacted 500. It now gets an honest 400
// BEFORE any queue write (the same posture as /api/ai/*'s projectId gate).

/**
 * The raw POST /api/jobs/run handler body — ONE implementation shared by BOTH
 * auth wrappers (API-9, issue #160): the session `route()` export below and
 * the bearer `publicRoute()` twin in src/app/api/jobs/run/route.ts both
 * delegate here, so the pipeline behavior (400 unknown project, 400 unknown
 * type, enqueue-then-run, { ok, ran, results } shape) cannot drift between
 * the session path the UI uses and the machine path the scheduler uses.
 * Auth-neutral by construction: it reads only the (already-parsed) body —
 * `_req` is accepted for call-shape symmetry and future use, the session is
 * ignored (the wrappers enforce contractor/admin or the constant-time token).
 */
export async function handleJobsRunPost(_req: NextRequest, body: unknown): Promise<NextResponse> {
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
}

export const POST = route(
  {
    scope: 'api/jobs/run POST',
    roles: ['contractor', 'admin'],
    // SEC-1: this is the cron-callee MACHINE route — the scheduler POSTs it
    // with bearer/any content type (tolerateInvalid body), so the default-on
    // mutation safety gate is skipped here (and on the bearer twin in
    // src/app/api/jobs/run/route.ts so both paths stay byte-equivalent).
    // Every browser-reachable mutation keeps the gate.
    skipMutationSafety: true,
    // Rate limit (S-SEC): 10 runs/min — each call drains up to 10 background
    // jobs (expensive), and an unvalidated projectId otherwise reaches prisma
    // on every request.
    rateLimit: { bucket: 'jobs.run', limit: 10, windowMs: 60_000 },
    body: { tolerateInvalid: true }, // the historical contract: unparseable body = {}
    onError: safeError(500, 'Job run failed'),
  },
  // The session wrapper — auth/policy wiring only; the pipeline is the shared
  // handleJobsRunPost above (API-9: no duplicated handler body in this file).
  async (req, _session, body) => handleJobsRunPost(req, body),
)

export const GET = route(
  { scope: 'api/jobs/run GET', onError: safeError(500, 'Could not list jobs') },
  async (req, session) => {
    // W5-3 / BE-3 (issue #104): a supplier has no jobs surface — the honest
    // role 403 (the same refusal /api/project gives), BEFORE any job row is
    // loaded.
    if (session.user.role === 'supplier') return forbidden(session.user.role)
    const wanted = req.nextUrl.searchParams.get('projectId')?.trim() || null
    if (session.user.role === 'client') {
      // Client-role sessions see exactly their own project's jobs — never
      // another project's rows or global (projectId null) runs.
      const jobs = await loadRecentJobs(session.user.projectId ?? wanted, 12)
      return NextResponse.json({ ok: true, jobs })
    }
    // Site team: the requested project's rows PLUS global (projectId null)
    // runs — e.g. an anomaly scan fired without an explicit project.
    const jobs = wanted
      ? (await loadRecentJobs(null, 50)).filter((j) => j.projectId === wanted || j.projectId === null).slice(0, 12)
      : await loadRecentJobs(null, 12)
    return NextResponse.json({ ok: true, jobs })
  },
)
