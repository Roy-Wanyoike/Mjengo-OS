import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '@/backend/lib/db'
import { applyAction } from '@/backend/lib/mjengo'
import { withAuditContext } from '@/backend/lib/audit'
import {
  checkUssdPinLockout,
  clearUssdPinFailures,
  clientIpFromHeaders,
  enforceRateLimit,
  recordUssdPinFailure,
} from '@/backend/lib/rate-limit'
import { warnIfWebhookSecretUnsetInProduction } from '@/backend/lib/webhook-secret-warning'

export const dynamic = 'force-dynamic'

// BE-6 (issue #76): the production posture warning — ONE loud line when this
// route would accept unauthenticated writes (secret unset). No-op in dev/test
// and once the secret is set; the fail-open behavior itself is unchanged and
// stays documented below.
warnIfWebhookSecretUnsetInProduction('api/ussd', 'USSD_WEBHOOK_SECRET')

/**
 * USSD gateway route (Doc A §56) — the endpoint an SMS/USSD aggregator
 * (Africa's Talking style) would POST into for the *384# Muster line:
 *   { sessionId, phoneNumber, text } — text is the CONCATENATED menu
 *   responses, '*'-separated, starting with the service code '*384#'.
 * Aggregator contract (not the app's session model): requests are STATELESS —
 * every menu level must be inferable from the text alone, so this parser
 * reads the full key sequence per request (no server-side session store for
 * sessionId — it is accepted but not persisted).
 *
 * Menu (minimal, honest):
 *   *384#                    → 1 Attendance  2 Balance  3 Help
 *   *384#*1*<workerPin>*<s>  → attendance: s 1=present 2=absent 3=half day
 *   *384#*2*<workerPin>      → unpaid wage balance for that worker
 *   *384#*3                  → help text
 *
 * Attendance dispatches through the SAME domain path the in-app *384#
 * simulation uses today (components/mjengo/ussd-tab.tsx):
 *   present      → applyAction('attendance.checkin', { workerId, toggle: 'in', method: 'ussd' })
 *                  (worker keyed their own PIN → verification 'verified',
 *                  evidence ['ussd','device'])
 *   absent / half→ applyAction('attendance.record', { records, verification: 'reported',
 *                  recordedBy: 'USSD *384#' }) (a statement, not evidence)
 * PIN resolution mirrors the tab: kiosk PIN (Worker.pin) first, else the last
 * 4 digits of the worker's phone.
 *
 * UNAUTHENTICATED BY DESIGN (gateway-trust model): the aggregator is trusted
 * to have authenticated the phone line; the worker's PIN is the identity
 * inside the session. HONEST: no real aggregator is wired to this route —
 * the response footer says 'MjengoOS sim' and GET describes the contract.
 *
 * W-AUDIT #2 hardening (both optional, demo-safe — unset = today's posture):
 *   · Rate limits: 20 req/min/phone (unchanged) PLUS 40 req/min per CLIENT-IP
 *     for PIN-bearing requests — the phone number is caller-supplied and
 *     rotates freely, so it alone could never throttle a 4-digit-PIN brute
 *     force from one host. The per-IP limit is honest for the demo posture;
 *     a real aggregator multiplexes many MSISDNs per gateway IP, so it would
 *     be raised or keyed on the aggregator's authenticated identity.
 *   · USSD_WEBHOOK_SECRET: when set, POSTs must carry `X-Signature:`
 *     lowercase-hex HMAC-SHA256 of the RAW request body under the secret —
 *     aggregator authentication (the demo gateway-trust model then becomes
 *     a shared-secret one). Unset keeps the open demo posture — and, since
 *     BE-6 (issue #76), logs ONE loud startup warning when
 *     NODE_ENV=production, so the open posture cannot ship silently.
 *
 * Audit-wave-2 hardening (issues #105 BE-4 / #106 BE-9):
 *   · 64 KB raw-body cap (declared Content-Length precheck + actual byte
 *     count after the read, BEFORE JSON.parse and before the HMAC check) —
 *     the whatsapp route's S2 gate mirrored 1:1; this was the only
 *     unauthenticated JSON route without one.
 *   · Per-PIN failure LOCKOUT: 5 wrong PINs for one phone within 15 min →
 *     a 15-minute lock for that line (honest "locked, try later" reply,
 *     correct PINs included — resolution is refused before any DB work).
 *     Keyed per phone, tracked in the SHARED rate-limit tracker store
 *     (in-process map, or db/ratelimit.db when RATE_LIMIT_STORE=sqlite —
 *     see createUssdPinLockout in rate-limit.ts). A correct PIN clears the
 *     count (consecutive-failure semantics).
 *   · PHONE-TAIL PIN FALLBACK IS DROPPED when USSD_WEBHOOK_SECRET is set:
 *     last-4-of-phone is DEMO posture only (anyone who knows the worker's
 *     number can key it). With a real aggregator secret set — i.e. the
 *     operator is running the shared-secret posture — only the stored kiosk
 *     PIN (Worker.pin) resolves a worker. Secret unset → fallback stays
 *     (documented demo posture, unchanged).
 * All rate limiting + lockout use the shared limiter/tracker stores (single
 * instance — see src/backend/lib/rate-limit.ts).
 */

const SERVICE_CODE = '*384#'
const USSD_FOOTER = '\n— MjengoOS sim'
const MENU_TEXT = `MjengoOS Muster
1 Attendance
2 Balance
3 Help${USSD_FOOTER}`
const HELP_TEXT = `Dial ${SERVICE_CODE} then:
1*PIN*1 present
1*PIN*2 absent
1*PIN*3 half day
2*PIN balance${USSD_FOOTER}`
const ATTEND_USAGE = `Attendance:
Reply ${SERVICE_CODE}*1*PIN*status
1 present, 2 absent, 3 half${USSD_FOOTER}`
const BALANCE_USAGE = `Balance: reply ${SERVICE_CODE}*2*PIN${USSD_FOOTER}`

/** Plain-text USSD response (aggregators reply to the handset as text). */
function ussd(text: string): NextResponse {
  return new NextResponse(text, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/** Raw-body cap mirroring POST /api/whatsapp's S2 gate (400, same family). */
const MAX_BODY_BYTES = 64 * 1024

/** 400 with the honest size message (same family as every other body error here). */
function bodyTooLarge(): NextResponse {
  return NextResponse.json(
    { error: 'Request body too large — this endpoint accepts at most 64 KB' },
    { status: 400 },
  )
}

/** The honest locked-line reply (BE-9, issue #106) — names the wait. */
function pinLockedText(msLeft: number): string {
  const mins = Math.max(1, Math.ceil(msLeft / 60_000))
  return `Too many wrong PINs. This line is locked for ${mins} more minute(s) — try again later.${USSD_FOOTER}`
}

/** Last 4 digits of a phone — the demo PIN, exactly like the UI simulation. */
function phonePin(phone: string): string {
  return (phone || '').replace(/\D/g, '').slice(-4)
}

interface UssdWorker {
  id: string
  name: string
  projectId: string
}

/**
 * Resolve a worker by PIN across active workers (kiosk PIN first, then phone
 * last-4 — the same two-step the in-app simulation uses). First match wins;
 * PIN collisions across projects are possible in demo data (honest limit).
 *
 * BE-9 (issue #106): the phone-tail fallback is DEMO posture — when
 * USSD_WEBHOOK_SECRET is set (a real aggregator secret, the shared-secret
 * posture) it is SKIPPED and only the stored kiosk PIN resolves a worker.
 */
async function resolveWorkerByPin(pin: string): Promise<UssdWorker | null> {
  if (!pin) return null
  const byKioskPin = await db.worker.findMany({
    where: { active: true, pin },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, projectId: true },
    take: 1,
  })
  if (byKioskPin.length > 0) return byKioskPin[0]
  if (process.env.USSD_WEBHOOK_SECRET) return null // shared-secret posture: kiosk PIN only
  const active = await db.worker.findMany({
    where: { active: true },
    select: { id: true, name: true, projectId: true, phone: true },
    orderBy: { name: 'asc' },
  })
  return active.find((w) => phonePin(w.phone) === pin) ?? null
}

/**
 * Dispatch a domain action through the same applyAction path as the app,
 * wrapped in the request audit context (spec §43) with the worker — not a
 * manager — as the actor: the PIN keyed on the handset is the worker's own
 * statement, so the ledger row says who acted and from where.
 */
async function dispatchUssdAction(
  req: NextRequest,
  type: 'attendance.checkin' | 'attendance.record',
  payload: Record<string, unknown>,
  worker: UssdWorker,
): Promise<unknown> {
  const ctx = {
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
    userAgent: `ussd-gateway (${req.headers.get('user-agent')?.slice(0, 200) ?? 'unknown'})`,
    requestId: req.headers.get('x-request-id')?.trim() || crypto.randomUUID(),
    entity: type,
    entityId: worker.id,
  }
  return withAuditContext(ctx, () =>
    applyAction(
      type,
      { ...payload, __actor: worker.name, __role: 'ussd' },
      worker.projectId,
    ),
  )
}

const ATTEND_STATUS: Record<string, { code: string; label: string }> = {
  '1': { code: 'present', label: 'PRESENT' },
  '2': { code: 'absent', label: 'ABSENT' },
  '3': { code: 'half_day', label: 'HALF DAY' },
}

/** PIN-attempt rate limit (per client IP) — see file header. */
const PIN_IP_LIMIT_PER_MIN = 40

/** True when the menu path includes a worker PIN (attendance or balance). */
function isPinAttempt(parts: string[]): boolean {
  return (parts[0] === '1' || parts[0] === '2') && !!parts[1]
}

/**
 * Verify X-Signature (hex HMAC-SHA256 of the raw body) when USSD_WEBHOOK_SECRET
 * is set. Returns a 401 response when the header is missing or wrong, null when
 * OK (or when the optional hardening is unset — the demo posture).
 */
function verifyWebhookSignature(req: NextRequest, raw: string): NextResponse | null {
  const secret = process.env.USSD_WEBHOOK_SECRET
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

export async function POST(req: NextRequest) {
  try {
    // Raw body once — capped BEFORE anything else (BE-4, issue #105): the
    // declared Content-Length precheck refuses an oversized request before
    // the body is buffered at all; the post-read count catches a lying small
    // header. The HMAC (when enabled) is computed over the RAW bytes and the
    // JSON parse follows from the same string.
    const declared = Number(req.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return bodyTooLarge()
    const raw = await req.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return bodyTooLarge()

    const sigRejected = verifyWebhookSignature(req, raw)
    if (sigRejected) return sigRejected

    let body: { sessionId?: unknown; phoneNumber?: unknown; text?: unknown }
    try {
      body = JSON.parse(raw) as typeof body
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : ''
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!phoneNumber) return NextResponse.json({ error: 'phoneNumber required' }, { status: 400 })
    if (!text) return NextResponse.json({ error: 'text required (USSD input, e.g. *384#)' }, { status: 400 })
    // sessionId is part of the aggregator contract; requests stay stateless.

    // Rate limit per phone (20/min) — before any DB work.
    const limited = await enforceRateLimit(req, `ussd:${phoneNumber}`, 20, 60_000)
    if (limited) return limited

    if (!text.startsWith(SERVICE_CODE)) {
      return ussd(`Invalid code. Dial ${SERVICE_CODE}.${USSD_FOOTER}`)
    }
    const rest = text.slice(SERVICE_CODE.length)
    const parts = rest ? rest.split('*').filter((p) => p !== '') : []

    // PIN-bearing requests carry the worker's identity attempt — throttle them
    // by the CLIENT-IP principal too (W-AUDIT #2: the phoneNumber is
    // caller-supplied and rotates freely, so per-phone alone cannot stop a
    // 4-digit brute force from one host). No XFF → 'anon' principal (loopback).
    if (isPinAttempt(parts)) {
      const ip = clientIpFromHeaders(req.headers)
      const pinLimited = await enforceRateLimit(
        req,
        `ussd-pin-ip:${ip || 'anon'}`,
        PIN_IP_LIMIT_PER_MIN,
        60_000,
      )
      if (pinLimited) return pinLimited
      // BE-9 (issue #106): per-PIN failure lockout — 5 wrong PINs for this
      // phone in 15 min locks the line for 15 min. Refused BEFORE any DB
      // work, correct PIN included; the tracker lives in the shared
      // rate-limit store (see createUssdPinLockout in rate-limit.ts).
      const lock = checkUssdPinLockout(phoneNumber)
      if (lock.locked) return ussd(pinLockedText(lock.msLeft))
    }

    // ---- main menu ----
    if (parts.length === 0) return ussd(MENU_TEXT)

    // ---- 1: attendance ----
    if (parts[0] === '1') {
      const [pin, statusCode] = [parts[1], parts[2]]
      if (!pin || !statusCode) return ussd(ATTEND_USAGE)
      const status = ATTEND_STATUS[statusCode]
      if (!status) return ussd(ATTEND_USAGE)
      const worker = await resolveWorkerByPin(pin)
      if (!worker) {
        // Wrong PIN → count it; the 5th within the window trips the lock NOW.
        const trip = recordUssdPinFailure(phoneNumber)
        if (trip.locked) return ussd(pinLockedText(trip.msLeft))
        return ussd(`PIN not recognised. Dial ${SERVICE_CODE} to restart.${USSD_FOOTER}`)
      }
      clearUssdPinFailures(phoneNumber) // a correct PIN restarts the count
      // dispatchUssdAction throws on domain failure — the outer catch returns
      // the honest "could not record" text instead of a confirmation.
      if (status.code === 'present') {
        // Worker-initiated check-in — carries 'ussd' evidence (same payload
        // shape the in-app simulation dispatches).
        await dispatchUssdAction(req, 'attendance.checkin', {
          workerId: worker.id, toggle: 'in', method: 'ussd',
        }, worker)
      } else {
        // Absence / half day: a reported statement from the line.
        await dispatchUssdAction(req, 'attendance.record', {
          records: JSON.stringify([{ workerId: worker.id, status: status.code }]),
          verification: 'reported',
          recordedBy: 'USSD *384#',
        }, worker)
      }
      return ussd(`Attendance recorded.
${worker.name} — ${status.label}. Asante!${USSD_FOOTER}`)
    }

    // ---- 2: balance ----
    if (parts[0] === '2') {
      const pin = parts[1]
      if (!pin) return ussd(BALANCE_USAGE)
      const worker = await resolveWorkerByPin(pin)
      if (!worker) {
        // Wrong PIN → count it (balance is an identity attempt too).
        const trip = recordUssdPinFailure(phoneNumber)
        if (trip.locked) return ussd(pinLockedText(trip.msLeft))
        return ussd(`PIN not recognised. Dial ${SERVICE_CODE} to restart.${USSD_FOOTER}`)
      }
      clearUssdPinFailures(phoneNumber) // a correct PIN restarts the count
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
      return ussd(`${worker.name}
Unpaid balance: KSh ${owed.toLocaleString('en-KE')} (${unpaidRows} day(s)).${USSD_FOOTER}`)
    }

    // ---- 3: help ----
    if (parts[0] === '3') return ussd(HELP_TEXT)

    // Unknown selection — back to the menu.
    return ussd(MENU_TEXT)
  } catch (e) {
    console.error('[api/ussd POST]', e)
    // A gateway must get text back even when the domain action failed —
    // honest failure copy, never a JSON stack.
    return ussd(`Could not record — try again or use the app.${USSD_FOOTER}`)
  }
}

/** GET: the machine-readable contract (honest — no real gateway wired). */
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: 'POST /api/ussd',
    method: 'POST',
    body: {
      sessionId: 'string — aggregator session id (accepted; requests are stateless)',
      phoneNumber: 'string — caller MSISDN',
      text: 'string — concatenated menu responses, *-separated, starting *384#',
    },
    menu: {
      '*384#': 'main menu — 1 Attendance, 2 Balance, 3 Help',
      '*384#*1*<workerPin>*<statusCode>': 'attendance — statusCode 1=present, 2=absent, 3=half day',
      '*384#*2*<workerPin>': 'unpaid wage balance for that worker',
      '*384#*3': 'help text',
    },
    pinResolution:
      'kiosk PIN (Worker.pin) first, else last 4 digits of the worker phone — ' +
      'the phone-tail fallback is DEMO posture: it is dropped when USSD_WEBHOOK_SECRET is set ' +
      '(shared-secret posture → only the stored kiosk PIN resolves)',
    rateLimit:
      '20 requests/min/phone + 40 PIN-attempts/min per client IP + 5 wrong PINs/phone ' +
      'within 15 min → 15-minute line lockout (in-process token bucket / tracker store — single instance)',
    auth: 'unauthenticated by design (gateway-trust model); the worker PIN is the in-session identity',
    signature: 'USSD_WEBHOOK_SECRET (optional env): when set, POST requires X-Signature — lowercase-hex HMAC-SHA256 of the raw request body under the secret; unset = open demo posture',
    bodyCap: '64 KB raw (Content-Length precheck + actual byte count, before JSON.parse) → 400 beyond',
    honest:
      'No SMS/USSD aggregator is wired to this route — it speaks an Africa\'s Talking-style contract so one can be attached later. Attendance dispatches through the same domain actions (applyAction) as the app UI; every menu response is footered "MjengoOS sim".',
    contentType: 'text/plain; charset=utf-8',
  })
}
