/**
 * BE-6 (issue #76) — the production webhook-posture warning.
 *
 * /api/ussd and /api/whatsapp stay fail-open (documented gateway-trust demo
 * posture) when their optional HMAC secret is unset — the fix makes that
 * posture VISIBLE instead of changing it. Pinned here:
 *   · NODE_ENV=production + secret unset → ONE loud console.warn naming the
 *     route, the env key and the exact remedy — a second call is SILENT
 *     (once per process, so a busy route cannot spam the log);
 *   · NODE_ENV=production + secret SET → silent (the HMAC gate is live);
 *   · development/test + secret unset → silent (the demo posture is the
 *     documented default outside production);
 *   · different route labels warn INDEPENDENTLY (one line per route).
 *
 * Pure unit over lib/webhook-secret-warning — the once-only Set is exercised
 * directly; the two route modules call it at module scope (see their heads).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { warnIfWebhookSecretUnsetInProduction } from '@/backend/lib/webhook-secret-warning'

describe('warnIfWebhookSecretUnsetInProduction (BE-6)', () => {
  const ENV_KEY = 'USSD_WEBHOOK_SECRET'

  let warn: ReturnType<typeof vi.spyOn>
  let prevNodeEnv: string | undefined
  let prevSecret: string | undefined

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    prevNodeEnv = process.env.NODE_ENV
    prevSecret = process.env[ENV_KEY]
    process.env.NODE_ENV = 'production'
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    if (prevSecret === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prevSecret
    warn.mockRestore()
  })

  it('production + secret unset → ONE loud warning, naming the env key and the fix', () => {
    warnIfWebhookSecretUnsetInProduction('api/ussd', ENV_KEY)
    const line = String(warn.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('api/ussd')
    expect(line).toContain('USSD_WEBHOOK_SECRET')
    expect(line).toMatch(/unauthenticated webhook writes/i)
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

  it('development + secret unset → silent (the documented demo posture)', () => {
    process.env.NODE_ENV = 'development'
    warnIfWebhookSecretUnsetInProduction('api/ussd', ENV_KEY)
    expect(warn).not.toHaveBeenCalled()
  })

  it('test env + secret unset → silent', () => {
    process.env.NODE_ENV = 'test'
    warnIfWebhookSecretUnsetInProduction('api/ussd', ENV_KEY)
    expect(warn).not.toHaveBeenCalled()
  })
})
