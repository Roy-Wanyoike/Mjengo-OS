/**
 * BE-6 (issue #76) → SEC-4 (audit wave 2) → issue #156: the webhook posture
 * module — the 503 gate predicate, the WEBHOOK_OPEN_POSTURE opt-in, and the
 * startup warning.
 *
 * /api/ussd and /api/whatsapp are unauthenticated gateway seams whose only
 * authentication upgrade is the optional HMAC secret. Issue #156 makes the
 * open (warn-and-accept) posture an EXPLICIT opt-in outside production;
 * every other secret-unset state fails closed with 503. Pinned here:
 *   · unauthenticatedWebhookWritesRefused — the full posture matrix:
 *     secret set → never refused (any runtime); secret unset + production →
 *     always refused (the opt-in is IGNORED there — SEC-4 unchanged);
 *     secret unset + non-prod + no opt-in → refused (the new fail-closed
 *     default); secret unset + non-prod + WEBHOOK_OPEN_POSTURE=1/true →
 *     NOT refused (the explicit open demo posture); 0/false/blank values
 *     do NOT opt in;
 *   · warnIfWebhookSecretUnsetInProduction — ONE loud console.warn per
 *     route/process in EVERY runtime where unauthenticated writes are
 *     actually being accepted (secret unset + opt-in): production + unset
 *     warns the FAIL-CLOSED state (SEC-4, unchanged wording), non-prod +
 *     opt-in warns the ACTIVE open posture, secret set stays silent, and
 *     non-prod without the opt-in stays silent (fail-closed = safe = quiet).
 *
 * Pure unit over lib/webhook-secret-warning — the once-only Set is exercised
 * directly; the two route modules call the warning at module scope (see
 * their heads) and the gate in POST (see the route tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  unauthenticatedWebhookWritesRefused,
  warnIfWebhookSecretUnsetInProduction,
  webhookOpenPostureOptedIn,
} from '@/backend/lib/webhook-secret-warning'

describe('webhookOpenPostureOptedIn (issue #156)', () => {
  const KEY = 'WEBHOOK_OPEN_POSTURE'
  let prev: string | undefined

  beforeEach(() => {
    prev = process.env[KEY]
    delete process.env[KEY]
  })
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY]
    else process.env[KEY] = prev
  })

  it('unset / blank / 0 / false → NOT opted in (fail-closed default)', () => {
    expect(webhookOpenPostureOptedIn()).toBe(false)
    process.env[KEY] = ''
    expect(webhookOpenPostureOptedIn()).toBe(false)
    process.env[KEY] = '   '
    expect(webhookOpenPostureOptedIn()).toBe(false)
    process.env[KEY] = '0'
    expect(webhookOpenPostureOptedIn()).toBe(false)
    process.env[KEY] = 'false'
    expect(webhookOpenPostureOptedIn()).toBe(false)
  })

  it('1 / true / any other non-empty value → opted in (trimmed, case-insensitive)', () => {
    process.env[KEY] = '1'
    expect(webhookOpenPostureOptedIn()).toBe(true)
    process.env[KEY] = 'true'
    expect(webhookOpenPostureOptedIn()).toBe(true)
    process.env[KEY] = '  yes  '
    expect(webhookOpenPostureOptedIn()).toBe(true)
    process.env[KEY] = 'TRUE'
    expect(webhookOpenPostureOptedIn()).toBe(true)
  })
})

describe('unauthenticatedWebhookWritesRefused — the posture matrix (issue #156)', () => {
  const ENV_KEY = 'USSD_WEBHOOK_SECRET'
  let prevNodeEnv: string | undefined
  let prevSecret: string | undefined
  let prevOptIn: string | undefined

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV
    prevSecret = process.env[ENV_KEY]
    prevOptIn = process.env.WEBHOOK_OPEN_POSTURE
    process.env.NODE_ENV = 'test' // the vitest runtime
    delete process.env[ENV_KEY]
    delete process.env.WEBHOOK_OPEN_POSTURE
  })

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    if (prevSecret === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prevSecret
    if (prevOptIn === undefined) delete process.env.WEBHOOK_OPEN_POSTURE
    else process.env.WEBHOOK_OPEN_POSTURE = prevOptIn
  })

  it('secret SET → never refused, in ANY runtime (the HMAC gate answers)', () => {
    process.env[ENV_KEY] = 'some-hex-secret'
    for (const nodeEnv of ['production', 'test', 'development', undefined]) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = nodeEnv
      expect(unauthenticatedWebhookWritesRefused(ENV_KEY), `NODE_ENV=${String(nodeEnv)}`).toBe(false)
    }
  })

  it('production + secret unset → ALWAYS refused — the opt-in is ignored there (SEC-4 unchanged)', () => {
    process.env.NODE_ENV = 'production'
    expect(unauthenticatedWebhookWritesRefused(ENV_KEY)).toBe(true)
    process.env.WEBHOOK_OPEN_POSTURE = '1' // production must not read it
    expect(unauthenticatedWebhookWritesRefused(ENV_KEY)).toBe(true)
  })

  it('non-production + secret unset + NO opt-in → refused (the new fail-closed default)', () => {
    for (const nodeEnv of ['test', 'development', 'staging', undefined]) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = nodeEnv
      expect(unauthenticatedWebhookWritesRefused(ENV_KEY), `NODE_ENV=${String(nodeEnv)}`).toBe(true)
    }
  })

  it('non-production + secret unset + WEBHOOK_OPEN_POSTURE=1 → NOT refused (explicit open posture)', () => {
    process.env.NODE_ENV = 'test'
    process.env.WEBHOOK_OPEN_POSTURE = '1'
    expect(unauthenticatedWebhookWritesRefused(ENV_KEY)).toBe(false)
    process.env.NODE_ENV = 'development'
    expect(unauthenticatedWebhookWritesRefused(ENV_KEY)).toBe(false)
    // a runtime with NO NODE_ENV at all (a bare `docker run` of the image)
    delete process.env.NODE_ENV
    expect(unauthenticatedWebhookWritesRefused(ENV_KEY)).toBe(false)
  })

  it('non-production + secret unset + opt-in set to 0/false/blank → still refused', () => {
    process.env.NODE_ENV = 'test'
    for (const v of ['', '0', 'false']) {
      process.env.WEBHOOK_OPEN_POSTURE = v
      expect(unauthenticatedWebhookWritesRefused(ENV_KEY), `WEBHOOK_OPEN_POSTURE="${v}"`).toBe(true)
    }
  })
})

describe('warnIfWebhookSecretUnsetInProduction (BE-6 + issue #156)', () => {
  const ENV_KEY = 'USSD_WEBHOOK_SECRET'

  let warn: ReturnType<typeof vi.spyOn>
  let prevNodeEnv: string | undefined
  let prevSecret: string | undefined
  let prevOptIn: string | undefined

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    prevNodeEnv = process.env.NODE_ENV
    prevSecret = process.env[ENV_KEY]
    prevOptIn = process.env.WEBHOOK_OPEN_POSTURE
    process.env.NODE_ENV = 'production'
    delete process.env[ENV_KEY]
    delete process.env.WEBHOOK_OPEN_POSTURE
  })

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    if (prevSecret === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prevSecret
    if (prevOptIn === undefined) delete process.env.WEBHOOK_OPEN_POSTURE
    else process.env.WEBHOOK_OPEN_POSTURE = prevOptIn
    warn.mockRestore()
  })

  it('production + secret unset → ONE loud warning, naming the env key, the 503 fail-closed state and the fix', () => {
    warnIfWebhookSecretUnsetInProduction('api/ussd', ENV_KEY)
    const line = String(warn.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('api/ussd')
    expect(line).toContain('USSD_WEBHOOK_SECRET')
    expect(line).toMatch(/FAILS CLOSED/i)
    expect(line).toMatch(/503/)
    expect(line).toMatch(/PRODUCTION/i)
  })

  it('production + secret unset + opt-in set → STILL the fail-closed warning (production ignores the opt-in)', () => {
    process.env.WEBHOOK_OPEN_POSTURE = '1'
    warnIfWebhookSecretUnsetInProduction('api/ussd-optin', ENV_KEY)
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0] ?? '')
    expect(line).toMatch(/FAILS CLOSED/i)
    expect(line).toMatch(/PRODUCTION/i)
  })

  it('a second call for the same route is SILENT (once per process)', () => {
    warnIfWebhookSecretUnsetInProduction('api/whatsapp-route-x', ENV_KEY)
    warnIfWebhookSecretUnsetInProduction('api/whatsapp-route-x', ENV_KEY)
    warnIfWebhookSecretUnsetInProduction('api/whatsapp-route-x', ENV_KEY)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('different route labels warn independently (one line per route)', () => {
    warnIfWebhookSecretUnsetInProduction('route-a', ENV_KEY)
    warnIfWebhookSecretUnsetInProduction('route-b', ENV_KEY)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('production + secret SET → silent (the HMAC gate is live)', () => {
    process.env[ENV_KEY] = 'some-hex-secret'
    warnIfWebhookSecretUnsetInProduction('api/ussd', ENV_KEY)
    expect(warn).not.toHaveBeenCalled()
  })

  it('non-production + secret unset + NO opt-in → silent (fail-closed is the safe default — nothing is being accepted)', () => {
    process.env.NODE_ENV = 'development'
    warnIfWebhookSecretUnsetInProduction('api/ussd', ENV_KEY)
    expect(warn).not.toHaveBeenCalled()
    process.env.NODE_ENV = 'test'
    warnIfWebhookSecretUnsetInProduction('api/ussd', ENV_KEY)
    expect(warn).not.toHaveBeenCalled()
  })

  it('non-production + secret unset + WEBHOOK_OPEN_POSTURE=1 → ONE loud OPEN-POSTURE warning (writes ARE being accepted)', () => {
    process.env.NODE_ENV = 'test'
    process.env.WEBHOOK_OPEN_POSTURE = '1'
    warnIfWebhookSecretUnsetInProduction('api/ussd-open', ENV_KEY)
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('api/ussd-open')
    expect(line).toContain('USSD_WEBHOOK_SECRET')
    expect(line).toMatch(/OPEN POSTURE/i)
    expect(line).toMatch(/WEBHOOK_OPEN_POSTURE/i)
    expect(line).toMatch(/unauthenticated writes/i)
    // once-only in this runtime too
    warnIfWebhookSecretUnsetInProduction('api/ussd-open', ENV_KEY)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a runtime with NO NODE_ENV at all (bare container) + opt-in → the open-posture warning fires too', () => {
    delete process.env.NODE_ENV
    process.env.WEBHOOK_OPEN_POSTURE = '1'
    warnIfWebhookSecretUnsetInProduction('api/whatsapp-open', ENV_KEY)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toMatch(/OPEN POSTURE/i)
  })

  it('non-production + secret SET + opt-in → silent (the HMAC gate is live; the opt-in is moot)', () => {
    process.env.NODE_ENV = 'test'
    process.env.WEBHOOK_OPEN_POSTURE = '1'
    process.env[ENV_KEY] = 'some-hex-secret'
    warnIfWebhookSecretUnsetInProduction('api/ussd-secret-set', ENV_KEY)
    expect(warn).not.toHaveBeenCalled()
  })
})
