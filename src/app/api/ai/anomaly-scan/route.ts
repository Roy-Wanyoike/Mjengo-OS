import { NextRequest, NextResponse } from 'next/server'
import { getProjectPayload } from '@/lib/mjengo'
import { withGuard } from '@/lib/guard'
import { runAnomalyScan } from '@/modules/jobs/handlers'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Anomaly Detection: reconciles deliveries vs consumption vs progress vs budget.
 * Flags material loss/theft, ghost workers, budget overrun trajectory.
 *
 * The scan CORE lives in modules/jobs/handlers.ts (shared with the §58
 * 'anomaly_scan' background job): it writes the Alert rows AND emits the
 * 'anomaly.detected' domain event (§59) — whose default notification policy
 * lands an in-app row (kind 'anomaly', audience contractor) so the bell
 * finally surfaces scan findings. This route is the thin HTTP skin.
 */
export const POST = withGuard(async (req: NextRequest) => {
  try {
    // Body is optional here (legacy clients POST with no JSON) — read projectId if present
    let projectId: string | undefined
    try {
      const body = await req.json()
      projectId = body?.projectId
    } catch { /* empty body — fall back to first project */ }

    const scan = await runAnomalyScan(projectId)

    const data = await getProjectPayload(projectId)
    return NextResponse.json({ ok: true, alerts: scan.alerts, summary: scan.summary, data })
  } catch (e) {
    console.error('[api/ai/anomaly-scan]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Anomaly scan failed' }, { status: 500 })
  }
})
