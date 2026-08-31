import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildProjectDigest, llm } from '@/lib/ai'
import { withGuard } from '@/lib/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** 6 PM WhatsApp-style daily recap for the (diaspora) client. */
export const POST = withGuard(async (req: NextRequest) => {
  try {
    // Body is optional here (legacy clients POST with no JSON) — read projectId if present
    let projectId: string | undefined
    try {
      const body = await req.json()
      projectId = body?.projectId
    } catch { /* empty body — fall back to first project */ }

    const digest = await buildProjectDigest(projectId)

    const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)
    const todayAttendance = digest.attendanceLastDays.filter((a) => a.date === today)
    const todayDeliveries = digest.deliveries.filter((d) => d.daysAgo === 0)

    const system = `You are MjengoOS. Every evening at 6 PM (EAT) you send the client a WhatsApp-style daily site recap.
The client is a Kenyan in the diaspora paying for a bungalow back home — warm, clear, trustworthy tone with light Swahili flavor (Habari ya leso style, but professional).
Format: plain text WhatsApp message, 5-8 short lines, using the actual bullets/emojis WhatsApp supports (📍 ✅ 🚚 💰 🧱 ⚠️). Always include: day number, crew checked in, what was done (infer from progress/tasks), any deliveries today, spend position, and one trust line (photo evidence on file). If there are unacknowledged critical/warning alerts, mention them as ⚠️. End with "— MjengoOS". No markdown headers or code blocks.`

    const user = `Today (${today}) data:
- Day ${digest.project.day} of build "${digest.project.name}" (${digest.project.location})
- Overall progress: ${digest.overallProgressPct}%
- Crew today: ${todayAttendance.length} workers (${todayAttendance.map((a) => `${a.worker?.split(' ')[0]} (${a.status})`).join(', ') || 'no check-ins yet'})
- Wages today: KES ${todayAttendance.reduce((s, a) => s + a.wageKES, 0)}
- Deliveries today: ${todayDeliveries.length ? todayDeliveries.map((d) => `${d.qty} ${d.unit} ${d.material}`).join('; ') : 'none'}
- Total spend: KES ${digest.spend.totalKES.toLocaleString()} of KES ${digest.project.budgetKES.toLocaleString()} budget
- Open alerts: ${digest.recentAlerts.filter((a) => a.severity !== 'info').map((a) => a.title).join('; ') || 'none'}
- Current phase tasks in progress: ${digest.phases.flatMap((p) => p.tasks.filter((t) => t.status === 'in_progress').map((t) => t.title)).join('; ') || 'phase transitions'}

Write today's recap.`

    const content = await llm(system, user, false)

    const recap = await db.recap.create({
      data: { projectId: digest.projectId, day: digest.project.day, content },
    })

    // Land the recap in the client's notification center too (WhatsApp channel log)
    const project = await db.project.findUnique({ where: { id: digest.projectId } })
    if (project) {
      await db.notification.create({
        data: {
          projectId: project.id,
          kind: 'recap',
          title: `Daily recap — Day ${digest.project.day}`,
          body: content.slice(0, 140),
          channel: 'whatsapp',
          recipient: project.client,
        },
      })
    }

    return NextResponse.json({ ok: true, recap })
  } catch (e) {
    console.error('[api/ai/recap]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Recap generation failed' }, { status: 500 })
  }
})
