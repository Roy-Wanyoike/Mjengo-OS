import { NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import pkg from '../../../../package.json'

export const dynamic = 'force-dynamic'

/**
 * Health / readiness probe (Doc A §45 observability, §46 health checks) —
 * the seam a load balancer or k8s would poll: GET /api/health, NO auth
 * (probes have no session; the response deliberately exposes no business
 * data — only reachability, process uptime and coarse counts).
 *
 *   200 { ok, uptimeSec, db: 'up', dbLatencyMs, jobs, counts, version, timestamp }
 *   503 { ok: false, db: 'down', error, … } when SQLite is unreachable.
 *
 * HONEST scope (§45): this is process-local liveness + a real DB round-trip.
 * No OpenTelemetry/Prometheus exporter, Redis, Temporal or queue-worker
 * checks exist to report — those fields stay absent until a real dependency
 * does. Job counts are point-in-time row counts, not queue depth gauges.
 */
export async function GET() {
  const startedAt = Date.now()
  const base = {
    ok: false as boolean,
    uptimeSec: Math.floor(process.uptime()),
    version: { name: pkg.name, version: pkg.version },
    timestamp: new Date().toISOString(),
  }

  try {
    await db.$queryRaw`SELECT 1`
    const [jobGroups, projects, workers, notifications] = await Promise.all([
      db.jobRecord.groupBy({ by: ['status'], _count: { _all: true } }),
      db.project.count(),
      db.worker.count(),
      db.notification.count(),
    ])
    const byStatus = new Map(jobGroups.map((g) => [g.status, g._count._all]))
    return NextResponse.json({
      ...base,
      ok: true,
      db: 'up',
      dbLatencyMs: Date.now() - startedAt,
      jobs: {
        queued: byStatus.get('queued') ?? 0,
        retrying: byStatus.get('retrying') ?? 0,
        failed: byStatus.get('failed') ?? 0,
      },
      counts: { projects, workers, notifications },
    })
  } catch (e) {
    // DB down → 503 with the honest detail; counts are unknown, not zero.
    return NextResponse.json(
      {
        ...base,
        db: 'down',
        error: e instanceof Error ? e.message : 'Database unreachable',
        jobs: null,
        counts: null,
      },
      { status: 503 },
    )
  }
}
