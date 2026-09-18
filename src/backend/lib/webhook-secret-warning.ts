// Webhook secret posture (BE-6 issue #76 → SEC-4 audit wave 2 → issue #156:
// the open-posture opt-in).
//
// /api/ussd and /api/whatsapp are unauthenticated gateway seams BY DESIGN:
// the aggregator/relay is trusted to have authenticated the phone line, and
// the optional HMAC secret (USSD_WEBHOOK_SECRET / WHATSAPP_WEBHOOK_SECRET)
// upgrades that to a shared-secret posture when set. The question #156 closes:
// what happens when the secret is UNSET? Posture matrix (route × runtime):
//
//   secret SET                → HMAC gate live in EVERY runtime (401 without
//                               a valid X-Signature). This is the only
//                               posture that should ever face a real gateway.
//   secret unset + production → FAIL CLOSED (SEC-4): POST → 503 before any
//                               body read. The opt-in below is IGNORED here —
//                               production never accepts unauthenticated
//                               writes on a missing secret.
//   secret unset + non-prod
//     + WEBHOOK_OPEN_POSTURE=1→ OPEN posture (explicit opt-in, issue #156):
//                               warn-and-accept, exactly the historical demo
//                               behavior — now a choice, not an accident.
//     + opt-in unset           → FAIL CLOSED, same 503 as production. This is
//                               the new DEFAULT for dev/test/staging/preview/
//                               no-NODE_ENV containers: a forgotten env no
//                               longer silently re-opens the write surface.
//
// This module centralizes that decision so both routes (and their tests) share
// one definition, and makes the risky states IMPOSSIBLE to miss: ONE loud
// console.warn per route per process whenever unauthenticated writes are
// actually being ACCEPTED (open posture active) or the production gate has
// closed the route (SEC-4) — mirroring the rate-limit store resolution
// warnings, which also log once at startup rather than per request.
//
// A failed create() story is irrelevant here (pure env reads); the once-only
// guard exists so a route called thousands of times logs exactly one line —
// and so tests can pin the once-only contract directly.

/** Route labels already warned in THIS process (once-only per route). */
const warned = new Set<string>()

/**
 * True when WEBHOOK_OPEN_POSTURE explicitly opts into the open demo posture
 * (issue #156): any non-empty value except 0/false. The opt-in only matters
 * OUTSIDE production — `unauthenticatedWebhookWritesRefused` ignores it under
 * NODE_ENV=production, and the USSD phone-tail PIN fallback requires the
 * secret to be unset anyway (shared-secret posture = kiosk PIN only).
 */
export function webhookOpenPostureOptedIn(): boolean {
  const v = process.env.WEBHOOK_OPEN_POSTURE
  if (!v || !v.trim()) return false
  const lower = v.trim().toLowerCase()
  return lower !== '0' && lower !== 'false'
}

/**
 * True when this route must FAIL CLOSED for POST (issue #156, extending the
 * SEC-4 seam beyond strict production): the secret is unset AND there is no
 * explicitly opted-in open posture outside production. Callers answer with
 * the 503 configuration error BEFORE any body read or processing — a missing
 * secret must never silently mean "accept unauthenticated writes" (real
 * attendance rows), whatever the runtime.
 *
 *   NODE_ENV=production              → refused whenever the secret is unset
 *                                       (the opt-in is ignored — unchanged
 *                                       SEC-4 behavior).
 *   non-production + opt-in unset    → refused (the new fail-closed default).
 *   non-production + opt-in set      → NOT refused (the explicit open demo
 *                                       posture — warn-and-accept).
 *   secret set (any runtime)         → never refused (the HMAC gate answers).
 */
export function unauthenticatedWebhookWritesRefused(secretEnvName: string): boolean {
  if (process.env[secretEnvName]) return false
  if (process.env.NODE_ENV === 'production') return true
  return !webhookOpenPostureOptedIn()
}

/**
 * Warn loudly, once per process, whenever a webhook route is in a posture an
 * operator must know about (issue #156 extends BE-6/SEC-4 beyond production):
 *   · NODE_ENV=production + secret unset → the route FAILS CLOSED: POST is
 *     refused with 503 until the secret is set (SEC-4 — the opt-in is
 *     ignored in production);
 *   · any OTHER runtime + secret unset + WEBHOOK_OPEN_POSTURE explicitly set
 *     → the OPEN posture is ACTIVE: unauthenticated writes (real attendance
 *     rows) are being accepted. One loud line so the demo/staging operator
 *     sees exactly what they opted into.
 * Silent when the secret is set (the HMAC gate is live) and when the route
 * is fail-closed outside production (the safe default — nothing is being
 * accepted, so there is nothing to warn about).
 *
 * Called at module scope by each route (the startup posture warning) — safe
 * to call again anywhere (the Set makes repeats no-ops).
 */
export function warnIfWebhookSecretUnsetInProduction(routeLabel: string, secretEnvName: string): void {
  if (process.env[secretEnvName]) return
  if (warned.has(routeLabel)) return
  if (process.env.NODE_ENV === 'production') {
    warned.add(routeLabel)
    console.warn(
      `[${routeLabel}] PRODUCTION POSTURE: ${secretEnvName} is unset — this route ` +
        `FAILS CLOSED: POST is refused with 503 until the secret is set. ` +
        `Set ${secretEnvName} (X-Signature: lowercase-hex HMAC-SHA256 of the raw request body) ` +
        `before pointing real aggregator/relay traffic at it. ` +
        `See the route's GET contract for the exact signing scheme.`,
    )
    return
  }
  if (webhookOpenPostureOptedIn()) {
    warned.add(routeLabel)
    console.warn(
      `[${routeLabel}] OPEN POSTURE (WEBHOOK_OPEN_POSTURE=1): ${secretEnvName} is unset and ` +
        `unauthenticated writes ARE being accepted in this ${process.env.NODE_ENV || 'development'} runtime — ` +
        `the explicit demo/gateway-trust posture (attendance rows via applyAction, phone-keyed identity). ` +
        `Set ${secretEnvName} (X-Signature: lowercase-hex HMAC-SHA256 of the raw request body) before ` +
        `pointing real aggregator/relay traffic at it, or unset WEBHOOK_OPEN_POSTURE to fail closed (503).`,
    )
  }
}
