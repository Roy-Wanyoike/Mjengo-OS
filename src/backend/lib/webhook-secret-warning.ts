// Webhook secret posture warning (BE-6, issue #76; posture updated by
// SEC-4, audit wave 2).
//
// /api/ussd and /api/whatsapp accept unauthenticated writes BY DESIGN while
// their optional HMAC secret (USSD_WEBHOOK_SECRET / WHATSAPP_WEBHOOK_SECRET)
// is unset — the documented open demo / gateway-trust posture (the aggregator
// is trusted to have authenticated the phone line; the worker's PIN or phone
// number is the in-session identity). That posture is fine for dev/test and
// the demo. In PRODUCTION the routes now FAIL CLOSED (SEC-4): with the secret
// unset, POST is refused with 503 before any processing — a missing secret
// never means unauthenticated attendance/payroll writes. This module makes
// that disabled state IMPOSSIBLE to miss: ONE loud console.warn per route per
// process when NODE_ENV=production and the secret is unset (mirroring the
// rate-limit store resolution warnings, which also log once at startup
// rather than per request).
//
// A failed create() story is irrelevant here (pure env reads); the once-only
// guard exists so a route called thousands of times logs exactly one line —
// and so tests can pin the once-only contract directly.

/** Route labels already warned in THIS process (once-only per route). */
const warned = new Set<string>()

/**
 * Warn loudly, once per process, when a webhook route is DISABLED by the
 * production fail-closed posture (SEC-4): secret unset + NODE_ENV=production
 * → the route refuses every POST with 503 until the secret is set.
 *
 * Called at module scope by each route (the startup posture warning) — safe
 * to call again anywhere (the Set makes repeats no-ops). Silent when:
 *   · NODE_ENV is anything but 'production' (dev/test keep the documented
 *     open demo posture without noise), or
 *   · the secret IS set (the HMAC gate is live — nothing to warn about).
 */
export function warnIfWebhookSecretUnsetInProduction(routeLabel: string, secretEnvName: string): void {
  if (process.env.NODE_ENV !== 'production') return
  if (process.env[secretEnvName]) return
  if (warned.has(routeLabel)) return
  warned.add(routeLabel)
  console.warn(
    `[${routeLabel}] PRODUCTION POSTURE: ${secretEnvName} is unset — this route ` +
      `FAILS CLOSED: POST is refused with 503 until the secret is set. ` +
      `Set ${secretEnvName} (X-Signature: lowercase-hex HMAC-SHA256 of the raw request body) ` +
      `before pointing real aggregator/relay traffic at it. ` +
      `See the route's GET contract for the exact signing scheme.`,
  )
}
