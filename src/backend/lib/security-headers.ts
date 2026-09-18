// Security response headers — issue #178 / audit SEC-11.
//
// WHY THIS EXISTS: the app shipped only X-Content-Type-Options + Referrer-Policy
// (next.config.ts). No CSP meant an injected script or a compromised dependency
// ran unrestrained; no HSTS meant the first plain-HTTP visit was downgradeable;
// and the app was framable by ANY origin — the preview gateway embeds it in a
// cross-site iframe (the "framable by design" product decision), but nothing
// stopped an attacker page from doing the same to a signed-in user (clickjacking
// that stacked with the SEC-1 CSRF hole).
//
// THE SPLIT (which header lives where, and why):
//   · STATIC set (next.config.ts headers(), every response incl. proxy-
//     skipped paths): X-Content-Type-Options, Referrer-Policy, Permissions-Policy
//     — scheme-independent, no per-request values, cannot break the preview.
//   · DYNAMIC set (src/proxy.ts — Next 16's renamed middleware, per request):
//     Content-Security-Policy (nonce-based — see below), Strict-Transport-
//     Security (https responses only), X-Frame-Options (the compat belt — see
//     xFrameOptionsEnabled).
//
// THE CSP SHAPE — honest about what a config-level CSP cannot do:
//   · script-src needs a per-request NONCE. Next's RSC payload is delivered via
//     inline `self.__next_f.push(...)` scripts whose content is dynamic, so a
//     hash is impossible and 'unsafe-inline' would gut the directive. Next 16
//     reads the nonce from the REQUEST's Content-Security-Policy header
//     (server/app-render app-render.js) and stamps it on every script tag it
//     renders — the proxy sets that request header, and the root layout
//     threads the same nonce to its one hand-written inline script (SW
//     registration). 'strict-dynamic' lets nonced scripts load their own
//     dependencies; 'self' remains ONLY as the legacy-browser fallback
//     (strict-dynamic-capable browsers ignore it by design).
//   · style-src keeps 'unsafe-inline' — React inline style attributes and
//     styled-jsx/Tailwind runtime styles need it; there is no Next nonce
//     stamping for styles. Honest trade-off, documented.
//   · dev-only relaxations: 'unsafe-eval' (React Refresh runtime) and ws:/wss:
//     connect-src (Turbopack HMR websocket). Gated on NODE_ENV === 'development'
//     exactly — a production build must never carry them.
//   · NO upgrade-insecure-requests: the preview path may be plain-http by
//     design (HSTS section of DEPLOYMENT.md §7.4 documents the posture).
//
// THE FRAMING DECISION (the core of #178): frame-ancestors is an ALLOWLIST —
// 'self' plus EMBED_ORIGINS (comma-separated origins, the MUTATION_ORIGIN_
// ALLOWLIST model: parsed per request, trimmed, case-insensitive). Unset
// (default) = same-origin framing only. The legit cross-site embedder (the
// preview gateway / any iframe consumer) is declared by the OPERATOR via env —
// the issue itself notes the origin must come from ops, so the safe default is
// closed and the knob opens it. X-Frame-Options: SAMEORIGIN is sent ONLY when
// the enforced CSP already restricts frame-ancestors to 'self' (enforce mode +
// no embed origins): modern browsers ignore XFO when frame-ancestors is
// enforced, and legacy browsers would otherwise block the legitimate embed —
// the "only where it doesn't fight frame-ancestors" rule from the issue.
//
// THE ROLLOUT (the issue's acceptance criterion): CSP_MODE ships defaulting to
// report-only — the header is on every response (so ops can watch the browser
// console + curl the deployment) but blocks nothing, which keeps the preview
// iframe rendering. Flipping to enforcement is the exact opt-in CSP_MODE=enforce
// (HEALTH_PUBLIC_DETAIL's strict-opt-in discipline: nothing but the literal
// value turns it on). HSTS is never gated by CSP_MODE: it is sent only on https
// responses where it cannot break a plain-http preview (browsers ignore STS
// headers over http by spec — we simply do not send it there).

/** Header names — shared by the proxy, tests and the docs. */
export const CSP_ENFORCE_HEADER = 'Content-Security-Policy'
export const CSP_REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only'
export const HSTS_HEADER = 'Strict-Transport-Security'
export const X_FRAME_OPTIONS_HEADER = 'X-Frame-Options'
/** The request header the proxy stamps the nonce on (the root layout reads it). */
export const NONCE_REQUEST_HEADER = 'x-nonce'

/** Default HSTS max-age: one year, no includeSubDomains (see parseHstsMaxAge). */
export const DEFAULT_HSTS_MAX_AGE = 31_536_000

/**
 * Parse a comma-separated origin list (EMBED_ORIGINS / CSP_IMG_ORIGINS — the
 * MUTATION_ORIGIN_ALLOWLIST model): trimmed, lowercased, deduped. An entry is
 * kept only when it parses as an ABSOLUTE http(s) URL — bare hosts, paths,
 * 'null' and garbage are dropped, never guessed into an origin.
 */
export function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const entry of raw.split(',')) {
    const value = entry.trim().toLowerCase()
    if (!value) continue
    try {
      const url = new URL(value)
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !out.includes(value)) {
        out.push(value)
      }
    } catch {
      // not an absolute origin — ignored (fail closed for the allowlist)
    }
  }
  return out
}

/**
 * CSP_MODE: true ONLY on the literal opt-in 'enforce' (case-insensitive).
 * Unset, 'report-only', 'enforced', 'on', '1', typos — everything else keeps
 * the report-only rollout posture (the shipped default; strict opt-in, same
 * discipline as HEALTH_PUBLIC_DETAIL).
 */
export function cspEnforced(mode: string | undefined): boolean {
  return mode?.trim().toLowerCase() === 'enforce'
}

/** `frame-ancestors` source list: 'self' plus the operator-declared embedders. */
export function frameAncestorsValue(embedOrigins: string[]): string {
  return ["'self'", ...embedOrigins].join(' ')
}

/**
 * X-Frame-Options: SAMEORIGIN is the legacy-browser belt-and-braces for
 * frame-ancestors — it may be sent ONLY when it cannot fight the CSP:
 *   · enforce mode (a report-only CSP does not block framing, so an enforced
 *     XFO would be the ONLY active frame restriction — that breaks the
 *     report-first rollout by blocking the legit embed out of the gate);
 *   · no cross-site embed origins (an enforced XFO has no allowlist mechanism:
 *     it would block exactly the embeds frame-ancestors exists to permit).
 * With both conditions met, frame-ancestors is just 'self' and XFO agrees
 * with it; modern browsers still let frame-ancestors take precedence.
 */
export function xFrameOptionsEnabled(embedOrigins: string[], enforce: boolean): boolean {
  return enforce && embedOrigins.length === 0
}

export interface CspOptions {
  /** Per-request nonce (the proxy generates; tests pin deterministic values). */
  nonce: string
  /** EMBED_ORIGINS — legit cross-site embedders for frame-ancestors. */
  embedOrigins: string[]
  /** CSP_IMG_ORIGINS — extra img-src origins (S3/R2/CDN photo deployments). */
  imgOrigins: string[]
  /** NODE_ENV === 'development' — unlocks 'unsafe-eval' + ws:/wss:. */
  isDev: boolean
}

/**
 * The Content-Security-Policy value. Every directive the app needs is listed
 * EXPLICITLY (no reliance on default-src fallbacks), so a test can pin the
 * exact directive set and accidental removals fail the suite.
 */
export function buildCsp({ nonce, embedOrigins, imgOrigins, isDev }: CspOptions): string {
  const imgSources = ["'self'", 'data:', 'blob:', ...imgOrigins].join(' ')
  const connectSources = ["'self'", 'data:', 'blob:', ...(isDev ? ['ws:', 'wss:'] : [])].join(' ')
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'self'",
    `frame-ancestors ${frameAncestorsValue(embedOrigins)}`,
    // 'self' is the legacy-browser fallback only; strict-dynamic-capable
    // browsers ignore it and trust the nonce (+ its dynamic loads).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSources}`,
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "form-action 'self'",
  ].join('; ')
}

/**
 * The Strict-Transport-Security value, or null when disabled (max-age 0 —
 * the documented escape hatch for dual-scheme hosts). includeSubDomains is
 * deliberately OPT-IN: the preview-gateway hosts are shared, and one app's
 * HSTS must never force https on sibling subdomains it does not own.
 */
export function buildHsts(maxAgeSeconds: number, includeSubdomains: boolean): string | null {
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) return null
  const directives = [`max-age=${Math.floor(maxAgeSeconds)}`]
  if (includeSubdomains) directives.push('includeSubDomains')
  return directives.join('; ')
}

/**
 * HSTS_MAX_AGE: unset/invalid → the one-year default; 0 → disabled (null
 * header); positive integers pass through. Negative and non-numeric values
 * fall back to the default — an operator typo must not silently disable HSTS.
 */
export function parseHstsMaxAge(raw: string | undefined): number {
  const value = (raw ?? '').trim()
  if (value === '') return DEFAULT_HSTS_MAX_AGE
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_HSTS_MAX_AGE
  if (parsed === 0) return 0
  if (parsed < 0) return DEFAULT_HSTS_MAX_AGE
  return parsed
}

/** HSTS_INCLUDE_SUBDOMAINS: 1/true only (strict opt-in — same as #164's flag). */
export function hstsIncludeSubdomains(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  return value === '1' || value === 'true'
}

/**
 * The scheme this request arrived as: the FIRST x-forwarded-proto entry when
 * a proxy forwarded one (the hop the client actually spoke to), else the
 * request URL's own protocol. Used ONLY to decide whether HSTS belongs on the
 * response — forging the header at worst adds a header browsers ignore over
 * plain http (spec), never a protection bypass.
 */
export function requestProto(
  forwardedProto: string | null,
  urlProtocol: string,
): 'http' | 'https' {
  const first = forwardedProto?.split(',')[0]?.trim().toLowerCase()
  if (first === 'https' || first === 'http') return first
  return urlProtocol.replace(':', '').toLowerCase() === 'https' ? 'https' : 'http'
}
