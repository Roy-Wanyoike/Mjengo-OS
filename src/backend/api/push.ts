import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/backend/lib/db'
import { getVapidPublicKey } from '@/backend/modules/notify/channels'
import { route, safeError } from '@/backend/lib/route-kit'

// Web push routes (W5-1) — src/app/api/push/{subscribe,unsubscribe}/route.ts
// are the shims. Session-scoped (ANY signed-in role — the diaspora CLIENT
// persona is the whole point of the channel), zod-validated, rate-limited.
//
// POST /api/push/subscribe — store the browser's PushSubscription for the
// SESSION user. The body is exactly PushSubscription.toJSON() as the browser
// produces it: { endpoint, keys: { p256dh, auth }, expirationTime? }. UPSERT
// keyed on the endpoint — one row per browser subscription ever; a second
// user subscribing from the same browser re-owns the row (that browser now
// belongs to that session's account — the previous owner stops receiving
// there). HONEST: the row is stored even when no VAPID pair is configured —
// subscriptions are the address book; the SENDS stay 'logged' (fail-closed,
// see channels.ts). No VAPID check here, by design.
//
// GET /api/push/subscribe — the subscribe surface's config probe: the
// VAPID public key the browser needs to create a subscription, or
// { configured: false } when the pair is not set (the UI then honestly says
// "not configured" instead of faking a subscription). The public key is not
// a secret — every subscribed browser holds it; the PRIVATE half never
// leaves the server env.
//
// POST /api/push/unsubscribe — revoke the stored subscription: deletes the
// SESSION user's row for that endpoint ({ ok, removed }). Scoped to the
// session user's own rows — one account cannot revoke another's. The
// browser-side push-service revocation (subscription.unsubscribe()) is the
// CLIENT's job right before it calls this route; the row's 404/410-at-send
// pruning (service.ts) is the safety net when the browser vanished silently.
//
// Rate limits (S-SEC posture): subscribe/unsubscribe 10 mutations/min per
// principal (browser churn is rare; scripted churn is abuse), the config
// probe 30 reads/min. Body cap 1 MB (a real subscription is < 1 KB — the
// cap exists so junk never reaches JSON.parse, not as a business rule).

/** PushSubscription.toJSON() as the browser sends it (strict — typos rejected). */
const subscribeBody = z.strictObject({
  endpoint: z.string('endpoint must be a string').url('endpoint must be a valid URL (the browser push-service address)'),
  keys: z.strictObject({
    p256dh: z.string('keys.p256dh must be a string').min(1, 'keys.p256dh must not be empty').max(512),
    auth: z.string('keys.auth must be a string').min(1, 'keys.auth must not be empty').max(512),
  }),
  expirationTime: z
    .number('expirationTime must be a number (epoch ms) or null')
    .int()
    .nonnegative()
    .nullable()
    .optional(),
})

/** Unsubscribe just needs the endpoint that identified the subscription. */
const unsubscribeBody = z.strictObject({
  endpoint: z.string('endpoint must be a string').url('endpoint must be a valid URL'),
})

/** Raw-body cap: a real subscription is < 1 KB; 1 MB keeps junk out of the parser. */
const MAX_BODY_BYTES = 1_048_576

export const GET = route(
  {
    scope: 'api/push/subscribe GET',
    // The settings surface probes this on mount — 30 reads/min is plenty for
    // one user and still not a free polling target.
    rateLimit: { bucket: 'push.config', limit: 30, windowMs: 60_000 },
    onError: safeError(500, 'Could not read the web push configuration'),
  },
  async () => {
    const publicKey = getVapidPublicKey()
    if (!publicKey) {
      // Fail-closed, stated honestly: no complete VAPID pair → the channel
      // cannot send, so the UI must not offer a live subscription.
      return NextResponse.json({ ok: true, configured: false })
    }
    return NextResponse.json({ ok: true, configured: true, publicKey })
  },
)

export const POST = route(
  {
    scope: 'api/push/subscribe POST',
    rateLimit: { bucket: 'push.subscribe', limit: 10, windowMs: 60_000 },
    body: { schema: subscribeBody, maxBytes: MAX_BODY_BYTES },
    onError: safeError(400, 'Could not store the web push subscription'),
  },
  async (req, session, body) => {
    // Upsert ON THE ENDPOINT (globally unique): first subscribe creates the
    // row; re-subscribing refreshes the keys; a different session user on the
    // same browser re-owns it. Exactly one row per endpoint, ever.
    await db.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: {
        userId: session.user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        expirationTime: body.expirationTime != null ? new Date(body.expirationTime) : null,
        userAgent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
      },
      update: {
        userId: session.user.id,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        expirationTime: body.expirationTime != null ? new Date(body.expirationTime) : null,
        userAgent: req.headers.get('user-agent')?.slice(0, 300) ?? null,
      },
    })
    return NextResponse.json({ ok: true })
  },
)

export const POSTUnsubscribe = route(
  {
    scope: 'api/push/unsubscribe POST',
    rateLimit: { bucket: 'push.unsubscribe', limit: 10, windowMs: 60_000 },
    body: { schema: unsubscribeBody, maxBytes: MAX_BODY_BYTES },
    onError: safeError(400, 'Could not revoke the web push subscription'),
  },
  async (_req, session, body) => {
    // Scoped to the SESSION user's rows: an account revokes only its own
    // subscription (a row re-owned by another user is theirs to revoke).
    const result = await db.pushSubscription.deleteMany({
      where: { userId: session.user.id, endpoint: body.endpoint },
    })
    return NextResponse.json({ ok: true, removed: result.count })
  },
)
