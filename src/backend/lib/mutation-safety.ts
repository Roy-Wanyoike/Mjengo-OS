// Default-on mutation safety gate (audit-2 SEC-1).
//
// WHY THIS EXISTS: the session cookie is `SameSite=None; Secure` behind the
// https proxy (the iframe-preview requirement — auth.ts), which removes the
// browser's default CSRF shield from every custom mutating route, and those
// routes historically parsed `req.text()` as JSON regardless of Content-Type.
// A cross-site page could therefore fire a "simple request"
// (fetch no-cors / text/plain form post) carrying a JSON body, the session
// cookie would ride along, and the body would parse — cross-site money and
// action dispatch with the default configuration.
//
// THE GATE (in order, for POST/PUT/PATCH/DELETE only — GET/HEAD/OPTIONS are
// untouched):
//   1. `Origin` present (browser cross-origin/same-origin marker):
//      allow when the origin's host[:port] matches the request's own host
//      (x-forwarded-host first entry, else host — compared scheme-agnostically,
//      case-insensitively — the app embedded in a cross-site iframe still
//      fetches its OWN api same-origin, so the preview posture survives), or
//      when the full Origin is listed in MUTATION_ORIGIN_ALLOWLIST
//      (comma-separated, trimmed, case-insensitive — extra legitimate embed
//      hosts). Anything else → 403 'cross-origin mutation blocked'.
//   2. Else `Sec-Fetch-Site` present (browsers that omit Origin for
//      same-origin POSTs still send it): allow only 'same-origin' or 'none';
//      'same-site'/'cross-site'/unknown → 403.
//   3. Else (non-browser client — curl, scripts, schedulers): bodyless
//      requests pass; a request WITH a body (Content-Length > 0 or a
//      Transfer-Encoding header) must declare Content-Type application/json
//      (parameters like charset tolerated) → 415 'json content-type required'.
//      This is the CSRF-classic content-type discriminator: HTML forms can
//      only send text/plain, application/x-www-form-urlencoded and
//      multipart/form-data, so those three can no longer carry a parseable
//      JSON body cross-site.
//
// DELIBERATELY NOT GATED HERE: /api/auth/** (next-auth's own CSRF machinery),
// /api/webhooks/** (server-to-server, own secret-path/HMAC models),
// /api/ussd + /api/whatsapp (aggregator contracts with their own optional
// HMAC), /api/jobs/run's bearer path (machine route, session path shares the
// skip via route-kit's skipMutationSafety — see jobs.ts) and every GET.
//
// HOW ERRORS SURFACE: exactly like the guard family — as JSON responses
// built from a status + one honest line. assertMutationSafety throws the
// typed error (for direct/unit use); mutationSafetyDenied adapts it to the
// NextResponse-or-null convention route-kit's pipeline and the shared /api/ai
// gate already consume (the old opt-in mutationOriginDenied shape).

import { NextResponse } from 'next/server'

/** The verbs this gate applies to (route-kit's historic MUTATING_METHODS set + PATCH). */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const CROSS_ORIGIN_BLOCKED = 'cross-origin mutation blocked'
export const JSON_CONTENT_TYPE_REQUIRED = 'json content-type required'

/** Typed denial — `status` is the HTTP status, `message` the honest one-liner. */
export class MutationSafetyError extends Error {
  readonly status: 403 | 415

  constructor(status: 403 | 415, message: string) {
    super(message)
    this.name = 'MutationSafetyError'
    this.status = status
  }
}

/**
 * The request's own host[:port], lowercase: the FIRST x-forwarded-host entry
 * when a proxy forwarded one (the host the client actually addressed), else
 * the host header, else the request URL's host (constructed Requests in
 * tests carry no host header). Empty string when nothing resolves —
 * same-origin matching then fails closed; only the allowlist can admit the
 * request.
 */
function requestHost(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-host')
  const first = forwarded?.split(',')[0]?.trim()
  if (first) return first.toLowerCase()
  const host = req.headers.get('host')?.trim()
  if (host) return host.toLowerCase()
  try {
    return new URL(req.url).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * MUTATION_ORIGIN_ALLOWLIST parsed per call (env can change without a
 * redeploy): comma-separated full Origins, trimmed, case-insensitive.
 */
function allowlistedOrigins(): string[] {
  const raw = process.env.MUTATION_ORIGIN_ALLOWLIST
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** True when the Origin header's host[:port] is the request's own host. */
function originMatchesRequestHost(origin: string, req: Request): boolean {
  let host: string
  try {
    host = new URL(origin).host.toLowerCase() // scheme-agnostic; port kept when non-default
  } catch {
    return false // 'null' (sandboxed iframe) or garbage — not same-origin
  }
  const own = requestHost(req)
  return !!own && host === own
}

/** A body is "present" when the transport says so (the body itself is never read here). */
function hasBody(req: Request): boolean {
  if (req.headers.get('transfer-encoding')) return true
  const declared = Number(req.headers.get('content-length') ?? '')
  return Number.isFinite(declared) && declared > 0
}

/**
 * Enforce the mutation safety gate for this request. Throws
 * MutationSafetyError (403 cross-origin / 415 content-type) on denial;
 * returns silently when the request is allowed. GET/HEAD/OPTIONS always pass.
 */
export function assertMutationSafety(req: Request): void {
  if (!MUTATING_METHODS.has(req.method)) return

  // 1. Browser cross-origin marker: same-host or explicitly allowlisted.
  const origin = req.headers.get('origin')
  if (origin !== null) {
    if (originMatchesRequestHost(origin, req) || allowlistedOrigins().includes(origin.toLowerCase())) return
    throw new MutationSafetyError(403, CROSS_ORIGIN_BLOCKED)
  }

  // 2. Fetch Metadata: only same-origin navigations/initiated requests pass.
  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite !== null) {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return
    throw new MutationSafetyError(403, CROSS_ORIGIN_BLOCKED)
  }

  // 3. Non-browser client: a body requires the JSON content type.
  if (!hasBody(req)) return
  const mediaType = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (mediaType === 'application/json') return
  throw new MutationSafetyError(415, JSON_CONTENT_TYPE_REQUIRED)
}

/**
 * The pipeline adapter (guard.ts's response convention): null when allowed,
 * else the ready-to-return `{ error }` JSON response (403 / 415). Used by
 * route-kit's runPipeline (every route()/publicRoute() mutation) and the
 * shared /api/ai/* policy gate in rate-limit.ts.
 */
export function mutationSafetyDenied(req: Request): NextResponse | null {
  try {
    assertMutationSafety(req)
    return null
  } catch (e) {
    if (e instanceof MutationSafetyError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }
}
