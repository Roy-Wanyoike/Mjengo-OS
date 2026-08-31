import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { buildProjectDigest, parseDeliveryTranscript } from '@/lib/ai'
import { withGuard } from '@/lib/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Voice-to-Invoice: ASR (Swahili/Sheng/English) → structured delivery log. */
export const POST = withGuard(async (req: NextRequest) => {
  try {
    const { audioBase64, projectId } = (await req.json()) as { audioBase64?: string; projectId?: string }
    if (!audioBase64) return NextResponse.json({ error: 'audioBase64 required' }, { status: 400 })
    if (audioBase64.length > 12 * 1024 * 1024) {
      return NextResponse.json({ error: 'Audio too large (max ~9MB)' }, { status: 400 })
    }

    const zai = await ZAI.create()
    const asr = await zai.audio.asr.create({ file_base64: audioBase64 })
    const transcript = (asr.text ?? '').trim()
    if (!transcript) {
      return NextResponse.json({ error: 'Could not hear any speech in that voice note' }, { status: 400 })
    }

    const digest = await buildProjectDigest(projectId)
    const parsed = await parseDeliveryTranscript(transcript, digest)

    return NextResponse.json({ ok: true, ...parsed })
  } catch (e) {
    console.error('[api/ai/voice-log]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Voice processing failed' }, { status: 500 })
  }
})
