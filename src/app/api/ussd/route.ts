import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '@/backend/lib/db'
import { applyAction } from '@/backend/lib/mjengo'
import { withAuditContext } from '@/backend/lib/audit'
import { clientIpFromHeaders, enforceRateLimit } from '@/backend/lib/rate-limit'

export const dynamic = 'force-dynamic'

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
 *     a shared-secret one). Unset keeps the open demo posture.
 * Both use the shared in-process limiter (single instance — see
 * src/backend/lib/rate-limit.ts).
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
    // Raw body once: the HMAC (when enabled) is computed over the RAW bytes,
    // and the JSON parse follows from the same string.
    const raw = await req.text()

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
        return ussd(`PIN not recognised. Dial ${SERVICE_CODE} to restart.${USSD_FOOTER}`)
      }
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
        return ussd(`PIN not recognised. Dial ${SERVICE_CODE} to restart.${USSD_FOOTER}`)
      }
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
    pinResolution: 'kiosk PIN (Worker.pin) first, else last 4 digits of the worker phone',
    rateLimit: '20 requests/min/phone + 40 PIN-attempts/min per client IP (in-process token bucket — single instance)',
    auth: 'unauthenticated by design (gateway-trust model); the worker PIN is the in-session identity',
    signature: 'USSD_WEBHOOK_SECRET (optional env): when set, POST requires X-Signature — lowercase-hex HMAC-SHA256 of the raw request body under the secret; unset = open demo posture',
    honest:
      'No SMS/USSD aggregator is wired to this route — it speaks an Africa\'s Talking-style contract so one can be attached later. Attendance dispatches through the same domain actions (applyAction) as the app UI; every menu response is footered "MjengoOS sim".',
    contentType: 'text/plain; charset=utf-8',
  })
}
