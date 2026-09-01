import { NextRequest, NextResponse } from 'next/server'
import { getProjectPayload } from '@/lib/mjengo'
import { runAnomalyScan } from '@/modules/jobs/handlers'
import { enforceAiRoutePolicy } from '@/lib/rate-limit'

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
 *
 * W1-SEC: the route is now gated (session + site-team role allowlist +
 * 10 req/min/user + validated projectId) — previously any logged-in
 * account could scan ANY project by passing its id. The no-JSON legacy
 * body contract is preserved (allowEmptyBody → default project).
 */
export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:anomaly-scan',
    fields: [{ name: 'projectId', type: 'string' }],
    allowEmptyBody: true,
  })
  if (!gate.ok) return gate.response

  try {
    const scan = await runAnomalyScan(gate.projectId)
    const data = await getProjectPayload(gate.projectId)
    return NextResponse.json({ ok: true, alerts: scan.alerts, summary: scan.summary, data })
  } catch (e) {
    console.error('[api/ai/anomaly-scan]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Anomaly scan failed' }, { status: 500 })
  }
}
