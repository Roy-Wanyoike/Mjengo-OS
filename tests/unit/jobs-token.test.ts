/**
 * Invariants of the POST /api/jobs/run machine-credential path
 * (src/backend/lib/jobs-token.ts — the JOBS_RUN_TOKEN bearer check).
 *
 * The auth decision is pinned as a PURE function (Authorization header
 * value + configured env token → verdict), so no request object or
 * process.env seeding is needed:
 *  · a matching token authenticates;
 *  · a mismatched token, a missing header, a non-bearer scheme, or an
 *    unset/empty configured token NEVER authenticates — fail closed,
 *    there is no default token (unsetting JOBS_RUN_TOKEN on the server
 *    disables the bearer path entirely);
 *  · the crypto.timingSafeEqual comparison never throws, including on
 *    length-mismatched secrets (lengths are guarded before the call).
 */
import { describe, expect, it } from 'vitest'

import {
  bearerTokenFromAuthorization,
  jobsBearerTokenMatches,
  secretsMatch,
} from '@/backend/lib/jobs-token'

// Same shape as `openssl rand -hex 32` output: 64 hex characters.
const TOKEN = 'f'.repeat(64)
const OTHER_TOKEN = '0'.repeat(64)

describe('bearerTokenFromAuthorization', () => {
  it('extracts the token from "Bearer <token>"', () => {
    expect(bearerTokenFromAuthorization(`Bearer ${TOKEN}`)).toBe(TOKEN)
  })

  it('accepts a case-insensitive scheme (RFC 7235)', () => {
    expect(bearerTokenFromAuthorization(`bearer ${TOKEN}`)).toBe(TOKEN)
    expect(bearerTokenFromAuthorization(`BEARER ${TOKEN}`)).toBe(TOKEN)
  })

  it('tolerates extra separator/outer whitespace', () => {
    expect(bearerTokenFromAuthorization('Bearer \t  ' + TOKEN)).toBe(TOKEN)
    expect(bearerTokenFromAuthorization(`  Bearer   ${TOKEN}  `)).toBe(TOKEN)
  })

  it('yields null for non-bearer schemes and malformed values', () => {
    expect(bearerTokenFromAuthorization(`Basic ${TOKEN}`)).toBeNull()
    expect(bearerTokenFromAuthorization('Bearer')).toBeNull()
    expect(bearerTokenFromAuthorization('Bearer ')).toBeNull()
    expect(bearerTokenFromAuthorization(TOKEN)).toBeNull() // no scheme at all
  })

  it('yields null for absent header values', () => {
    expect(bearerTokenFromAuthorization(null)).toBeNull()
    expect(bearerTokenFromAuthorization(undefined)).toBeNull()
    expect(bearerTokenFromAuthorization('')).toBeNull()
  })
})

describe('secretsMatch (constant-time core)', () => {
  it('true only for byte-identical secrets', () => {
    expect(secretsMatch(TOKEN, TOKEN)).toBe(true)
    expect(secretsMatch(OTHER_TOKEN, OTHER_TOKEN)).toBe(true)
  })

  it('false for same-length different-content secrets', () => {
    expect(secretsMatch(OTHER_TOKEN, TOKEN)).toBe(false)
  })

  it('false (never throws) on length mismatch — timingSafeEqual guards it', () => {
    // crypto.timingSafeEqual throws on unequal buffer lengths; the guard
    // must turn that into a plain false.
    expect(() => secretsMatch(TOKEN.slice(0, 32), TOKEN)).not.toThrow()
    expect(secretsMatch(TOKEN.slice(0, 32), TOKEN)).toBe(false)
    expect(secretsMatch(TOKEN, TOKEN.slice(0, 32))).toBe(false)
    expect(secretsMatch(TOKEN + TOKEN, TOKEN)).toBe(false)
  })

  it('an empty secret is never a match (fail closed)', () => {
    expect(secretsMatch('', '')).toBe(false)
    expect(secretsMatch('', TOKEN)).toBe(false)
  })
})

describe('jobsBearerTokenMatches (the route-level verdict)', () => {
  it('a matching token authenticates', () => {
    expect(jobsBearerTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(jobsBearerTokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true)
  })

  it('a mismatched token is rejected', () => {
    expect(jobsBearerTokenMatches(`Bearer ${OTHER_TOKEN}`, TOKEN)).toBe(false)
  })

  it('a missing Authorization header is rejected', () => {
    expect(jobsBearerTokenMatches(null, TOKEN)).toBe(false)
    expect(jobsBearerTokenMatches(undefined, TOKEN)).toBe(false)
  })

  it('unset env disables the bearer path entirely (fail closed, no default token)', () => {
    expect(jobsBearerTokenMatches(`Bearer ${TOKEN}`, undefined)).toBe(false)
    // even a would-be default/empty token must not authenticate anything
    expect(jobsBearerTokenMatches(`Bearer ${TOKEN}`, '')).toBe(false)
    expect(jobsBearerTokenMatches('', '')).toBe(false)
  })

  it('a non-bearer credential is not a jobs token', () => {
    expect(jobsBearerTokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false)
    expect(jobsBearerTokenMatches(TOKEN, TOKEN)).toBe(false)
  })

  it('a malformed header ("Bearer" with no token) is treated as not presented', () => {
    expect(jobsBearerTokenMatches('Bearer', TOKEN)).toBe(false)
    expect(jobsBearerTokenMatches('Bearer   ', TOKEN)).toBe(false)
  })

  it('a presented prefix of the secret neither matches nor throws', () => {
    const half = TOKEN.slice(0, 32)
    expect(() => jobsBearerTokenMatches(`Bearer ${half}`, TOKEN)).not.toThrow()
    expect(jobsBearerTokenMatches(`Bearer ${half}`, TOKEN)).toBe(false)
  })
})
