import { NextRequest, NextResponse } from 'next/server'
import { withGuard, safeErrorMessage } from '@/backend/lib/guard'
import { enforceRateLimit } from '@/backend/lib/rate-limit'
import { enqueue, isJobType, loadRecentJobs, runDueJobs } from '@/backend/modules/jobs/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Background-job runner (spec §58) — the cron-callee endpoint.
 *
 * POST (contractor/admin): drains due jobs.
 *   · body {}                  → run everything queued + due
 *   · body {type, projectId?}  → enqueue-then-run that job now
 *   Returns { ran, results } with per-job status/result/lastError.
 *
 * GET (any signed-in role): the recent JobRecord list for the project —
 * client-role sessions are pinned to their own project (tenant isolation).
 *
 * HONEST copy: nothing schedules this route automatically today — the Intel
 * "Background jobs" card triggers it on demand; in production a cron would
 * call POST /api/jobs/run on an interval.
 */
export const POST = withGuard(
  async (req) => {
    // Rate limit (S-SEC): 10 runs/min — each call drains up to 10 background
    // jobs (expensive), and an unvalidated projectId otherwise reaches prisma
    // on every request.
    const limited = await enforceRateLimit(req, 'jobs.run', 10, 60_000)
    if (limited) return limited

    try {
      let body: { type?: unknown; projectId?: unknown } = {}
      try {
        body = (await req.json()) as typeof body
      } catch {
        body = {}
      }

      const type = typeof body.type === 'string' ? body.type.trim() : ''
      const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : null

      if (type) {
        if (!isJobType(type)) {
          return NextResponse.json({ error: `Unknown job type "${type}"` }, { status: 400 })
        }
        // Enqueue-then-run: the drain below picks the row up (runAt = now).
        await enqueue(type, projectId, {})
      }

      const { ran, results } = await runDueJobs(10)
      return NextResponse.json({ ok: true, ran, results })
    } catch (e) {
      console.error('[api/jobs/run POST]', e)
      // Redacted (S-SEC): an unknown projectId trips a Prisma FK error whose
      // message leaks build paths — keep the honest generic message instead.
      return NextResponse.json({ error: safeErrorMessage(e, 'Job run failed') }, { status: 500 })
    }
  },
  { roles: ['contractor', 'admin'] },
)

export const GET = withGuard(async (req, session) => {
  try {
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
  } catch (e) {
    console.error('[api/jobs/run GET]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not list jobs' }, { status: 500 })
  }
})
