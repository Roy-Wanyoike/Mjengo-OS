import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { buildProjectDigest, parseDeliveryTranscript } from '@/backend/lib/ai'
import { enforceAiRoutePolicy } from '@/backend/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Voice-to-Invoice: ASR (Swahili/Sheng/English) → structured delivery log.
 *
 * W1-SEC: gated (session + site-team role allowlist + 10 req/min/user +
 * validated projectId + unknown-field rejection) — the transcript parser's
 * project digest can no longer be pointed at an arbitrary project by a
 * non-site-team account.
 */
export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:voice-log',
    fields: [
      { name: 'audioBase64', type: 'string' },
      { name: 'projectId', type: 'string' },
    ],
  })
  if (!gate.ok) return gate.response

  try {
    const audioBase64 = gate.body.audioBase64 as string | undefined
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

    const digest = await buildProjectDigest(gate.projectId)
    const parsed = await parseDeliveryTranscript(transcript, digest)

    return NextResponse.json({ ok: true, ...parsed })
  } catch (e) {
    console.error('[api/ai/voice-log]', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Voice processing failed' }, { status: 500 })
  }
}
