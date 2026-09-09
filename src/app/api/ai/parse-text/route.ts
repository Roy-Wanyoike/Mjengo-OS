import { NextRequest, NextResponse } from 'next/server'
import { buildProjectDigest, parseDeliveryTranscript } from '@/backend/lib/ai'
import { enforceAiRoutePolicy } from '@/backend/lib/rate-limit'
import { safeErrorMessage } from '@/backend/lib/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Text variant of the voice parser (typed notes / demo transcripts / WhatsApp
 * forwards).
 *
 * W1-SEC: gated (session + site-team role allowlist + 10 req/min/user +
 * validated projectId + unknown-field rejection) — the digest fed to the
 * parser now always belongs to a project the caller is allowed to inspect.
 */
export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:parse-text',
    fields: [
      { name: 'text', type: 'string' },
      { name: 'projectId', type: 'string' },
    ],
  })
  if (!gate.ok) return gate.response

  try {
    const text = gate.body.text as string | undefined
    if (!text?.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 })

    const digest = await buildProjectDigest(gate.projectId)
    const parsed = await parseDeliveryTranscript(text.trim(), digest)
    return NextResponse.json({ ok: true, ...parsed })
  } catch (e) {
    console.error('[api/ai/parse-text]', e)
    // Same redaction as voice-log (W-AUDIT #5 family — no raw SDK errors).
    return NextResponse.json({ error: safeErrorMessage(e, 'Parsing failed') }, { status: 500 })
  }
}
