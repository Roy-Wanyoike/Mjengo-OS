import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/backend/lib/db'
import { applyAction, getProjectPayload, type ActionType } from '@/backend/lib/mjengo'
import { publicRoute, safeError, genericError, zodIssueResponse } from '@/backend/lib/route-kit'
import { getDrawPackForShare } from '@/backend/modules/drawpack/service'

// Public "Virtual Site Visit" endpoint — src/app/api/share/route.ts is the shim.
// Diaspora clients arrive via a revocable share token (`/?share=<token>`), no
// auth. GET boots the read-mostly client view (and, with &drawPack=<id>,
// serves one immutable W4-1 evidence pack read-only); POST is strictly limited
// to the client-decision allowlist.
//
// Rate limit (P3 review item, W3-B): the route stays PUBLIC (the token IS the
// auth) but both verbs now enforce a 30/min per-IP bucket so scripted token
// brute-forcing cannot run at full speed. 30/min is far above what a human
// client view generates. In-process limiter — single-instance honesty note in
// src/backend/lib/rate-limit.ts.
const CLIENT_ALLOWLIST: readonly ActionType[] = [
  'milestone.decide',
  'variation.decide',
  'comment.add',
  'notification.read',
  'notification.readAll',
]

// S2 (W3-1) — body validation: POST /api/share was the only public mutating
// route without a zod schema or a size cap. Two layers, both BEFORE the token
// lookup (nothing is revealed to an oversized or malformed probe):
//   · a 64 KB RAW-BODY CAP mirroring the Daraja webhook's MAX_BODY_BYTES gate
//     (src/app/api/webhooks/daraja/[secret]/route.ts): declared Content-Length
//     is checked first, the actual byte count after reading, BEFORE JSON.parse
//     — a lying client cannot push a huge payload into the parser. This route
//     answers 400 (not Daraja's 413) so the whole share error family stays
//     400/403/404 — the browser client treats every body failure alike;
//     30/min already bounds the retry abuse.
//   · a zod strictObject body schema ({ token, type, payload } bounds, unknown
//     fields rejected) — validation failures return the shared
//     { error, field? } shape rendered by route-kit's zodIssueResponse.
const MAX_BODY_BYTES = 64 * 1024

const shareBodySchema = z.strictObject({
  token: z
    .string('token must be a string')
    .min(1, 'token must not be empty')
    .max(256, 'token must be at most 256 characters'),
  type: z
    .string('type must be a string')
    .min(1, 'type must not be empty')
    .max(100, 'type must be at most 100 characters'),
  // Payload is action-specific; the 64 KB body cap is its bound. It must be a
  // JSON object (every allowlisted action's payload is one) — arrays/scalars
  // are refused honestly instead of failing deep inside an applier.
  payload: z.record(z.string(), z.unknown(), 'payload must be an object').optional(),
})

/** GET /api/share?token=... → project payload for the client link.
 *
 * W4-1 draw packs: GET /api/share?token=...&drawPack=<id> serves ONE frozen
 * evidence bundle read-only through the SAME revocable token (no new auth
 * surface): the token lookup above stays the gate, a revoked/regenerated
 * token 404s with the standard share error before the pack is even queried,
 * and a pack id that is unknown — or belongs to a DIFFERENT project — 404s
 * identically (no cross-project probing). The response carries the pack
 * JSON (with the canonical `content` string so the SHA-256 contentHash can
 * be re-verified offline after forwarding) plus the printable view data
 * (project identity + current evidence photo rows). Pack fetches share this
 * route's existing share.get 30/min bucket by construction.
 */
export const GET = publicRoute(
  {
    scope: 'api/share GET',
    rateLimit: { bucket: 'share.get', limit: 30, windowMs: 60_000 },
    onError: genericError(500, 'Share link could not be loaded'),
  },
  async (req) => {
    const token = req.nextUrl.searchParams.get('token')
    if (!token) {
      return NextResponse.json({ error: 'Share token required' }, { status: 400 })
    }
    const project = await db.project.findUnique({ where: { shareToken: token } })
    if (!project) {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
    }
    // W4-1: the drawPack branch — frozen bundle for a released milestone.
    const drawPackId = req.nextUrl.searchParams.get('drawPack')
    if (drawPackId) {
      const found = await getDrawPackForShare(project.id, drawPackId)
      if (!found) {
        return NextResponse.json({ error: 'Draw pack not found' }, { status: 404 })
      }
      return NextResponse.json({
        ok: true,
        pack: found.pack,
        photos: found.photos,
        project: {
          name: project.name,
          client: project.client,
          location: project.location,
          status: project.status,
        },
      })
    }
    const data = await getProjectPayload(project.id)
    if (!data) {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
    }
    return NextResponse.json({
      ok: true,
      data,
      project: {
        name: project.name,
        client: project.client,
        location: project.location,
        status: project.status,
      },
    })
  },
)

/** 400 with the honest size message (see S2 note above — same family as every other share body error). */
const bodyTooLarge = (): NextResponse =>
  NextResponse.json(
    { error: 'Request body too large — this endpoint accepts at most 64 KB' },
    { status: 400 },
  )

/**
 * POST /api/share { token, type, payload } — client-decision actions only.
 * The actor is always stamped as the project's client (role 'client') so the
 * Bias-Free Ledger records exactly who decided, from a public link.
 */
export const POST = publicRoute(
  {
    scope: 'api/share POST',
    rateLimit: { bucket: 'share.post', limit: 30, windowMs: 60_000 },
    onError: safeError(400, 'Action failed', { okFalse: true }),
  },
  // The handler reads + validates the body ITSELF (route-kit's `body` option
  // is deliberately omitted): the S2 raw-byte cap must run on the raw string
  // BEFORE JSON.parse, and the zod issue rendering reuses zodIssueResponse.
  async (req, _session, _body) => {
    // S2 layer 1 — raw-body cap, mirroring the Daraja webhook gate.
    const declared = Number(req.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return bodyTooLarge()
    const raw = await req.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return bodyTooLarge()

    // S2 layer 2 — parse + strict zod validation ({ error, field? } failures).
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsed = shareBodySchema.safeParse(body)
    if (!parsed.success) return zodIssueResponse(parsed.error.issues)
    const { token, type, payload } = parsed.data

    // Allowlist check via find() — it narrows the validated string to an
    // ActionType without a cast, and keeps the 403 (policy) OUT of the zod
    // schema's 400s (shape) exactly as before W3-1.
    const actionType = CLIENT_ALLOWLIST.find((t) => t === type)
    if (!actionType) {
      return NextResponse.json({ error: 'Not permitted from a client link' }, { status: 403 })
    }
    const project = await db.project.findUnique({ where: { shareToken: token } })
    if (!project) {
      return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
    }
    // Actor identity comes from the link itself — clients can never impersonate the site team
    const clientPayload = { ...(payload ?? {}), __actor: project.client, __role: 'client' }
    const result = await applyAction(actionType, clientPayload, project.id)
    const data = await getProjectPayload(project.id)
    return NextResponse.json({ ok: true, result, data })
  },
)
