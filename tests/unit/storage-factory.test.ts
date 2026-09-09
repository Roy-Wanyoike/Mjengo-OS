/**
 * Storage driver factory (task 9-b): the env matrix is THE safety contract —
 * the S3/R2 driver is selected ONLY when the full required env set is
 * present; anything else (unset, blank, whitespace) is the local-disk
 * default. Pins:
 *  · complete env → s3-compat (and S3_PUBLIC_BASE is plumbed through);
 *  · each one-missing permutation → local-disk (fail closed, all five keys);
 *  · blank/whitespace values count as missing;
 *  · partial env warns ONCE with key names only (never values — secrets);
 *  · getStorageDriver() caches; setStorageDriverForTests() is the seam;
 *  · readStorageEnv reads the live process.env subset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getStorageDriver,
  readStorageEnv,
  resetStorageWarnForTests,
  resolveStorageDriver,
  setStorageDriverForTests,
  type StorageEnv,
} from '@/backend/lib/storage'

const FULL_ENV: StorageEnv = {
  S3_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
  S3_REGION: 'eu-central-1',
  S3_BUCKET: 'mjengo-photos',
  S3_ACCESS_KEY_ID: 'AKIATESTKEY',
  S3_SECRET_ACCESS_KEY: 'test-secret-not-real',
}

const ENV_KEYS = Object.keys(FULL_ENV) as Array<keyof StorageEnv>

beforeEach(() => {
  setStorageDriverForTests(null) // reset the cache: re-resolve each time
  resetStorageWarnForTests() // re-arm the one-time partial-env warn
})

afterEach(() => {
  setStorageDriverForTests(null)
  vi.restoreAllMocks()
})

describe('resolveStorageDriver — the env matrix, fail closed', () => {
  it('complete env → the s3-compat driver', () => {
    const d = resolveStorageDriver({ ...FULL_ENV })
    expect(d.id).toBe('s3-compat')
    expect(d.canPresign).toBe(true)
  })

  it('S3_PUBLIC_BASE is plumbed: publicUrl uses the stable CDN base', () => {
    const d = resolveStorageDriver({ ...FULL_ENV, S3_PUBLIC_BASE: 'https://cdn.example.com/' })
    expect(d.publicUrl('upp-1-abcdef.jpg')).toBe('https://cdn.example.com/mjengo-photos/upp-1-abcdef.jpg')
  })

  it('every one-missing permutation → local-disk (five keys, one at a time)', () => {
    for (const missing of ENV_KEYS) {
      const env = { ...FULL_ENV } as Record<string, string | undefined>
      delete env[missing]
      const d = resolveStorageDriver(env as StorageEnv)
      expect(d.id).toBe('local-disk') // `missing` was ${missing} — fail closed
      expect(d.canPresign).toBe(false)
      expect(d.publicUrl('k.png')).toBe('/photos/k.png')
    }
  })

  it('blank / whitespace-only values count as missing', () => {
    for (const blank of ['', '   ', '\t']) {
      const env = { ...FULL_ENV, S3_SECRET_ACCESS_KEY: blank }
      expect(resolveStorageDriver(env).id).toBe('local-disk')
    }
  })

  it('everything unset → local-disk silently (the honest self-host default, no warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveStorageDriver({}).id).toBe('local-disk')
    expect(warn).not.toHaveBeenCalled()
  })

  it('S3_PUBLIC_BASE alone (no required keys) is still local-disk — a base without a bucket is nothing', () => {
    expect(resolveStorageDriver({ S3_PUBLIC_BASE: 'https://cdn.example.com' }).id).toBe('local-disk')
  })

  it('partial env warns ONCE with key NAMES only — values are secrets and never logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = { ...FULL_ENV, S3_BUCKET: '', S3_SECRET_ACCESS_KEY: '' }
    resolveStorageDriver(env)
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = warn.mock.calls[0].join(' ')
    // the MISSING list names exactly the two absent keys (S3_REGION is
    // present, so it appears only in the "Set all of…" hint, not as missing)
    expect(msg).toContain('missing S3_BUCKET, S3_SECRET_ACCESS_KEY')
    expect(msg).toContain('Set all of S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY')
    expect(msg).toContain('local-disk')
    // once-per-process: a second partial resolve does not re-warn
    resolveStorageDriver(env)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('full env with an invalid endpoint throws honestly at resolution (never silently degrades)', () => {
    expect(() => resolveStorageDriver({ ...FULL_ENV, S3_ENDPOINT: 'not-a-url' })).toThrow(
      /S3 endpoint is not a valid URL/,
    )
  })

  it('the secret is used verbatim (not trimmed) — a signature either matches or fails, never almost', () => {
    // trailing-space secret would be corrupted by trimming; assert the
    // driver was built (resolution OK) with the raw value via presign URL
    const d = resolveStorageDriver({ ...FULL_ENV, S3_SECRET_ACCESS_KEY: 'secret ' })
    const url = d.presignGet!('k.png', 60)
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/)
  })
})

describe('getStorageDriver — cached, with the test seam', () => {
  it('caches the first resolution (the env is read once per process)', async () => {
    process.env.S3_ENDPOINT = FULL_ENV.S3_ENDPOINT
    process.env.S3_REGION = FULL_ENV.S3_REGION
    process.env.S3_BUCKET = FULL_ENV.S3_BUCKET
    process.env.S3_ACCESS_KEY_ID = FULL_ENV.S3_ACCESS_KEY_ID
    process.env.S3_SECRET_ACCESS_KEY = FULL_ENV.S3_SECRET_ACCESS_KEY
    delete process.env.S3_PUBLIC_BASE
    try {
      const first = getStorageDriver()
      expect(first.id).toBe('s3-compat')
      // change the env after the fact — the cached driver is unaffected
      delete process.env.S3_BUCKET
      expect(getStorageDriver()).toBe(first)
    } finally {
      for (const k of ENV_KEYS) delete process.env[k]
      setStorageDriverForTests(null)
    }
  })

  it('setStorageDriverForTests forces the driver (and null re-resolves)', () => {
    const local = getStorageDriver()
    expect(local.id).toBe('local-disk') // env was scrubbed above
    const forced = resolveStorageDriver({ ...FULL_ENV })
    setStorageDriverForTests(forced)
    expect(getStorageDriver()).toBe(forced)
    setStorageDriverForTests(null)
    expect(getStorageDriver()).not.toBe(forced)
  })

  it('readStorageEnv maps the live process.env subset', () => {
    process.env.S3_BUCKET = 'live-bucket'
    delete process.env.S3_ENDPOINT
    try {
      expect(readStorageEnv()).toEqual({
        S3_ENDPOINT: undefined,
        S3_REGION: undefined,
        S3_BUCKET: 'live-bucket',
        S3_ACCESS_KEY_ID: undefined,
        S3_SECRET_ACCESS_KEY: undefined,
        S3_PUBLIC_BASE: undefined,
      })
      // explicit override wins (the injection path tests use)
      expect(readStorageEnv({ S3_BUCKET: 'injected' }).S3_BUCKET).toBe('injected')
    } finally {
      delete process.env.S3_BUCKET
    }
  })
})
