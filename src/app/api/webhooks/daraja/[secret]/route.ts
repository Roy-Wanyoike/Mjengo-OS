// M-Pesa Daraja STK callback — the secret-path webhook (public, no session).
//
// SECURITY MODEL (honest, in full):
//   (a) UNGUESSABLE URL: this route only exists conceptually at
//       /api/webhooks/daraja/{segment} where segment = sha256(DARAJA_
//       WEBHOOK_SECRET) first 32 hex chars (daraja.ts — the same URL is the
//       CallBackURL embedded in every STK push). A request with any other
//       segment gets a plain 404: route scanners learn nothing, and with
//       DARAJA_WEBHOOK_SECRET unset the expected segment cannot be derived,
//       so EVERY segment 404s (fail closed). The comparison is
//       timing-safe. This is the authentication model real payment
//       aggregators use for webhook URLs.
//   (b) REPLAY / IDEMPOTENCY: the handler dedupes on CheckoutRequestID
//       BEFORE anything is posted — an in-memory Set (per process) plus the
//       durable IdempotencyRecord pattern the wallet module already uses
//       (spec §57); the ledger posting additionally carries
//       idempotencyKey daraja.callback:<id>, so even a cross-process replay
//       cannot double-post money.
//   (c) RECONCILIATION: the callback body is NEVER sufficient for money
//       movement. Before crediting, the handler queries the Daraja
//       stkpushquery API (provider.verifyPayment) and only a verified
//       ResultCode 0 posts the balanced double-entry through the ledger
//       module for the matching pending intent (never a credit without one).
//   (d) ORIGIN / NETWORK: browser-Origin checking mirrors route-kit's
//       MUTATION_ORIGIN_ALLOWLIST gate (env-gated, no-Origin callers pass —
//       Safaricom is a server, not a browser). OPTIONAL source-IP allowlist
//       (issue #35): when DARAJA_ALLOWED_IPS is set (comma-separated IPv4
//       CIDRs, e.g. 196.201.214.0/24), the request's resolved client IP
//       (x-forwarded-for per TRUST_PROXY — rate-limit.ts clientIpFromHeaders)
//       must match BEFORE the body is parsed; non-matching or unresolvable
//       sources get a generic 403. Unset = the documented posture (unguessable
//       path + query-API reconciliation). IPv6 entries are exact-match only
//       (no IPv6 CIDR — documented limitation); invalid entries are warned +
//       ignored, and a set-but-empty allowlist denies everything (fail
//       closed). TLS terminates at the reverse proxy in front of the app.
//
// Body quirk: Safaricom POSTs JSON with a text/plain-ish content-type — the
// raw body is read once and parsed regardless of the declared type.
//
// Response contract: 2xx { ok, action, detail } for every accepted event —
// duplicates, non-success results, unverified and unmatched callbacks all get
// honest reasons (never a fake credit). Malformed JSON → 400. Unexpected
// internal errors → 500 so Safaricom retries; the durable dedupe + ledger
// idempotency make retries money-safe.

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { processDarajaStkCallback } from '@/backend/modules/wallet/daraja-callback'
import { darajaWebhookSegment } from '@/backend/modules/wallet/daraja'
import { ipAllowed, parseIpAllowlist } from '@/backend/modules/wallet/ip-allowlist'
import { clientIpFromHeaders } from '@/backend/lib/rate-limit'

export const dynamic = 'force-dynamic'

/** Mirror of route-kit's MUTATION_ORIGIN_ALLOWLIST gate (see route-kit.ts). */
function originDenied(req: NextRequest): boolean {
  const raw = process.env.MUTATION_ORIGIN_ALLOWLIST
  if (!raw) return false
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (allowed.length === 0) return false
  const origin = req.headers.get('origin')
  if (!origin) return false // non-browser caller (Safaricom) — not a CSRF vector
  return !allowed.includes(origin)
}

/** Timing-safe segment comparison; wrong/absent secret env → never a match. */
function segmentMatches(given: string): boolean {
  const secret = process.env.DARAJA_WEBHOOK_SECRET
  if (!secret) return false
  const expected = darajaWebhookSegment(secret)
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Optional source-IP allowlist (issue #35), checked BEFORE any body read.
 * Unset env → allowed (the documented posture). Set → the resolved client
 * IP must match an entry. Invalid entries warn + are ignored; a set-but-
 * empty allowlist denies everything (fail closed), as does an unresolvable
 * IP (no x-forwarded-for at all — the source cannot be verified, so it is
 * not verified). The response is generic on purpose: no config, no echo.
 */
function sourceIpDenied(req: NextRequest): boolean {
  const raw = process.env.DARAJA_ALLOWED_IPS
  if (!raw || !raw.trim()) return false
  const { entries, invalid } = parseIpAllowlist(raw)
  if (invalid.length > 0) {
    // Honest config signal; entry VALUES are not printed (no echo).
    console.warn(
      `[api/webhooks/daraja] DARAJA_ALLOWED_IPS has ${invalid.length} invalid entr${invalid.length === 1 ? 'y' : 'ies'} — ignored (supported: IPv4 CIDR, bare IPv4, exact IPv6 literal; IPv6 CIDR is NOT supported). Remaining valid entries still apply; zero valid entries denies all.`,
    )
  }
  const ip = clientIpFromHeaders(req.headers)
  return !ipAllowed(ip, entries)
}

const MAX_BODY_BYTES = 64 * 1024

type Ctx = { params: Promise<{ secret: string }> }

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  try {
    const { secret } = await ctx.params

    if (originDenied(req)) {
      return NextResponse.json(
        { error: `Origin "${req.headers.get('origin')}" is not allowed to mutate this API` },
        { status: 403 },
      )
    }

    // Source-IP allowlist — BEFORE the body is read (and before the secret
    // segment check: a non-permitted source learns nothing but the 403).
    if (sourceIpDenied(req)) {
      return NextResponse.json({ error: 'Source IP not permitted' }, { status: 403 })
    }

    if (!segmentMatches(secret)) {
      // Plain 404 — an unknown path is an unknown path; nothing is confirmed.
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const declared = Number(req.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
    }
    const raw = await req.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Request body too large' }, { status: 413 })
    }

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const outcome = await processDarajaStkCallback(body)
    return NextResponse.json(outcome)
  } catch (e) {
    // Money may or may not have committed — a 500 makes Safaricom retry, and
    // the durable dedupe + ledger idempotency key make the retry money-safe.
    console.error('[api/webhooks/daraja POST]', e)
    return NextResponse.json({ error: 'Callback processing failed' }, { status: 500 })
  }
}
