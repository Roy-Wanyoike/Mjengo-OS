import { NextRequest, NextResponse } from 'next/server'
import { buildProjectDigest, parseDeliveryTranscript, transcribeAudio } from '@/backend/lib/ai'
import { scrubTranscriptPhones } from '@/backend/lib/pii-scrub'
import { AI_VOICE_LOG_MAX_BODY_BYTES, enforceAiRoutePolicy } from '@/backend/lib/rate-limit'
import { safeErrorMessage } from '@/backend/lib/guard'
import { requireFlagOn } from '@/backend/modules/intel/flags'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Voice-to-Invoice: ASR (Swahili/Sheng/English) → structured delivery log.
 *
 * W1-SEC: gated (session + site-team role allowlist + 10 req/min/user +
 * validated projectId + unknown-field rejection) — the transcript parser's
 * project digest can no longer be pointed at an arbitrary project by a
 * non-site-team account.
 *
 * BE-5 (issue #105): the gate caps the RAW body at 13 MB BEFORE buffering
 * into the parser (declared Content-Length precheck + post-read count) —
 * transport headroom over the route's own 12 MB audioBase64 domain cap below,
 * which used to run only AFTER the whole body had been read into memory.
 *
 * 8-b (PII): the transcript is SCRUBBED the moment ASR produces it — Kenyan
 * phone numbers (07xx/01xx/+2547xx/2547xx forms, incl. spaced/hyphenated)
 * are masked to "07••••••78"-style before anything else happens, so the
 * response body, the LLM parse prompt and (downstream) the rawTranscript the
 * client persists via delivery.create only ever carry the masked form. What
 * is masked and what deliberately is NOT (times/amounts/references are
 * untouched; names are NOT masked — field notes are operator-private speech,
 * this targets accidental full phone-number capture) is documented in
 * src/backend/lib/pii-scrub.ts; parseDeliveryTranscript re-applies the same
 * idempotent scrub on the shared parse seam (covers /api/ai/parse-text too).
 *
 * Feature flag (spec §81, task 9-a): ai_voice gates this ROUTE for
 * non-admin sessions (the Copilot voice panel's record/upload/sample
 * buttons are disabled by the same flag — see flags.ts for the map;
 * /api/ai/parse-text, the typed-note path, is deliberately NOT gated).
 */
export const POST = async (req: NextRequest): Promise<NextResponse> => {
  const gate = await enforceAiRoutePolicy(req, {
    bucket: 'ai:voice-log',
    // BE-5 (issue #105): 13 MB transport cap — headroom over the 12 MB
    // audioBase64 domain cap below (JSON envelope + base64 overhead).
    maxBytes: AI_VOICE_LOG_MAX_BODY_BYTES,
    fields: [
      { name: 'audioBase64', type: 'string' },
      { name: 'projectId', type: 'string' },
    ],
  })
  if (!gate.ok) return gate.response

  // Feature flag (spec §81, task 9-a): a flipped-off ai_voice used to change
  // NOTHING — the route now answers the uniform 403 for non-admins (admins
  // bypass so they can toggle and test).
  const flagDenied = await requireFlagOn('ai_voice', gate.session)
  if (flagDenied) return flagDenied

  try {
    const audioBase64 = gate.body.audioBase64 as string | undefined
    if (!audioBase64) return NextResponse.json({ error: 'audioBase64 required' }, { status: 400 })
    if (audioBase64.length > 12 * 1024 * 1024) {
      return NextResponse.json({ error: 'Audio too large (max ~9MB)' }, { status: 400 })
    }

    // BE-4 (issue #76): ASR goes through lib/ai.ts's transcribeAudio — the
    // same 20s Promise.race + SDK singleton as the rest of the legacy AI
    // seam. This route used to call ZAI.create() + zai.audio.asr.create
    // directly with NO cap: one stuck ASR request held the route open for
    // its full maxDuration (120s).
    const rawTranscript = await transcribeAudio(audioBase64)
    if (!rawTranscript) {
      return NextResponse.json({ error: 'Could not hear any speech in that voice note' }, { status: 400 })
    }
    // 8-b (PII): the boundary — scrub before the transcript is parsed,
    // returned or persisted anywhere (see route header).
    const { scrubbed: transcript } = scrubTranscriptPhones(rawTranscript)

    const digest = await buildProjectDigest(gate.projectId)
    const parsed = await parseDeliveryTranscript(transcript, digest)

    return NextResponse.json({ ok: true, ...parsed })
  } catch (e) {
    console.error('[api/ai/voice-log]', e)
    // W-AUDIT #5: route SDK/ASR failures through safeErrorMessage — raw
    // e.message leaked SDK internals (multi-line/stack-like errors are
    // redacted; single-line domain messages still pass honestly).
    return NextResponse.json({ error: safeErrorMessage(e, 'Voice processing failed') }, { status: 500 })
  }
}
