// Background jobs — service (spec §58).
//
// A JobRecord queue in SQLite: enqueue(type, projectId?, payload) writes a
// queued row (runAt = now by default); runDueJobs(limit) drains due rows
// through the handlers registry, recording attempts/status/result/lastError.
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
  status: 'done' | 'failed'
  result?: string | null
  lastError?: string | null
  finishedAt: Date | null
}

/** Validate a job type against the registry (open set — append-only). */
export function isJobType(type: string): type is JobType {
  return (JOB_TYPES as readonly string[]).includes(type)
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
 * Drain due jobs (queued + runAt <= now), one at a time. Each job:
 *   queued → running (attempts+1, startedAt) → handler →
 *   done (result summary + finishedAt) | failed (lastError + finishedAt).
 * Handler errors NEVER abort the drain — the failure is recorded on the row.
 */
export async function runDueJobs(limit = 10): Promise<{ ran: number; results: JobRunResult[] }> {
  const due = await db.jobRecord.findMany({
    where: { status: 'queued', runAt: { lte: new Date() } },
    orderBy: { runAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 25),
  })

  const results: JobRunResult[] = []
  for (const job of due) {
    const running = await db.jobRecord.update({
      where: { id: job.id },
      data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 } },
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
      const row = await db.jobRecord.update({
        where: { id: job.id },
        data: {
          status: 'done',
          result: JSON.stringify(outcome ?? { ok: true }).slice(0, 2000),
          finishedAt: new Date(),
        },
      })
      results.push({
        id: row.id, type: row.type, projectId: row.projectId,
        status: 'done', result: row.result, lastError: null, finishedAt: row.finishedAt,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[jobs] ${job.type} (${running.attempts} attempt(s)) failed:`, message)
      const row = await db.jobRecord.update({
        where: { id: job.id },
        data: { status: 'failed', lastError: message.slice(0, 500), finishedAt: new Date() },
      })
      results.push({
        id: row.id, type: row.type, projectId: row.projectId,
        status: 'failed', result: row.result, lastError: row.lastError, finishedAt: row.finishedAt,
      })
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
    },
  })
}
