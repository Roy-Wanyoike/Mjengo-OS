import { NextRequest, NextResponse } from 'next/server'
import { withGuard } from '@/lib/guard'
import { runDailyRecap } from '@/modules/jobs/handlers'

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
 */
export const POST = withGuard(async (req: NextRequest) => {
  try {
    // Body is optional here (legacy clients POST with no JSON) — read projectId if present
    let projectId: string | undefined
    try {
      const body = await req.json()
      projectId = body?.projectId
    } catch { /* empty body — fall back to first project */ }

    const recap = await runDailyRecap(projectId)

    return NextResponse.json({
      ok: true,
      recap: { id: recap.recapId, projectId: recap.projectId, day: recap.day, content: recap.content },
    })
  } catch (e) {
    console.error('[api/ai/recap]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Recap generation failed' }, { status: 500 })
  }
})
