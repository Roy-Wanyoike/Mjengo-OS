/**
 * Security response headers — issue #178 / audit SEC-11 (SEC-11 RESOLVED here).
 *
 * The header set is pinned at BOTH seams that produce it:
 *   · the STATIC half — next.config.ts headers(): X-Content-Type-Options,
 *     Referrer-Policy, Permissions-Policy — applied by Next's header layer to
 *     every response (including the paths the proxy skips);
 *   · the DYNAMIC half — src/proxy.ts (backed by the pure builders in
 *     src/backend/lib/security-headers.ts): the nonce Content-Security-Policy
 *     (report-only by default, the issue's rollout), Strict-Transport-Security
 *     on https requests only, the frame-ancestors allowlist and the
 *     doesn't-fight-frame-ancestors X-Frame-Options.
 *
 * The proxy tests call the REAL proxy (Next 16's renamed middleware — the
 * middleware.ts convention logs a deprecation warning, so the new file ships
 * as proxy.ts) with real NextRequests — the same execution path a request to /
 * or /api/health takes through the edge layer — and pin the response headers
 * plus the request-header forwarding (x-nonce + the CSP header Next reads the
 * nonce from: server/app-render's getScriptNonceFromHeader). Pure-builder
 * tables cover env parsing exactly the way mutation-safety.test.ts covers
 * MUTATION_ORIGIN_ALLOWLIST's model.
 *
 * A layout SOURCE pin (readFileSync, the sw-offline-shell idiom) guards the
 * nonce threading into the one hand-written inline script — the piece the app
 * must do itself because Next only nonces the scripts IT renders.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import nextConfig from '../../next.config'
import { config as proxyConfig, proxy } from '@/proxy'
import {
  DEFAULT_HSTS_MAX_AGE,
  buildCsp,
  buildHsts,
  cspEnforced,
  frameAncestorsValue,
  hstsIncludeSubdomains,
  parseHstsMaxAge,
  parseOriginList,
  requestProto,
  xFrameOptionsEnabled,
} from '@/backend/lib/security-headers'

const LAYOUT_SRC = readFileSync(fileURLToPath(new URL('../../src/app/layout.tsx', import.meta.url)), 'utf8')

const EXPECTED_PERMISSIONS_POLICY =
  'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), nfc=(), idle-detection=()'

/** CSP string → directive map ('default-src' → its sources). */
function cspDirectives(csp: string): Map<string, string> {
  return new Map(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(' ')
        return i === -1 ? ([d, ''] as const) : ([d.slice(0, i), d.slice(i + 1)] as const)
      }),
  )
}

function req(url: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, { method: 'GET', headers })
}

const CSP_ENV_KEYS = [
  'CSP_MODE',
  'EMBED_ORIGINS',
  'CSP_IMG_ORIGINS',
  'HSTS_MAX_AGE',
  'HSTS_INCLUDE_SUBDOMAINS',
] as const

let savedNodeEnv: string | undefined
const savedEnv: Array<[string, string | undefined]> = []

beforeEach(() => {
  for (const key of CSP_ENV_KEYS) {
    savedEnv.push([key, process.env[key]])
    delete process.env[key]
  }
  savedNodeEnv = process.env.NODE_ENV
})

afterEach(() => {
  for (const [key, value] of savedEnv.splice(0)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedNodeEnv
})

// ------------------------------------------------- next.config.ts (static set)

describe('next.config.ts headers() — the static half (issue #178)', () => {
  it("sends X-Content-Type-Options, Referrer-Policy and Permissions-Policy on '/(.*)' — exact values", async () => {
    const rules = await nextConfig.headers()
    expect(rules).toHaveLength(1)
    expect(rules[0].source).toBe('/(.*)')
    expect(rules[0].headers).toEqual([
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: EXPECTED_PERMISSIONS_POLICY },
    ])
  })

  it('Permissions-Policy: camera/mic enabled for (self) only; every listed feature is explicit (no browser default left standing)', () => {
    const features = new Map(
      EXPECTED_PERMISSIONS_POLICY.split(', ').map((entry) => {
        const i = entry.indexOf('=')
        return [entry.slice(0, i), entry.slice(i + 1)] as [string, string]
      }),
    )
    // Used by the app (evidence capture; voice-notes copilot getUserMedia) —
    // enabled for this origin ONLY, never *.
    expect(features.get('camera')).toBe('(self)')
    expect(features.get('microphone')).toBe('(self)')
    // Everything sensitive the app never uses: denied outright.
    for (const denied of ['geolocation', 'payment', 'usb', 'bluetooth', 'serial', 'nfc', 'idle-detection']) {
      expect(features.get(denied)).toBe('()')
    }
  })
})

// --------------------------------------- pure builders (security-headers.ts)

describe('parseOriginList — MUTATION_ORIGIN_ALLOWLIST model, fail closed', () => {
  it('comma-separated absolute origins: trimmed, lowercased, deduped', () => {
    expect(parseOriginList(' https://Preview.Example.COM , http://10.0.0.5:3000,https://preview.example.com ')).toEqual([
      'https://preview.example.com',
      'http://10.0.0.5:3000',
    ])
  })

  it('bare hosts, paths, null and non-http schemes are dropped, never guessed into origins', () => {
    expect(parseOriginList('preview.example.com, /path, null, ftp://x.example, :, ,,')).toEqual([])
    expect(parseOriginList(undefined)).toEqual([])
    expect(parseOriginList('')).toEqual([])
  })
})

describe('cspEnforced — the strict opt-in (CSP_MODE)', () => {
  it('only the literal "enforce" turns enforcement on', () => {
    expect(cspEnforced('enforce')).toBe(true)
    expect(cspEnforced(' ENFORCE ')).toBe(true)
    expect(cspEnforced(undefined)).toBe(false)
    expect(cspEnforced('')).toBe(false)
    expect(cspEnforced('report-only')).toBe(false)
    expect(cspEnforced('enforced')).toBe(false)
    expect(cspEnforced('on')).toBe(false)
    expect(cspEnforced('1')).toBe(false)
    expect(cspEnforced('true')).toBe(false)
  })
})

describe('frameAncestorsValue / xFrameOptionsEnabled — the framing decision', () => {
  it("frame-ancestors is 'self' plus the operator-declared embedders, in order", () => {
    expect(frameAncestorsValue([])).toBe("'self'")
    expect(frameAncestorsValue(['https://preview.example.com'])).toBe("'self' https://preview.example.com")
    expect(frameAncestorsValue(['https://a.example', 'https://b.example'])).toBe("'self' https://a.example https://b.example")
  })

  it('X-Frame-Options only where it cannot fight frame-ancestors: enforce mode AND no cross-site embedders', () => {
    expect(xFrameOptionsEnabled([], true)).toBe(true)
    // An enforced XFO has no allowlist mechanism — it would block exactly the
    // embeds frame-ancestors exists to permit:
    expect(xFrameOptionsEnabled(['https://preview.example.com'], true)).toBe(false)
    // Report-only rollout must be observationally non-breaking — an enforced
    // XFO would be the only active frame restriction and would block the
    // legit preview embed out of the gate:
    expect(xFrameOptionsEnabled([], false)).toBe(false)
    expect(xFrameOptionsEnabled(['https://preview.example.com'], false)).toBe(false)
  })
})

describe('buildCsp — the exact policy', () => {
  const NONCE = 'f'.repeat(32)

  it('production, no embedders: exact value (every directive pinned)', () => {
    expect(buildCsp({ nonce: NONCE, embedOrigins: [], imgOrigins: [], isDev: false })).toBe(
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-src 'self'",
        "frame-ancestors 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "form-action 'self'",
      ].join('; '),
    )
  })

  it('the directive set is explicit — removing or renaming a directive fails this pin', () => {
    const csp = buildCsp({ nonce: NONCE, embedOrigins: [], imgOrigins: [], isDev: false })
    expect([...cspDirectives(csp).keys()]).toEqual([
      'default-src',
      'base-uri',
      'object-src',
      'frame-src',
      'frame-ancestors',
      'script-src',
      'style-src',
      'img-src',
      'media-src',
      'font-src',
      'connect-src',
      'worker-src',
      'manifest-src',
      'form-action',
    ])
  })

  it("dev only: script-src gains 'unsafe-eval' (React Refresh) and connect-src gains ws:/wss: (Turbopack HMR)", () => {
    const dev = cspDirectives(buildCsp({ nonce: NONCE, embedOrigins: [], imgOrigins: [], isDev: true }))
    expect(dev.get('script-src')).toBe(`'self' 'nonce-${NONCE}' 'strict-dynamic' 'unsafe-eval'`)
    expect(dev.get('connect-src')).toBe("'self' data: blob: ws: wss:")

    const prod = cspDirectives(buildCsp({ nonce: NONCE, embedOrigins: [], imgOrigins: [], isDev: false }))
    expect(prod.get('script-src')).not.toContain('unsafe-eval')
    expect(prod.get('connect-src')).not.toContain('ws:')
  })

  it('EMBED_ORIGINS feed frame-ancestors; CSP_IMG_ORIGINS feed img-src (S3/CDN deployments)', () => {
    const csp = buildCsp({
      nonce: NONCE,
      embedOrigins: ['https://preview.example.com'],
      imgOrigins: ['https://cdn.example.com', 'https://bucket.r2.cloudflarestorage.com'],
      isDev: false,
    })
    const directives = cspDirectives(csp)
    expect(directives.get('frame-ancestors')).toBe("'self' https://preview.example.com")
    expect(directives.get('img-src')).toBe("'self' data: blob: https://cdn.example.com https://bucket.r2.cloudflarestorage.com")
  })
})

describe('buildHsts / parseHstsMaxAge / hstsIncludeSubdomains', () => {
  it('default: one year, no includeSubDomains (shared gateway hosts must not be poisoned)', () => {
    expect(buildHsts(DEFAULT_HSTS_MAX_AGE, false)).toBe('max-age=31536000')
    expect(buildHsts(86400, true)).toBe('max-age=86400; includeSubDomains')
  })

  it('max-age 0 (and only a real 0) disables the header — null, never max-age=0', () => {
    expect(buildHsts(0, false)).toBeNull()
    expect(buildHsts(0, true)).toBeNull()
    expect(parseHstsMaxAge('0')).toBe(0)
  })

  it('invalid/unset HSTS_MAX_AGE falls back to the default — a typo must not silently disable HSTS', () => {
    expect(parseHstsMaxAge(undefined)).toBe(DEFAULT_HSTS_MAX_AGE)
    expect(parseHstsMaxAge('')).toBe(DEFAULT_HSTS_MAX_AGE)
    expect(parseHstsMaxAge('abc')).toBe(DEFAULT_HSTS_MAX_AGE)
    expect(parseHstsMaxAge('-5')).toBe(DEFAULT_HSTS_MAX_AGE)
    expect(parseHstsMaxAge('60')).toBe(60)
  })

  it('HSTS_INCLUDE_SUBDOMAINS is 1/true only (strict opt-in, the HEALTH_PUBLIC_DETAIL discipline)', () => {
    expect(hstsIncludeSubdomains('1')).toBe(true)
    expect(hstsIncludeSubdomains('true')).toBe(true)
    expect(hstsIncludeSubdomains('TRUE')).toBe(true)
    expect(hstsIncludeSubdomains(undefined)).toBe(false)
    expect(hstsIncludeSubdomains('')).toBe(false)
    expect(hstsIncludeSubdomains('yes')).toBe(false)
    expect(hstsIncludeSubdomains('on')).toBe(false)
  })
})

describe('requestProto — https detection (the gateway path)', () => {
  it("first x-forwarded-proto entry wins, else the URL's own protocol", () => {
    expect(requestProto('https', 'http:')).toBe('https')
    expect(requestProto('https, http', 'http:')).toBe('https')
    expect(requestProto('http', 'https:')).toBe('http')
    expect(requestProto(null, 'https:')).toBe('https')
    expect(requestProto(null, 'http:')).toBe('http')
    expect(requestProto('', 'http:')).toBe('http')
    expect(requestProto('garbage', 'http:')).toBe('http')
  })
})

// ------------------------------------------------ src/proxy.ts (the wiring)

describe('proxy — the dynamic half on a real request', () => {
  it('DEFAULT env + https: CSP-Report-Only (not enforce), HSTS one year, NO X-Frame-Options (report-first rollout)', async () => {
    const res = await proxy(req('https://app.example.com/'))
    expect(res.headers.get('content-security-policy-report-only')).toMatch(/^default-src 'self';/)
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000')
    // Report-only posture must be observationally non-breaking:
    expect(res.headers.get('x-frame-options')).toBeNull()
  })

  it('plain http (local dev): CSP still served, HSTS absent (browsers ignore STS over http anyway — we just never send it)', async () => {
    const res = await proxy(req('http://127.0.0.1:3000/'))
    expect(res.headers.get('content-security-policy-report-only')).toMatch(/^default-src 'self';/)
    expect(res.headers.get('strict-transport-security')).toBeNull()
  })

  it('x-forwarded-proto: https (the preview-gateway path): HSTS present on an http-terminated request', async () => {
    const res = await proxy(req('http://127.0.0.1:3000/', { 'x-forwarded-proto': 'https' }))
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000')
  })

  it('CSP_MODE=enforce: enforcing header, frame-ancestors self, X-Frame-Options SAMEORIGIN (agrees with it), on /', async () => {
    process.env.CSP_MODE = 'enforce'
    const res = await proxy(req('http://127.0.0.1:3000/'))
    const csp = res.headers.get('content-security-policy')
    expect(csp).toMatch(/^default-src 'self';/)
    expect(res.headers.get('content-security-policy-report-only')).toBeNull()
    expect(cspDirectives(csp!).get('frame-ancestors')).toBe("'self'")
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  it('CSP_MODE=enforce + EMBED_ORIGINS: the legit embedder is allowed; X-Frame-Options omitted (it would block it)', async () => {
    process.env.CSP_MODE = 'enforce'
    process.env.EMBED_ORIGINS = ' https://Preview.Example.Com , garbage '
    const res = await proxy(req('http://127.0.0.1:3000/'))
    const csp = res.headers.get('content-security-policy')!
    expect(cspDirectives(csp).get('frame-ancestors')).toBe("'self' https://preview.example.com")
    expect(res.headers.get('x-frame-options')).toBeNull()
  })

  it('CSP_IMG_ORIGINS (S3/R2/CDN deployments) extend img-src on the served CSP', async () => {
    process.env.CSP_IMG_ORIGINS = 'https://cdn.example.com'
    const res = await proxy(req('http://127.0.0.1:3000/'))
    expect(cspDirectives(res.headers.get('content-security-policy-report-only')!).get('img-src')).toBe(
      "'self' data: blob: https://cdn.example.com",
    )
  })

  it('NODE_ENV=development: the dev relaxations reach the served header (and production never sees them)', async () => {
    process.env.NODE_ENV = 'development'
    const dev = cspDirectives((await proxy(req('http://127.0.0.1:3000/'))).headers.get('content-security-policy-report-only')!)
    expect(dev.get('script-src')).toMatch(/'unsafe-eval'$/)
    expect(dev.get('connect-src')).toBe("'self' data: blob: ws: wss:")

    process.env.NODE_ENV = 'production'
    const prod = cspDirectives((await proxy(req('http://127.0.0.1:3000/'))).headers.get('content-security-policy-report-only')!)
    expect(prod.get('script-src')).not.toContain('unsafe-eval')
    expect(prod.get('connect-src')).toBe("'self' data: blob:")
  })

  it('HSTS knobs: HSTS_MAX_AGE=0 disables even on https; a custom age + includeSubDomains opt-in composes', async () => {
    process.env.HSTS_MAX_AGE = '0'
    expect((await proxy(req('https://app.example.com/'))).headers.get('strict-transport-security')).toBeNull()

    process.env.HSTS_MAX_AGE = '60'
    process.env.HSTS_INCLUDE_SUBDOMAINS = '1'
    expect((await proxy(req('https://app.example.com/'))).headers.get('strict-transport-security')).toBe(
      'max-age=60; includeSubDomains',
    )
  })
})

describe('proxy — nonce generation + forwarding (what Next stamps its scripts with)', () => {
  it('the response CSP, the forwarded x-nonce and the forwarded request CSP all carry the SAME per-request nonce', async () => {
    const res = await proxy(req('http://127.0.0.1:3000/'))
    const csp = res.headers.get('content-security-policy-report-only')!
    const nonce = cspDirectives(csp).get('script-src')!.match(/'nonce-([0-9a-f]+)'/)![1]
    expect(nonce).toMatch(/^[0-9a-f]{32}$/) // 122 bits, hex — a valid CSP base64-value token

    // The request-header forwarding NextResponse.next({ request: { headers } })
    // performs (Next reads the nonce from the REQUEST's CSP header —
    // app-render's getScriptNonceFromHeader — and the layout from x-nonce):
    const forwarded = res.headers.get('x-middleware-request-x-nonce')
    expect(forwarded).toBe(nonce)
    expect(res.headers.get('x-middleware-request-content-security-policy-report-only')).toBe(csp)
    expect(res.headers.get('x-middleware-override-headers')).toContain('x-nonce')
  })

  it('two requests never share a nonce (per-request, unguessable)', async () => {
    const nonceOf = async (): Promise<string> =>
      cspDirectives((await proxy(req('http://127.0.0.1:3000/'))).headers.get('content-security-policy-report-only')!)
        .get('script-src')!
        .match(/'nonce-([0-9a-f]+)'/)![1]
    expect(await nonceOf()).not.toBe(await nonceOf())
  })

  it('an inbound spoofed x-nonce / CSP header never survives to the render (overwritten unconditionally)', async () => {
    const res = await proxy(
      req('http://127.0.0.1:3000/', {
        'x-nonce': 'spoofed',
        'content-security-policy': "default-src 'self'",
      }),
    )
    const forwarded = res.headers.get('x-middleware-request-x-nonce')!
    expect(forwarded).not.toBe('spoofed')
    expect(forwarded).toMatch(/^[0-9a-f]{32}$/)
    // The spoofed ENFORCE header must not leak into the forwarded set either —
    // only the middleware's own report-only CSP is forwarded:
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBeNull()
  })
})

describe('proxy config — the matcher skips', () => {
  it('excludes _next/static, the /website proxy and the offline shell (documented, deliberate)', () => {
    expect(proxyConfig.matcher).toHaveLength(1)
    const pattern = proxyConfig.matcher[0]
    expect(pattern).toContain('_next/static')
    expect(pattern).toContain('website')
    expect(pattern).toContain('offline\\.html')
    // ...while still matching the app surface (the matcher's leading '/' is
    // the literal path anchor — reproduce it with '^'):
    const pathRegex = new RegExp(`^${pattern}`)
    expect(pathRegex.test('/')).toBe(true)
    expect(pathRegex.test('/api/health')).toBe(true)
    expect(pathRegex.test('/_next/static/chunk.js')).toBe(false)
    expect(pathRegex.test('/website/platform')).toBe(false)
    expect(pathRegex.test('/offline.html')).toBe(false)
  })
})

// ------------------------------------------------- layout nonce threading

describe('root layout — the nonce reaches the one hand-written inline script', () => {
  it('reads x-nonce from the request headers and passes it to the pre-hydration lang-sync script (source pin)', () => {
    expect(LAYOUT_SRC).toContain('headers()).get("x-nonce")')
    expect(LAYOUT_SRC).toMatch(/<script\s+nonce=\{nonce\}/)
  })
})
