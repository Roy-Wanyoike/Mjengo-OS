import { NextRequest, NextResponse } from 'next/server'
import { buildProjectDigest, parseDeliveryTranscript } from '@/lib/ai'
import { withGuard } from '@/lib/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Text variant of the voice parser (typed notes / demo transcripts / WhatsApp forwards). */
export const POST = withGuard(async (req: NextRequest) => {
  try {
    const { text, projectId } = (await req.json()) as { text?: string; projectId?: string }
    if (!text?.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 })

    const digest = await buildProjectDigest(projectId)
    const parsed = await parseDeliveryTranscript(text.trim(), digest)
    return NextResponse.json({ ok: true, ...parsed })
  } catch (e) {
    console.error('[api/ai/parse-text]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Parsing failed' }, { status: 500 })
  }
})
