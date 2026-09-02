import { NextRequest, NextResponse } from 'next/server'
import { runDailyRecap } from '@/backend/modules/jobs/handlers'
import { enforceAiRoutePolicy } from '@/backend/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * 6 PM WhatsApp-style daily recap for the (diaspora) client.
 *
 * The recap CORE lives in modules/jobs/handlers.ts (shared with the §58
 * 'recap.daily' background job): it writes the Recap row and emits the
 * 'recap.daily' domain event (§59). Channel honesty (F-PLATFORM): the event's
 * notification policy lands the notification-center row as channel 'in_app'
 * with deliveryStatus 'logged' — nothing is sent on WhatsApp until a real
 * provider is wired (the old row claimed channel 'whatsapp' with no delivery).
 *
 * W1-SEC: gated (session + site-team role allowlist + 10 req/min/user +
 * validated projectId). Clients consume recaps through their pinned project
 * surface — they cannot generate them for arbitrary projects from here.
 * The no-JSON legacy body contract is preserved (allowEmptyBody → default
 * project).
 */
export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:recap',
    fields: [{ name: 'projectId', type: 'string' }],
    allowEmptyBody: true,
  })
  if (!gate.ok) return gate.response

  try {
    const recap = await runDailyRecap(gate.projectId)
    return NextResponse.json({
      ok: true,
      recap: { id: recap.recapId, projectId: recap.projectId, day: recap.day, content: recap.content },
    })
  } catch (e) {
    console.error('[api/ai/recap]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Recap generation failed' }, { status: 500 })
  }
}
