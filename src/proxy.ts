// Per-request security headers — issue #178 / audit SEC-11. The DYNAMIC half
// of the header set (the static half — X-Content-Type-Options, Referrer-Policy,
// Permissions-Policy — stays in next.config.ts headers(), which also covers the
// paths this matcher skips). See src/backend/lib/security-headers.ts for the
// full design rationale; the essentials:
//
//   · CSP with a per-request nonce. Next 16 reads the nonce from the REQUEST's
//     Content-Security-Policy header (app-render.js) and stamps it on every
//     script it renders, so the nonce must ride the FORWARDED request headers
//     (NextResponse.next({ request: { headers } })) — not just the response.
//     The root layout (src/app/layout.tsx) reads the same x-nonce for its one
//     hand-written inline script.
//   · CSP_MODE defaults to report-only (the issue's rollout: watch first, then
//     CSP_MODE=enforce). EMBED_ORIGINS declares the legit cross-site embedders
//     (the preview-gateway posture) for frame-ancestors.
//   · Strict-Transport-Security only on https requests (direct or
//     x-forwarded-proto via the gateway) — plain-http previews never see it.
//   · X-Frame-Options: SAMEORIGIN only in enforce mode with no embed origins
//     (it would fight frame-ancestors otherwise — legacy browsers have no
//     allowlist mechanism).
//
// Next 16's edge convention is `src/proxy.ts` exporting `proxy` — the renamed
// middleware (Next 16.1 logs a deprecation warning for `middleware.ts`, and
// this file is NEW in #178, so it ships on the current convention).
//
// The matcher deliberately SKIPS: _next/static (hashed assets — CSP is
// meaningless there), /website (the proxied marketing site is its own Next app
// whose scripts carry no nonce — an enforced nonce CSP would break it), and
// /offline.html (the static self-contained SW fallback shell: its inline
// language-switch script + retry button predate CSP and have no untrusted
// input). Those paths still get the full static set from next.config.ts.

import { NextResponse, type NextRequest } from 'next/server'

import {
  CSP_ENFORCE_HEADER,
  CSP_REPORT_ONLY_HEADER,
  HSTS_HEADER,
  NONCE_REQUEST_HEADER,
  X_FRAME_OPTIONS_HEADER,
  buildCsp,
  buildHsts,
  cspEnforced,
  hstsIncludeSubdomains,
  parseHstsMaxAge,
  parseOriginList,
  requestProto,
  xFrameOptionsEnabled,
} from '@/backend/lib/security-headers'

/** Which paths run through this proxy (see the header comment for the skips). */
export const config = {
  matcher: ['/((?!_next/static|website|offline\\.html).*)'],
}

export function proxy(req: NextRequest): NextResponse {
  // Fresh unguessable nonce per request (122 bits, hex — a valid CSP
  // base64-value token; crypto.randomUUID is a global in the Node 20+
  // proxy runtime, no Buffer/btoa dependency).
  const nonce = crypto.randomUUID().replace(/-/g, '')

  const enforce = cspEnforced(process.env.CSP_MODE)
  const embedOrigins = parseOriginList(process.env.EMBED_ORIGINS)
  const imgOrigins = parseOriginList(process.env.CSP_IMG_ORIGINS)
  const isDev = process.env.NODE_ENV === 'development'

  const csp = buildCsp({ nonce, embedOrigins, imgOrigins, isDev })
  const cspHeaderName = enforce ? CSP_ENFORCE_HEADER : CSP_REPORT_ONLY_HEADER

  // Forward the nonce + CSP on the REQUEST so Next stamps it on the scripts
  // it renders (and the layout can thread it to its own inline script). Any
  // inbound CSP/x-nonce headers are deleted first — a spoofed value never
  // survives to the render (app-render reads the nonce from the request's
  // Content-Security-Policy header, so that one must be exactly ours).
  const requestHeaders = new Headers(req.headers)
  requestHeaders.delete(CSP_ENFORCE_HEADER)
  requestHeaders.delete(CSP_REPORT_ONLY_HEADER)
  requestHeaders.delete(NONCE_REQUEST_HEADER)
  requestHeaders.set(NONCE_REQUEST_HEADER, nonce)
  requestHeaders.set(cspHeaderName, csp)

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set(cspHeaderName, csp)

  if (requestProto(req.headers.get('x-forwarded-proto'), req.nextUrl.protocol) === 'https') {
    const hsts = buildHsts(
      parseHstsMaxAge(process.env.HSTS_MAX_AGE),
      hstsIncludeSubdomains(process.env.HSTS_INCLUDE_SUBDOMAINS),
    )
    if (hsts) res.headers.set(HSTS_HEADER, hsts)
  }

  if (xFrameOptionsEnabled(embedOrigins, enforce)) {
    res.headers.set(X_FRAME_OPTIONS_HEADER, 'SAMEORIGIN')
  }

  return res
}
