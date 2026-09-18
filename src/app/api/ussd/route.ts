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
import {
  unauthenticatedWebhookWritesRefused,
  warnIfWebhookSecretUnsetInProduction,
  webhookOpenPostureOptedIn,
} from '@/backend/lib/webhook-secret-warning'
import { captureError } from '@/backend/lib/errors/sink'
import { currentRequestId, log, withRequestLogging } from '@/backend/lib/log'

export const dynamic = 'force-dynamic'

// BE-6 (issue #76) + SEC-4 (audit wave 2) + the open-posture opt-in
// (issue #156): the posture signal — ONE loud line whenever this route is
// in a state an operator must know about. No-op once the secret is set.
//   · production + unset secret → announces the FAIL-CLOSED state
//     (POST → 503 until the secret is set) — SEC-4, unchanged;
//   · any non-production runtime + unset secret + WEBHOOK_OPEN_POSTURE=1
//     → announces the ACTIVE open posture (unauthenticated writes ARE
//     being accepted) — issue #156;
//   · non-production + unset secret + no opt-in → silent (the route fails
//     closed with 503, the safe default — nothing is being accepted).
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
 *     force from one host. Since issue #156 the per-IP key is trust-aware:
 *     with TRUST_PROXY unset the (forgeable) x-forwarded-for header is
 *     IGNORED and every caller shares the one 'anon' bucket — rotating XFF
 *     values can no longer refresh it; set TRUST_PROXY=1 behind a proxy you
 *     control for per-client keys. The honest limit for the demo posture
 *     either way; a real aggregator multiplexes many MSISDNs per gateway IP,
 *     so it would be raised or keyed on the aggregator's authenticated
 *     identity.
 *   · USSD_WEBHOOK_SECRET: when set, POSTs must carry `X-Signature:`
 *     lowercase-hex HMAC-SHA256 of the RAW request body under the secret —
 *     aggregator authentication (the demo gateway-trust model then becomes
 *     a shared-secret one). Unset keeps the open demo posture ONLY when it
 *     is explicitly opted into outside production: WEBHOOK_OPEN_POSTURE=1
 *     (issue #156). Otherwise an unset secret FAILS CLOSED in EVERY runtime
 *     (SEC-4 extended beyond production): POST returns 503 before any body
 *     read or processing — the route refuses unauthenticated writes rather
 *     than accepting them, and the startup warning names the posture.
 *
 * Audit-wave-2 hardening (issues #105 BE-4 / #106 BE-9):
 *   · 64 KB raw-body cap (declared Content-Length precheck + actual byte
 *     count after the read, BEFORE JSON.parse and before the HMAC check) —
 *     the whatsapp route's S2 gate mirrored 1:1; this was the only
 *     unauthenticated JSON route without one.
 *   · Per-PIN failure LOCKOUT (BE-9, issue #106; REKEYED by issue #176/SEC-9):
 *     5 wrong PINs within 15 min → a 15-minute lock (honest "locked, try
 *     later" reply, correct PINs included — resolution is refused before any
 *     DB WRITE work). Keyed on values the attacker cannot freely choose
 *     (issue #176: the phone-keyed budget was refreshable by rotating
 *     MSISDNs — the 40/min per-IP throttle was the only real bound — and a
 *     correct phone-tail PIN could clear the count):
 *       - PRIMARY: the CLIENT-IP principal (trust-aware clientIpFromHeaders;
 *         TRUST_PROXY unset → the ONE shared 'anon' budget — 5 wrong PINs per
 *         15 min across ALL untrusted callers, the honest demo bound; with
 *         TRUST_PROXY=1 → per client IP). Rotating the phone number can NEVER
 *         refresh this budget. A correct PIN does NOT clear it either (that
 *         was the refresh exploit) — the budget is sticky for its 15-min
 *         window. HONEST deployment note: a real aggregator multiplexes
 *         MSISDNs through one gateway IP, so this budget is shared per
 *         gateway (availability traded for brute-force resistance — raise /
 *         re-key on the aggregator's authenticated identity when wiring one,
 *         same as the throttle above).
 *       - SECONDARY: the RESOLVED WORKER identity for kiosk-PIN attempts —
 *         wrong PINs attributed to a worker (the caller's line maps to an
 *         active worker: aggregator-vouched under the shared secret;
 *         spoofable in the open posture, where the ip budget is the real
 *         bound) accumulate on that worker's tracker regardless of which
 *         phone/IP sent them, and a locked worker is refused from ANY phone
 *         (checked after resolution, before any write). A correct KIOSK pin
 *         clears the worker's own count (consecutive semantics on the
 *         identity that proved itself); a correct phone-tail pin clears
 *         nothing. Honest limit: a MISSED guess names no target worker, so
 *         per-worker accumulation keys on the caller's line — every miss
 *         lands on the unrefreshable ip budget either way.
 *     THE EFFECTIVE BOUND (issue #176's ask, stated plainly): wrong-PIN rate
 *     is bounded by the lockout (5 per 15 min per ip principal), NOT by the
 *     40/min bucket — the bucket remains only as the outer cap on total
 *     PIN-attempt traffic (correct PINs included). Tracked in the SHARED
 *     rate-limit tracker store (see createUssdPinLockout in rate-limit.ts).
 *   · PHONE-TAIL PIN FALLBACK IS DROPPED unless the open posture is
 *     explicitly enabled (issue #156, closing the SECURITY_BASELINE :92
 *     gap): last-4-of-phone is DEMO posture only (anyone who knows the
 *     worker's number can key it — a 10^4 keyspace identity for attendance
 *     writes and wage-balance disclosure). It resolves a worker ONLY when
 *     USSD_WEBHOOK_SECRET is unset AND WEBHOOK_OPEN_POSTURE=1 is set (the
 *     explicitly chosen open demo posture); otherwise only the stored kiosk
 *     PIN (Worker.pin) does — secret set (shared-secret posture) or no
 *     opt-in (the fail-closed default) alike.
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

/**
 * SEC-4 (audit wave 2) + issue #156: the fail-closed posture. When
 * USSD_WEBHOOK_SECRET is unset and the open posture has NOT been explicitly
 * opted into (WEBHOOK_OPEN_POSTURE=1, non-production only), POST is refused
 * with 503 BEFORE any body read or processing — a missing secret must never
 * mean "accept unauthenticated writes" (real attendance rows) in ANY
 * runtime. Production always fails closed without the secret (SEC-4,
 * unchanged — the opt-in is ignored there); dev/test/demo keep the open
 * gateway-trust posture only as an explicit choice (vitest runs
 * NODE_ENV=test and sets WEBHOOK_OPEN_POSTURE=1 in its route fixtures).
 */
function unconfiguredWebhookSecret(): NextResponse {
  return NextResponse.json(
    {
      error:
        'USSD_WEBHOOK_SECRET is not configured — this webhook refuses unauthenticated writes. ' +
        'Set the aggregator shared secret (POST then requires X-Signature: lowercase-hex HMAC-SHA256 of the raw request body) and restart the app' +
        (process.env.NODE_ENV === 'production'
          ? '.'
          : ', or explicitly opt into the open demo posture outside production with WEBHOOK_OPEN_POSTURE=1.'),
    },
    { status: 503 },
  )
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

/** The honest locked reply (BE-9, issues #106 + #176) — names the wait. */
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
  /** Which resolution path produced this worker (issue #176: only a KIOSK
   *  resolution proves kiosk-PIN knowledge, so only it clears the worker's
   *  own lockout count — a phone-tail resolution is the 10^4 demo identity
   *  and must stay a non-refreshing event). */
  via: 'kiosk' | 'tail'
}

/**
 * Resolve a worker by PIN across active workers (kiosk PIN first, then phone
 * last-4 — the same two-step the in-app simulation uses). First match wins;
 * PIN collisions across projects are possible in demo data (honest limit).
 *
 * BE-9 (issue #106) + issue #156: the phone-tail fallback is DEMO posture —
 * it resolves a worker ONLY when the open posture is explicitly active
 * (USSD_WEBHOOK_SECRET unset — a shared-secret posture means kiosk PIN only
 * — AND WEBHOOK_OPEN_POSTURE=1). Default (no opt-in): kiosk PIN only, the
 * same identity path the shared-secret posture uses.
 */
async function resolveWorkerByPin(pin: string): Promise<UssdWorker | null> {
  if (!pin) return null
  const byKioskPin = await db.worker.findMany({
    where: { active: true, pin },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, projectId: true },
    take: 1,
  })
  if (byKioskPin.length > 0) return { ...byKioskPin[0], via: 'kiosk' }
  // Phone-tail fallback: explicitly opted-in open posture ONLY (issue #156).
  // Secret set → shared-secret posture (kiosk PIN only); no opt-in → the
  // fail-closed default (kiosk PIN only) — the 10^4 last-4 identity never
  // silently re-activates.
  if (process.env.USSD_WEBHOOK_SECRET || !webhookOpenPostureOptedIn()) return null
  const active = await db.worker.findMany({
    where: { active: true },
    select: { id: true, name: true, projectId: true, phone: true },
    orderBy: { name: 'asc' },
  })
  const byTail = active.find((w) => phonePin(w.phone) === pin)
  return byTail ? { id: byTail.id, name: byTail.name, projectId: byTail.projectId, via: 'tail' } : null
}

/**
 * The worker the caller's LINE maps to (issue #176): the active worker whose
 * stored phone equals the caller-supplied MSISDN. Under the shared secret the
 * whole body is aggregator-HMAC'd, so this mapping is aggregator-vouched — a
 * wrong kiosk-PIN attempt from that line is attributable to that worker (the
 * per-worker lockout key). In the open posture the MSISDN is bare JSON, so the
 * attribution is spoofable there — the ip-keyed budget remains the real bound,
 * and a spoofed attribution can only lock the worker's identity path (in that
 * posture knowing the number already carries the phone-tail identity).
 */
async function lineWorker(phoneNumber: string): Promise<{ id: string } | null> {
  const rows = await db.worker.findMany({
    where: { active: true, phone: phoneNumber },
    orderBy: { name: 'asc' },
    select: { id: true },
    take: 1,
  })
  return rows[0] ?? null
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
    requestId: currentRequestId() ?? crypto.randomUUID(),
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

export function POST(req: NextRequest): Promise<NextResponse> {
  // Issue #204: this route is deliberately NOT route-kit (text/plain
  // aggregator contract) but still gets the full request-id treatment —
  // mint/honor x-request-id, logs under the request carry it, the response
  // echoes it, one access line on completion.
  return withRequestLogging(req, 'api/ussd POST', async () => {
  // SEC-4 (audit wave 2) + issue #156: unset secret and no explicit open
  // posture → 503, no processing — FAIL CLOSED (production always; any other
  // runtime unless WEBHOOK_OPEN_POSTURE=1 opts into the demo posture).
  if (unauthenticatedWebhookWritesRefused('USSD_WEBHOOK_SECRET')) {
    return unconfiguredWebhookSecret()
  }
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

    // PIN-bearing requests carry the worker's identity attempt — throttle
    // them by the CLIENT-IP principal too (W-AUDIT #2: the phoneNumber is
    // caller-supplied and rotates freely, so per-phone alone cannot stop a
    // 4-digit brute force from one host), and (issue #176) key the PIN
    // LOCKOUT on the same principal. Trust-aware since issue #156: no
    // TRUST_PROXY → clientIpFromHeaders returns '' → the ONE shared 'anon'
    // principal (rotating XFF values cannot refresh anything keyed on it);
    // TRUST_PROXY=1 → the proxy-appended last value (per-client keys). This
    // is the one value in a PIN attempt the caller cannot freely choose.
    const clientIp = clientIpFromHeaders(req.headers)

    if (isPinAttempt(parts)) {
      const pinLimited = await enforceRateLimit(
        req,
        `ussd-pin-ip:${clientIp || 'anon'}`,
        PIN_IP_LIMIT_PER_MIN,
        60_000,
      )
      if (pinLimited) return pinLimited
      // BE-9 + issue #176: the pre-resolution lockout gate, keyed on the
      // client-IP principal — rotating phone numbers (or worker targets)
      // cannot refresh this budget, and a locked principal is refused BEFORE
      // any DB work, correct PINs included (tracker store: see
      // createUssdPinLockout in rate-limit.ts).
      const lock = checkUssdPinLockout({ ip: clientIp })
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
        // Wrong PIN → count it (issue #176 keying): always on the client-IP
        // principal (the unrefreshable budget), plus on the worker the
        // caller's LINE maps to when it maps to one (the per-worker tracker —
        // aggregator-vouched under the shared secret, best-effort in the open
        // posture). The 5th strike within the window locks NOW.
        const line = await lineWorker(phoneNumber)
        const trip = recordUssdPinFailure({ ip: clientIp, workerId: line?.id })
        if (trip.locked) return ussd(pinLockedText(trip.msLeft))
        return ussd(`PIN not recognised. Dial ${SERVICE_CODE} to restart.${USSD_FOOTER}`)
      }
      // Issue #176: the resolved worker identity carries its own tracker — a
      // locked worker is refused from ANY phone (this check follows the
      // read-only PIN lookup; no write happens before it).
      const workerLock = checkUssdPinLockout({ ip: clientIp, workerId: worker.id })
      if (workerLock.locked) return ussd(pinLockedText(workerLock.msLeft))
      // Only a KIOSK resolution proves kiosk-PIN knowledge → only it restarts
      // the worker's own count (a phone-tail resolution is the 10^4 demo
      // identity and must never refresh anything — issue #176).
      if (worker.via === 'kiosk') clearUssdPinFailures({ workerId: worker.id })
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
        // Wrong PIN → count it (balance is an identity attempt too) — same
        // issue #176 keying as the attendance branch.
        const line = await lineWorker(phoneNumber)
        const trip = recordUssdPinFailure({ ip: clientIp, workerId: line?.id })
        if (trip.locked) return ussd(pinLockedText(trip.msLeft))
        return ussd(`PIN not recognised. Dial ${SERVICE_CODE} to restart.${USSD_FOOTER}`)
      }
      const workerLock = checkUssdPinLockout({ ip: clientIp, workerId: worker.id })
      if (workerLock.locked) return ussd(pinLockedText(workerLock.msLeft))
      if (worker.via === 'kiosk') clearUssdPinFailures({ workerId: worker.id })
      const [agg, unpaidRows] = await Promise.all([
        db.attendance.aggregate({
          where: { workerId: worker.id, paid: false, status: { not: 'absent' } },
          _sum: { wage: true },
        }),
        db.attendance.count({
          where: { workerId: worker.id, paid: false, status: { not: 'absent' } },
        }),
      ])
      const owed = Number(agg._sum.wage ?? 0n) / 100
      return ussd(`${worker.name}
Unpaid balance: KSh ${owed.toLocaleString('en-KE')} (${unpaidRows} day(s)).${USSD_FOOTER}`)
    }

    // ---- 3: help ----
    if (parts[0] === '3') return ussd(HELP_TEXT)

    // Unknown selection — back to the menu.
    return ussd(MENU_TEXT)
  } catch (e) {
    log.error('api/ussd POST', 'Request failed', { error: e })
    // Issue #202 — same failure to the opt-in error sink (fire-and-forget;
    // the requestId context above rides along in the payload).
    captureError(e, { scope: 'api/ussd POST' })
    // A gateway must get text back even when the domain action failed —
    // honest failure copy, never a JSON stack.
    return ussd(`Could not record — try again or use the app.${USSD_FOOTER}`)
  }
  })
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
      'kiosk PIN (Worker.pin) first; the last-4-of-phone fallback resolves ONLY in the ' +
      'explicitly opted-in open posture (secret unset + WEBHOOK_OPEN_POSTURE=1) — secret set ' +
      '(shared-secret posture) or no opt-in → the stored kiosk PIN only (issue #156)',
    rateLimit:
      '20 requests/min/phone + 40 PIN-attempts/min per client IP (outer cap) + the EFFECTIVE wrong-PIN bound: ' +
      '5 wrong PINs per client-IP principal within 15 min → 15-minute lockout, correct PINs refused too (issue #176 — ' +
      'rotating phone numbers can no longer refresh the budget, and a correct PIN does not clear it). ' +
      'Kiosk-PIN attempts additionally carry a per-worker lockout: wrong PINs attributed to a worker via the caller\'s ' +
      'line accumulate on that worker regardless of phone, and a locked worker is refused from any phone; a correct ' +
      'kiosk PIN clears the worker\'s own count (a phone-tail PIN never clears anything). ' +
      'Token bucket / tracker store shared per host by default (issue #158). ' +
      'The per-IP keying is trust-aware (issue #156): TRUST_PROXY unset → all callers share the one anon budget ' +
      '(a forgeable x-forwarded-for is ignored); TRUST_PROXY=1 → the proxy-appended value. Honest aggregator note: ' +
      'a real gateway multiplexes MSISDNs through one IP — raise / re-key on the aggregator\'s authenticated identity when wiring one',
    auth: 'unauthenticated by design (gateway-trust model); the worker PIN is the in-session identity',
    signature:
      'USSD_WEBHOOK_SECRET (optional env): when set, POST requires X-Signature — lowercase-hex HMAC-SHA256 of the raw request body under the secret. ' +
      'Unset FAILS CLOSED in EVERY runtime unless WEBHOOK_OPEN_POSTURE=1 explicitly opts into the open demo posture OUTSIDE production ' +
      '(issue #156): production + unset → 503 always (SEC-4, the opt-in is ignored); non-prod + unset + no opt-in → 503; ' +
      'non-prod + unset + opt-in → open posture (warn-and-accept, documented demo posture)',
    bodyCap: '64 KB raw (Content-Length precheck + actual byte count, before JSON.parse) → 400 beyond',
    honest:
      'No SMS/USSD aggregator is wired to this route — it speaks an Africa\'s Talking-style contract so one can be attached later. Attendance dispatches through the same domain actions (applyAction) as the app UI; every menu response is footered "MjengoOS sim".',
    contentType: 'text/plain; charset=utf-8',
  })
}
