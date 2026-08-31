import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildProjectDigest, extractJson, llm } from '@/lib/ai'
import { getProjectPayload } from '@/lib/mjengo'
import { withGuard } from '@/lib/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Anomaly Detection: reconciles deliveries vs consumption vs progress vs budget.
 * Flags material loss/theft, ghost workers, budget overrun trajectory.
 */
export const POST = withGuard(async (req: NextRequest) => {
  try {
    // Body is optional here (legacy clients POST with no JSON) — read projectId if present
    let projectId: string | undefined
    try {
      const body = await req.json()
      projectId = body?.projectId
    } catch { /* empty body — fall back to first project */ }

    const digest = await buildProjectDigest(projectId)

    const system = `You are MjengoOS's construction auditor AI for Kenyan residential builds (machine-cut stone masonry).
You reconcile the shared ledger: material deliveries, site consumption logs, attendance, spend and progress.
Typical consumption norms for a 3BR bungalow: foundation ≈ 95-110 cement bags; walling ≈ 7-9 bags per 10% progress; mortar sand ≈ 1 tonne per 12 bags cement; stones ≈ 55-70 per m² of wall.
Detect anomalies:
1. Material variance (delivered vs consumed vs expected for progress) — possible loss, theft or unlogged usage.
2. Ghost workers (wages paid vs plausible crew for progress).
3. Budget trajectory (spend % vs progress % — flag if spend leads progress by >8 points).
4. Suspicious supplier pricing vs catalog.
Respond with STRICT JSON only:
{"alerts": [{"type": "anomaly|budget|attendance|safety", "severity": "info|warning|critical", "title": "<short title>", "message": "<2-4 sentence explanation with KES figures>"}], "summary": "<overall site integrity verdict in 2-3 sentences>"}
Max 4 alerts, ordered by severity. Only flag genuine discrepancies — do not invent problems when numbers reconcile.`

    const result = await llm(system, `Project ledger digest:\n${JSON.stringify(digest, null, 1)}`, true) as {
      alerts: Array<{ type: string; severity: string; title: string; message: string }>
      summary: string
    }

    const created: Awaited<ReturnType<typeof db.alert.create>>[] = []
    for (const a of (result.alerts ?? []).slice(0, 4)) {
      const alert = await db.alert.create({
        data: {
          projectId: digest.projectId,
          type: ['anomaly', 'budget', 'attendance', 'safety'].includes(a.type) ? a.type : 'anomaly',
          severity: ['info', 'warning', 'critical'].includes(a.severity) ? a.severity : 'info',
          title: a.title?.slice(0, 140) || 'Anomaly detected',
          message: a.message || '',
        },
      })
      created.push(alert)
    }

    const data = await getProjectPayload(projectId)
    return NextResponse.json({ ok: true, alerts: created, summary: result.summary ?? '', data })
  } catch (e) {
    console.error('[api/ai/anomaly-scan]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Anomaly scan failed' }, { status: 500 })
  }
})
