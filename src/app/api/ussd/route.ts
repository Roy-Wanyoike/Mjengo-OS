import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { applyAction } from '@/lib/mjengo'
import { withAuditContext } from '@/lib/audit'
import { enforceRateLimit } from '@/lib/rate-limit'

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
 * Rate limit: 20 req/min/phone via the shared in-process limiter (single
 * instance — see src/lib/rate-limit.ts).
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

export async function POST(req: NextRequest) {
  try {
    let body: { sessionId?: unknown; phoneNumber?: unknown; text?: unknown }
    try {
      body = (await req.json()) as typeof body
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
    rateLimit: '20 requests/min/phone (in-process token bucket — single instance)',
    auth: 'unauthenticated by design (gateway-trust model); the worker PIN is the in-session identity',
    honest:
      'No SMS/USSD aggregator is wired to this route — it speaks an Africa\'s Talking-style contract so one can be attached later. Attendance dispatches through the same domain actions (applyAction) as the app UI; every menu response is footered "MjengoOS sim".',
    contentType: 'text/plain; charset=utf-8',
  })
}
