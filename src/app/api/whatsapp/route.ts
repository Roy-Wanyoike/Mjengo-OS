import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '@/backend/lib/db'
import { applyAction, type ActionType } from '@/backend/lib/mjengo'
import { withAuditContext } from '@/backend/lib/audit'
import { clientIpFromHeaders, enforceRateLimit } from '@/backend/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * WhatsApp webhook route (W4-3) — the honest seam for the field channel
 * Kenya's sites actually use. Speaks the contract a WhatsApp Business relay
 * (Meta Cloud API bridge or an aggregator) would POST into:
 *   { from, text, timestamp } — `from` is the sender MSISDN, `text` the
 *   message body. `timestamp` is accepted but NEVER trusted: the server
 *   clock stamps every row (a lying relay cannot back-date attendance).
 *
 * Identity = the phone number: the sender is resolved against Worker.phone
 * of ACTIVE workers (digit-normalized, exact first, else last-9-digits —
 * Kenyan MSISDN 2547…/07…). This mirrors the USSD line's resolveWorkerByPin
 * two-step (kiosk PIN, else phone last-4) — the phone itself is the PIN
 * here. First match wins (name ASC); a number shared by two sites resolves
 * to the first (honest demo limit, same wording as the USSD route).
 *
 * Grammar (whole message, trimmed, case-insensitive):
 *   PRESENT → attendance.checkin { workerId, toggle:'in', method:'whatsapp' }
 *             (the worker keyed it on their own handset — verification
 *             'verified', evidence ['whatsapp','device'])
 *   ABSENT  → attendance.record { records, verification:'reported',
 *             recordedBy:'WhatsApp' } (a statement, not evidence)
 *   HALF    → attendance.record { status:'half_day', verification:'reported' }
 *   BALANCE → unpaid wage balance reply (read-only, same aggregate as USSD)
 *   HELP    → usage text
 *   free text → comment.add pinned to the project's MOST RECENT site photo
 *             (author = worker name, the applier's field-crew comment role
 *             'foreman'); no photos yet → honest "note not saved" reply,
 *             nothing written.
 *
 * THE ACTION ALLOWLIST IS THE GRAMMAR (share.ts discipline): exactly
 * attendance.checkin, attendance.record, comment.add — ZERO wallet/land/
 * supply types. The route is flag-family safe BY CONSTRUCTION: the W3-1
 * shared gate (src/backend/lib/action-flag-gate.ts) exists for surfaces
 * whose action surface can drift into FLAGGED_ACTION_FAMILIES; this
 * grammar cannot, so the gate is documented here and never consulted.
 * applyAction's own domain role gates apply as everywhere else.
 *
 * UNAUTHENTICATED BY DESIGN (gateway-trust model, exactly like /api/ussd):
 * the relay is trusted to have authenticated the phone line; the number
 * itself is the in-session identity. HONEST: no WhatsApp provider is wired
 * to this route — every text reply carries the '— MjengoOS sim' footer and
 * GET /api/whatsapp documents this contract for the future wiring.
 *
 * Hardening (both optional, demo-safe — unset = open demo posture):
 *   · WHATSAPP_WEBHOOK_SECRET: when set, POSTs must carry `X-Signature:`
 *     lowercase-hex HMAC-SHA256 of the RAW request body under the secret
 *     (timing-safe compare — the same verifyWebhookSignature mechanics as
 *     the USSD route). Unset keeps the open demo posture, documented.
 *   · Rate limits: 20 req/min per phone PLUS 40 req/min per CLIENT-IP for
 *     EVERY POST (unlike USSD's PIN-only IP throttle — every WhatsApp POST
 *     carries a worker-identity attempt, so the IP bucket always applies).
 *     Per-IP is honest for the demo posture; a real relay multiplexes many
 *     MSISDNs per gateway IP, so it would be raised or keyed on the relay's
 *     authenticated identity.
 *   · 64 KB raw-body cap (declared Content-Length precheck + actual byte
 *     count after read, BEFORE JSON.parse — the S2/ Daraja webhook gate):
 *     a lying client cannot push a huge payload into the parser.
 * Both rate buckets use the shared limiter store (see rate-limit.ts).
 */

const WHATSAPP_FOOTER = '\n— MjengoOS sim'

/** The grammar IS the allowlist — zero wallet/land/supply types by construction. */
const WHATSAPP_ACTION_ALLOWLIST = [
  'attendance.checkin',
  'attendance.record',
  'comment.add',
] as const satisfies ReadonlyArray<ActionType>

type AllowedAction = (typeof WHATSAPP_ACTION_ALLOWLIST)[number]

/** Raw-body cap mirroring POST /api/share's S2 gate (400, same family). */
const MAX_BODY_BYTES = 64 * 1024

const HELP_TEXT = `MjengoOS WhatsApp keywords:
PRESENT — check in (you worked today)
ABSENT — report you cannot make it
HALF — half day
BALANCE — your unpaid wage balance
HELP — this message
Anything else — a note on the latest site photo${WHATSAPP_FOOTER}`

/** Plain-text WhatsApp reply (the relay sends this text back to the handset). */
function wa(text: string): NextResponse {
  return new NextResponse(text, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/** Digits-only phone normalization (MSISDN forms: +254…, 254…, 07…). */
function phoneDigits(phone: string): string {
  return (phone || '').replace(/\D/g, '')
}

/**
 * Same subscriber? Exact digits first; else last-9 match — a Kenyan MSISDN
 * is 9 significant digits however it is written (2547… international vs
 * 07… local), so a worker seeded as 0722111222 is reachable as
 * +254722111222 and vice versa.
 */
function phonesMatch(stored: string, given: string): boolean {
  const a = phoneDigits(stored)
  const b = phoneDigits(given)
  if (!a || !b) return false
  if (a === b) return true
  return a.length >= 9 && b.length >= 9 && a.slice(-9) === b.slice(-9)
}

interface WhatsWorker {
  id: string
  name: string
  projectId: string
}

/**
 * Resolve the sender against ACTIVE workers by phone (the mirror of
 * resolveWorkerByPin: there the worker keys a PIN, here the phone IS the
 * identity). First match wins, name ASC — honest demo limit, same as USSD.
 */
async function resolveWorkerByPhone(from: string): Promise<WhatsWorker | null> {
  const digits = phoneDigits(from)
  if (!digits) return null
  const active = await db.worker.findMany({
    where: { active: true },
    select: { id: true, name: true, projectId: true, phone: true },
    orderBy: { name: 'asc' },
  })
  return active.find((w) => phonesMatch(w.phone, digits)) ?? null
}

/**
 * Dispatch a domain action through the same applyAction path as the app,
 * wrapped in the request audit context (spec §43) with the worker — not a
 * manager — as the actor: the phone that sent the text is the worker's own,
 * so the ledger row says who acted and from where. Allowlist membership is
 * re-checked at runtime (share.ts's find() discipline): the grammar is the
 * only way in, and nothing else ever dispatches from this route.
 */
async function dispatchWhatsappAction(
  req: NextRequest,
  type: AllowedAction,
  payload: Record<string, unknown>,
  worker: WhatsWorker,
): Promise<unknown> {
  const actionType = WHATSAPP_ACTION_ALLOWLIST.find((t) => t === type)
  if (!actionType) {
    throw new Error(`Action "${type}" is not on the WhatsApp allowlist`)
  }
  const ctx = {
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
    userAgent: `whatsapp-gateway (${req.headers.get('user-agent')?.slice(0, 200) ?? 'unknown'})`,
    requestId: req.headers.get('x-request-id')?.trim() || crypto.randomUUID(),
    entity: type,
    entityId: worker.id,
  }
  return withAuditContext(ctx, () =>
    applyAction(
      type,
      { ...payload, __actor: worker.name, __role: 'whatsapp' },
      worker.projectId,
    ),
  )
}

/**
 * Verify X-Signature (hex HMAC-SHA256 of the raw body) when
 * WHATSAPP_WEBHOOK_SECRET is set. Returns a 401 response when the header is
 * missing or wrong, null when OK (or when the optional hardening is unset —
 * the documented open demo posture). Mechanics mirror the USSD route 1:1.
 */
function verifyWebhookSignature(req: NextRequest, raw: string): NextResponse | null {
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET
  if (!secret) return null // unset = demo posture (gateway-trust), documented
  const given = req.headers.get('x-signature')?.trim().toLowerCase() ?? ''
  if (!given) {
    return NextResponse.json(
      { error: 'Missing X-Signature header — HMAC-SHA256 (hex) of the raw request body is required' },
      { status: 401 },
    )
  }
  const expected = createHmac('sha256', secret).update(raw).digest('hex')
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Invalid X-Signature' }, { status: 401 })
  }
  return null
}

/** 400 with the honest size message (same family as every other body error here). */
function bodyTooLarge(): NextResponse {
  return NextResponse.json(
    { error: 'Request body too large — this endpoint accepts at most 64 KB' },
    { status: 400 },
  )
}

export async function POST(req: NextRequest) {
  try {
    // Raw body once: the HMAC (when enabled) is computed over the RAW bytes,
    // the 64 KB cap runs before JSON.parse, and the parse follows.
    const declared = Number(req.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return bodyTooLarge()
    const raw = await req.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return bodyTooLarge()

    const sigRejected = verifyWebhookSignature(req, raw)
    if (sigRejected) return sigRejected

    let body: { from?: unknown; text?: unknown; timestamp?: unknown }
    try {
      body = JSON.parse(raw) as typeof body
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const from = typeof body.from === 'string' ? body.from.trim() : ''
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!from) return NextResponse.json({ error: 'from required (sender phone, MSISDN)' }, { status: 400 })
    if (!text) return NextResponse.json({ error: 'text required (message body)' }, { status: 400 })
    // timestamp is part of the relay contract but is NEVER trusted — the
    // server clock stamps every row (documented in the GET contract).

    // Rate limit per phone (20/min) — before any DB work.
    const limited = await enforceRateLimit(req, `whatsapp:${from}`, 20, 60_000)
    if (limited) return limited

    // And per CLIENT-IP (40/min): every POST carries a worker-identity
    // attempt, so the IP bucket always applies (the phone is caller-supplied
    // and rotates freely — per-phone alone cannot stop scripted abuse from
    // one host). No XFF → 'anon' principal (loopback).
    const ip = clientIpFromHeaders(req.headers)
    const ipLimited = await enforceRateLimit(req, `whatsapp-ip:${ip || 'anon'}`, 40, 60_000)
    if (ipLimited) return ipLimited

    // Identity = the phone. Unknown number → honest reply, zero rows written
    // (resolution is read-only; nothing below runs).
    const worker = await resolveWorkerByPhone(from)
    if (!worker) {
      return wa(
        `${from} is not registered to a worker on any MjengoOS site. Ask the site team to add your number in the Fundis tab, then text again.${WHATSAPP_FOOTER}`,
      )
    }

    // ---- keyword grammar (whole message, trimmed, case-insensitive) ----
    const keyword = text.toUpperCase()
    if (keyword === 'PRESENT') {
      // Worker-initiated check-in — carries 'whatsapp' evidence (the same
      // checkin applier the app and the *384# line use; method 'whatsapp'
      // stamps the evidence array honestly).
      await dispatchWhatsappAction(req, 'attendance.checkin', {
        workerId: worker.id, toggle: 'in', method: 'whatsapp',
      }, worker)
      return wa(`Attendance recorded.\n${worker.name} — PRESENT. Asante!${WHATSAPP_FOOTER}`)
    }
    if (keyword === 'ABSENT' || keyword === 'HALF') {
      // Absence / half day: a reported statement from the line, not evidence.
      const status = keyword === 'ABSENT' ? 'absent' : 'half_day'
      await dispatchWhatsappAction(req, 'attendance.record', {
        records: JSON.stringify([{ workerId: worker.id, status }]),
        verification: 'reported',
        recordedBy: 'WhatsApp',
      }, worker)
      return wa(`Attendance recorded.\n${worker.name} — ${keyword}. Asante!${WHATSAPP_FOOTER}`)
    }
    if (keyword === 'BALANCE') {
      // Read-only unpaid wage balance — the same aggregate the USSD line and
      // the Fundis payroll use (unpaid, non-absent days).
      const [agg, unpaidRows] = await Promise.all([
        db.attendance.aggregate({
          where: { workerId: worker.id, paid: false, status: { not: 'absent' } },
          _sum: { wage: true },
        }),
        db.attendance.count({
          where: { workerId: worker.id, paid: false, status: { not: 'absent' } },
        }),
      ])
      const owed = Math.round(agg._sum.wage ?? 0)
      return wa(
        `${worker.name}\nUnpaid balance: KSh ${owed.toLocaleString('en-KE')} (${unpaidRows} day(s)).${WHATSAPP_FOOTER}`,
      )
    }
    if (keyword === 'HELP') return wa(HELP_TEXT)

    // ---- free text → a note on the latest site photo ----
    // The only comment surface the domain has is photo comments, so a field
    // note rides the project's most recent photo (the WhatsApp-group habit:
    // chatter lands next to the latest picture). No photo yet → honest
    // refusal, nothing written.
    const photo = await db.sitePhoto.findFirst({
      where: { projectId: worker.projectId },
      orderBy: { createdAt: 'desc' },
    })
    if (!photo) {
      return wa(
        `Note not saved — this site has no photo yet to pin it to. Reply HELP for what this line can do.${WHATSAPP_FOOTER}`,
      )
    }
    await dispatchWhatsappAction(req, 'comment.add', {
      photoId: photo.id,
      author: worker.name,
      role: 'foreman', // the applier's only field-crew comment role
      message: text,
    }, worker)
    return wa(`Note added to the site photo thread.\n${worker.name} — asante!${WHATSAPP_FOOTER}`)
  } catch (e) {
    console.error('[api/whatsapp POST]', e)
    // A gateway must get text back even when the domain action failed —
    // honest failure copy, never a JSON stack.
    return wa(`Could not record — try again or use the app.${WHATSAPP_FOOTER}`)
  }
}

/**
 * GET: the human-readable webhook contract (plain text, so a relay operator
 * can read it straight from the endpoint). Same fields the USSD route's GET
 * documents, rendered as text; see HELP_TEXT for the in-band grammar.
 */
export async function GET() {
  const doc = `MjengoOS WhatsApp webhook — CONTRACT (honest seam, no provider wired)

POST /api/whatsapp
  Content-Type: application/json
  Body: { "from": "<sender MSISDN, e.g. 254722111222 or +254722111222>",
          "text": "<message body>",
          "timestamp": "<optional; accepted but NEVER trusted — the server clock stamps rows>" }
  Reply: 200 text/plain; charset=utf-8 — the message the relay sends back.
  Every text reply ends with the footer "— MjengoOS sim" (simulation honesty).

Grammar (whole message, trimmed, case-insensitive):
  PRESENT   → attendance.checkin  { workerId, toggle:'in', method:'whatsapp' }
              worker evidence — verification 'verified', evidence ['whatsapp','device']
  ABSENT    → attendance.record   { records:[{workerId,status:'absent'}], verification:'reported',
              recordedBy:'WhatsApp' } — a statement, not evidence
  HALF      → attendance.record   { records:[{workerId,status:'half_day'}], verification:'reported' }
  BALANCE   → unpaid wage balance reply (read-only; unpaid, non-absent days)
  HELP      → usage text
  free text → comment.add pinned to the project's MOST RECENT site photo
              (author = worker name, comment role 'foreman'); if the site has
              no photos yet the reply honestly says the note was NOT saved.

Worker resolution: "from" is matched against Worker.phone of ACTIVE workers —
digits normalized (non-digits stripped), exact match first, else last-9-digits
(Kenyan MSISDN 2547…/07…). First match wins, name ASC (honest demo limit when
two sites share a number). Unknown number → honest "not registered" reply and
ZERO rows written.

Action allowlist: attendance.checkin, attendance.record, comment.add — nothing
else. Zero wallet/land/supply action types are reachable from this route:
flag-family safe by construction (the W3-1 shared gate,
src/backend/lib/action-flag-gate.ts, exists for surfaces whose action surface
can drift into the flagged families; this grammar cannot, so it never consults
the gate).

Auth: unauthenticated by design (gateway-trust model, like the USSD line) —
the relay is trusted to have authenticated the phone; the number is the
in-session identity. Optional hardening:
  WHATSAPP_WEBHOOK_SECRET: when set, POST requires
    X-Signature: <lowercase-hex HMAC-SHA256 of the RAW request body under the secret>
  (timing-safe compare). Unsigned or mismatched → 401. Unset = documented open
  demo posture.

Rate limits (shared token-bucket store — single instance, see
src/backend/lib/rate-limit.ts):
  20 requests/min per phone (bucket whatsapp:<from>)
  40 requests/min per client IP (bucket whatsapp-ip:<ip> — every POST carries a
  worker-identity attempt, so the IP bucket always applies)
  Exhaustion → 429 { error: "Too many requests", retryAfterSec } + Retry-After.

Body cap: 64 KB raw (Content-Length precheck + actual byte count, before
JSON.parse) → 400 beyond.

Honesty: no WhatsApp provider (Meta Cloud API or aggregator) is wired to this
route today — it speaks the contract one would POST into so it can be attached
later without domain changes. Attendance and notes dispatched here are real
rows through the same applyAction appliers the app, the *384# line and the
offline sync all share.
`
  return new NextResponse(doc, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
