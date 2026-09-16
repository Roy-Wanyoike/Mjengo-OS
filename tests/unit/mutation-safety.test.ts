/**
 * SEC-1 (audit-2) — the default-on mutation safety gate.
 *
 * src/backend/lib/mutation-safety.ts replaces the old opt-in
 * MUTATION_ORIGIN_ALLOWLIST posture (off by default → cross-site mutations
 * passed with the default config, riding the SameSite=None session cookie)
 * with a gate that is ON for every browser-reachable mutating route:
 *   · Origin present        → same-host (scheme-agnostic host[:port]) or
 *                             allowlisted Origin passes, else 403
 *                             'cross-origin mutation blocked';
 *   · else Sec-Fetch-Site   → only 'same-origin' / 'none' pass, else 403;
 *   · else (non-browser)    → bodyless passes; a body (Content-Length > 0 or
 *                             Transfer-Encoding) requires
 *                             Content-Type: application/json, else 415
 *                             'json content-type required'.
 *
 * Pinned here directly (assertMutationSafety / mutationSafetyDenied) AND
 * end-to-end through route-kit's publicRoute pipeline (the wrapper every
 * standard mutating route shares — /api/actions, /api/sync, /api/projects
 * POST, the v1 wallet/payment POSTs, uploads, push, notifications, share).
 */
import { NextRequest, NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assertMutationSafety,
  mutationSafetyDenied,
  MutationSafetyError,
} from '@/backend/lib/mutation-safety'
import { publicRoute } from '@/backend/lib/route-kit'

const URL_ = 'http://localhost:3000/api/test'

function req(
  headers: Record<string, string> = {},
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET' = 'POST',
  url = URL_,
): NextRequest {
  return new NextRequest(url, { method, headers })
}

let savedAllowlist: string | undefined

beforeEach(() => {
  savedAllowlist = process.env.MUTATION_ORIGIN_ALLOWLIST
  delete process.env.MUTATION_ORIGIN_ALLOWLIST
})

afterEach(() => {
  if (savedAllowlist === undefined) delete process.env.MUTATION_ORIGIN_ALLOWLIST
  else process.env.MUTATION_ORIGIN_ALLOWLIST = savedAllowlist
})

// ------------------------------------------------------------ Origin branch

describe('SEC-1: Origin header branch', () => {
  it('same-host Origin is allowed (scheme-agnostic host[:port] compare)', () => {
    expect(mutationSafetyDenied(req({ origin: 'http://localhost:3000' }))).toBeNull()
    expect(mutationSafetyDenied(req({ origin: 'https://localhost:3000' }))).toBeNull()
    // Explicit port on both sides matches; case-insensitive host.
    expect(mutationSafetyDenied(req({ origin: 'http://LOCALHOST:3000' }))).toBeNull()
  })

  it('cross-origin Origin is blocked with 403 cross-origin mutation blocked', () => {
    const denied = mutationSafetyDenied(req({ origin: 'https://evil.example' }))
    expect(denied).not.toBeNull()
    expect(denied!.status).toBe(403)
    expect(denied!.headers.get('content-type')).toBe('application/json')
  })

  it('the x-forwarded-host (first entry) is the request host behind a proxy', () => {
    const fwd = req({
      origin: 'https://app.example.com',
      'x-forwarded-host': 'app.example.com, internal-proxy:3000',
    })
    expect(mutationSafetyDenied(fwd)).toBeNull()
    // The proxy-internal host is NOT what the client addressed — mismatch.
    const internal = req({ origin: 'https://internal-proxy:3000', 'x-forwarded-host': 'app.example.com' })
    expect(mutationSafetyDenied(internal)!.status).toBe(403)
  })

  it('Origin "null" (sandboxed iframe) fails closed unless allowlisted', () => {
    expect(mutationSafetyDenied(req({ origin: 'null' }))!.status).toBe(403)
    process.env.MUTATION_ORIGIN_ALLOWLIST = 'null'
    expect(mutationSafetyDenied(req({ origin: 'null' }))).toBeNull()
  })

  it('MUTATION_ORIGIN_ALLOWLIST admits extra origins (trimmed, case-insensitive)', () => {
    process.env.MUTATION_ORIGIN_ALLOWLIST = ' https://iframe.example.com , HTTPS://Other.Example '
    expect(mutationSafetyDenied(req({ origin: 'https://iframe.example.com' }))).toBeNull()
    expect(mutationSafetyDenied(req({ origin: 'https://other.example' }))).toBeNull()
    // Same-origin still passes with the allowlist set…
    expect(mutationSafetyDenied(req({ origin: 'http://localhost:3000' }))).toBeNull()
    // …and everything else is still refused.
    expect(mutationSafetyDenied(req({ origin: 'https://evil.example' }))!.status).toBe(403)
  })

  it('a garbage Origin header is treated as a mismatch (fail closed)', () => {
    expect(mutationSafetyDenied(req({ origin: 'not a url' }))!.status).toBe(403)
  })
})

// ------------------------------------------------------ Sec-Fetch-Site branch

describe('SEC-1: Sec-Fetch-Site branch (no Origin header)', () => {
  it('same-origin and none pass', () => {
    expect(mutationSafetyDenied(req({ 'sec-fetch-site': 'same-origin' }))).toBeNull()
    expect(mutationSafetyDenied(req({ 'sec-fetch-site': 'none' }))).toBeNull()
  })

  it('cross-site (and same-site, and unknown values) are blocked 403', () => {
    for (const site of ['cross-site', 'same-site', 'weird-future-value']) {
      const denied = mutationSafetyDenied(req({ 'sec-fetch-site': site }))
      expect(denied!.status).toBe(403)
    }
  })
})

// ----------------------------------------------------- content-type branch

describe('SEC-1: non-browser branch (no Origin, no Sec-Fetch-Site)', () => {
  it('bodyless request passes (no Content-Length, no Transfer-Encoding)', () => {
    expect(mutationSafetyDenied(req())).toBeNull()
    expect(mutationSafetyDenied(req({ 'content-length': '0' }))).toBeNull()
  })

  it('body + Content-Type application/json passes (charset parameter tolerated)', () => {
    expect(mutationSafetyDenied(req({ 'content-type': 'application/json', 'content-length': '12' }))).toBeNull()
    expect(
      mutationSafetyDenied(req({ 'content-type': 'application/json; charset=utf-8', 'content-length': '12' })),
    ).toBeNull()
  })

  it('body + text/plain → 415 json content-type required (the CSRF simple-request vector)', async () => {
    const denied = mutationSafetyDenied(req({ 'content-type': 'text/plain;charset=UTF-8', 'content-length': '12' }))
    expect(denied).not.toBeNull()
    expect(denied!.status).toBe(415)
    expect(await denied!.json()).toEqual({ error: 'json content-type required' })
  })

  it('body + form-urlencoded / multipart → 415 (HTML form encodings)', () => {
    expect(
      mutationSafetyDenied(req({ 'content-type': 'application/x-www-form-urlencoded', 'content-length': '12' }))!.status,
    ).toBe(415)
    expect(mutationSafetyDenied(req({ 'content-type': 'multipart/form-data; boundary=x', 'content-length': '12' }))!.status).toBe(415)
  })

  it('body + NO content-type → 415 (json is required, not merely not-form)', () => {
    expect(mutationSafetyDenied(req({ 'content-length': '12' }))!.status).toBe(415)
  })

  it('Transfer-Encoding: chunked counts as a body', () => {
    expect(mutationSafetyDenied(req({ 'transfer-encoding': 'chunked' }))!.status).toBe(415)
    expect(
      mutationSafetyDenied(req({ 'transfer-encoding': 'chunked', 'content-type': 'text/plain' }))!.status,
    ).toBe(415)
  })
})

// ------------------------------------------------------------ method scope

describe('SEC-1: only mutating verbs are gated', () => {
  it('GET passes even with a foreign Origin and a text/plain body declaration', () => {
    expect(
      mutationSafetyDenied(req({ origin: 'https://evil.example', 'content-type': 'text/plain' }, 'GET')),
    ).toBeNull()
  })

  it('PUT / PATCH / DELETE are gated like POST', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect(mutationSafetyDenied(req({ origin: 'https://evil.example' }, method))!.status).toBe(403)
    }
  })
})

// --------------------------------------------------------- throwing variant

describe('SEC-1: assertMutationSafety throws the typed error', () => {
  it('allowed → silent; denied → MutationSafetyError with 403/415', () => {
    expect(() => assertMutationSafety(req({ origin: 'http://localhost:3000' }))).not.toThrow()
    try {
      assertMutationSafety(req({ origin: 'https://evil.example' }))
      expect.unreachable('cross-origin mutation must throw')
    } catch (e) {
      expect(e).toBeInstanceOf(MutationSafetyError)
      expect((e as MutationSafetyError).status).toBe(403)
      expect((e as MutationSafetyError).message).toBe('cross-origin mutation blocked')
    }
    try {
      assertMutationSafety(req({ 'content-type': 'text/plain', 'content-length': '4' }))
      expect.unreachable('text/plain body must throw')
    } catch (e) {
      expect((e as MutationSafetyError).status).toBe(415)
      expect((e as MutationSafetyError).message).toBe('json content-type required')
    }
  })
})

// ------------------------------------------- route-kit pipeline integration

describe('SEC-1: the gate runs inside route-kit (publicRoute pipeline)', () => {
  // The same wrapper /api/actions + /api/share use (session-or-null, then
  // the shared pipeline: mutation safety → rate limit → body → handler).
  const echo = publicRoute({ scope: 'test/echo' }, async () => NextResponse.json({ ok: true }))

  it('cross-origin POST → 403 before the handler runs', async () => {
    const res = await echo(req({ origin: 'https://evil.example' }), undefined)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'cross-origin mutation blocked' })
  })

  it('non-browser POST with a text/plain body → 415', async () => {
    const res = await echo(req({ 'content-type': 'text/plain', 'content-length': '2' }), undefined)
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'json content-type required' })
  })

  it('a proper same-origin/JSON request reaches the handler', async () => {
    const res = await echo(req({ origin: 'http://localhost:3000', 'content-type': 'application/json' }), undefined)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('skipMutationSafety opts a machine route out (the /api/jobs/run contract)', async () => {
    const machine = publicRoute(
      { scope: 'test/machine', skipMutationSafety: true },
      async () => NextResponse.json({ ok: true }),
    )
    // Scheduler-shaped request: no browser headers, text/plain body.
    const res = await machine(req({ 'content-type': 'text/plain', 'content-length': '2' }), undefined)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
