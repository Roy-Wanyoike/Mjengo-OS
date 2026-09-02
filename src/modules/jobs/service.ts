// Background jobs — service (spec §58; failure handling Doc A §48).
//
// A JobRecord queue in SQLite: enqueue(type, projectId?, payload) writes a
// queued row (runAt = now by default); runDueJobs(limit) drains due rows
// through the handlers registry, recording attempts/status/result/lastError.
//
// FAILURE HANDLING (§48, backend wave): a handler error is TERMINAL only when
// attempts >= maxAttempts. Until then the row flips to 'retrying' and runAt is
// pushed out by an exponential backoff (retryBackoffMs):
//     attempt 1 failed → +2 min, 2 → +8 min, 3+ → +30 min cap (2·4^(n-1))
// A job that succeeds after retries lands 'done' with the retry count noted
// in its result JSON; a job that exhausts maxAttempts lands 'failed' and KEEPS
// lastError (that terminal row IS the dead letter — there is no separate DLQ
// table to move it to; §48's dead-letter requirement is met honestly by the
// row itself staying queryable in SQLite).
// Equally honest gaps vs §48: NO jitter (there is a single drain process, so
// there is nothing to de-synchronize), no per-handler circuit breaker and no
// timeout wrapping (handlers run in-process; a hung handler stalls the drain —
// the route's maxDuration is the only guard).
//
// HONEST execution model: jobs run on demand (the Intel "Background jobs"
// card + POST /api/jobs/run). There is NO in-process scheduler today — in
// production a cron (Vercel Cron, systemd timer, k8s CronJob) calls
// POST /api/jobs/run to drain the queue.

import { db } from '@/lib/db'
import { JOB_HANDLERS, JOB_TYPES, type JobType } from './handlers'

export interface JobRunResult {
  id: string
  type: string
  projectId: string | null
  status: 'done' | 'failed' | 'retrying'
  result?: string | null
  lastError?: string | null
  finishedAt: Date | null
  // §48 additive fields (backward compatible — pre-existing consumers read
  // only id/type/projectId/status/result/lastError/finishedAt).
  /** Total handler runs including the one this result describes. */
  attempts: number
  /** Terminal threshold from the row (schema default 3). */
  maxAttempts: number
  /** Set when a failure scheduled another try (status 'retrying'), else null. */
  nextRunAt?: Date | null
}

/** Validate a job type against the registry (open set — append-only). */
export function isJobType(type: string): type is JobType {
  return (JOB_TYPES as readonly string[]).includes(type)
}

/**
 * Exponential backoff after the n-th failed attempt: 2·4^(n-1) minutes —
 * 2 min, 8 min, 32→30 min cap. No jitter (single drain process; see header).
 */
export function retryBackoffMs(attempts: number): number {
  const minutes = Math.min(2 * Math.pow(4, Math.max(attempts, 1) - 1), 30)
  return Math.round(minutes * 60_000)
}

/** Queue a job for immediate (or scheduled, via runAt) execution. */
export async function enqueue(
  type: string,
  projectId?: string | null,
  payload: Record<string, unknown> = {},
  runAt: Date = new Date(),
): Promise<{ id: string; type: string; status: string; runAt: Date }> {
  if (!isJobType(type)) throw new Error(`Unknown job type "${type}"`)
  const row = await db.jobRecord.create({
    data: {
      type,
      projectId: projectId ?? null,
      payload: JSON.stringify(payload ?? {}),
      runAt,
      status: 'queued',
    },
  })
  return { id: row.id, type: row.type, status: row.status, runAt: row.runAt }
}

/**
 * Drain due jobs — queued rows AND 'retrying' rows whose backoff has elapsed
 * (runAt <= now) — one at a time. Each job:
 *   queued/retrying → running (attempts+1, startedAt, lastAttemptAt) → handler →
 *   done (result + finishedAt, retry count noted when attempts > 1)
 *   | failed (lastError + finishedAt) when attempts >= maxAttempts
 *   | retrying (lastError + runAt = now + backoff) otherwise.
 * Handler errors NEVER abort the drain — the failure is recorded on the row.
 * Stale 'running' rows (a drain that died mid-handler) are left untouched:
 * this queue has no lease/heartbeat mechanism today — honest gap, visible in
 * the jobs card.
 */
export async function runDueJobs(limit = 10): Promise<{ ran: number; results: JobRunResult[] }> {
  const due = await db.jobRecord.findMany({
    where: { status: { in: ['queued', 'retrying'] }, runAt: { lte: new Date() } },
    orderBy: { runAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 25),
  })

  const results: JobRunResult[] = []
  for (const job of due) {
    const running = await db.jobRecord.update({
      where: { id: job.id },
      data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 }, lastAttemptAt: new Date() },
    })
    try {
      const handler = JOB_HANDLERS[job.type as JobType]
      if (!handler) throw new Error(`No handler registered for "${job.type}"`)
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(job.payload || '{}')
      } catch {
        payload = {}
      }
      const outcome = await handler(payload, job.projectId)
      // A success after prior failures says so in the result JSON (additive
      // `retries` key — per-type parsers in the UI ignore unknown keys).
      const body: Record<string, unknown> =
        outcome !== null && typeof outcome === 'object' && !Array.isArray(outcome)
          ? { ...(outcome as Record<string, unknown>) }
          : { value: outcome ?? null }
      if (running.attempts > 1) body.retries = running.attempts - 1
      const row = await db.jobRecord.update({
        where: { id: job.id },
        data: {
          status: 'done',
          result: JSON.stringify(body).slice(0, 2000),
          finishedAt: new Date(),
        },
      })
      results.push({
        id: row.id, type: row.type, projectId: row.projectId,
        status: 'done', result: row.result, lastError: row.lastError, finishedAt: row.finishedAt,
        attempts: row.attempts, maxAttempts: row.maxAttempts, nextRunAt: null,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const terminal = running.attempts >= running.maxAttempts
      console.error(
        `[jobs] ${job.type} (${running.attempts}/${running.maxAttempts} attempt(s)) failed${terminal ? ' — terminal' : ' — will retry'}:`,
        message,
      )
      if (terminal) {
        const row = await db.jobRecord.update({
          where: { id: job.id },
          data: { status: 'failed', lastError: message.slice(0, 500), finishedAt: new Date() },
        })
        results.push({
          id: row.id, type: row.type, projectId: row.projectId,
          status: 'failed', result: row.result, lastError: row.lastError, finishedAt: row.finishedAt,
          attempts: row.attempts, maxAttempts: row.maxAttempts, nextRunAt: null,
        })
      } else {
        const nextRunAt = new Date(Date.now() + retryBackoffMs(running.attempts))
        const row = await db.jobRecord.update({
          where: { id: job.id },
          data: { status: 'retrying', lastError: message.slice(0, 500), runAt: nextRunAt },
        })
        results.push({
          id: row.id, type: row.type, projectId: row.projectId,
          status: 'retrying', result: row.result, lastError: row.lastError, finishedAt: row.finishedAt,
          attempts: row.attempts, maxAttempts: row.maxAttempts, nextRunAt,
        })
      }
    }
  }

  return { ran: results.length, results }
}

/** Recent job rows for the UI card (type, status, finishedAt, result/error). */
export async function loadRecentJobs(projectId?: string | null, limit = 12) {
  return db.jobRecord.findMany({
    where: projectId ? { projectId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 50),
    select: {
      id: true, type: true, status: true, projectId: true, payload: true,
      result: true, attempts: true, lastError: true, runAt: true, startedAt: true,
      finishedAt: true, createdAt: true,
      maxAttempts: true, lastAttemptAt: true,
    },
  })
}
