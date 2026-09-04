/**
 * S3-compat driver (task 9-b): URL shapes and wire behavior with a stubbed
 * fetch. Pins:
 *  · publicUrl — CDN base when configured (trailing slash trimmed), else a
 *    presigned GET with the SigV4 7-day maximum and host-only signed headers;
 *  · presignPut/presignGet — deterministic under the injected clock, method-
 *    bound URL shapes, the advisory Content-Type header contract;
 *  · put() — mints + consumes a presigned PUT itself (the ONE signing code
 *    path), sends the exact bytes and Content-Type, throws single-line
 *    secret-free errors on failure (no signature in the message);
 *  · statObject() — 200 → size/content-type, 404 → exists:false (never a
 *    throw), other statuses → honest error;
 *  · construction fails closed on an unusable endpoint/bucket/credentials.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_GET_PRESIGN_EXPIRES_SEC, createS3CompatDriver } from '@/backend/lib/storage/s3-compat'
import { asPresignCapable } from '@/backend/lib/storage/types'
import type { StorageAdapter } from '@/backend/lib/storage/types'

const CONFIG = {
  endpoint: 'https://mjengo.test.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'mjengo-photos',
  accessKeyId: 'AKIATESTKEY',
  secretAccessKey: 'test-secret-not-real',
  now: () => new Date('2026-03-09T12:00:00Z'),
} as const

const fetchMock = vi.fn()

function driver(overrides: Record<string, unknown> = {}): StorageAdapter {
  return createS3CompatDriver({ ...CONFIG, ...overrides, fetchImpl: fetchMock as unknown as typeof fetch })
}

const PATH = '/mjengo-photos/upp-1712345678-abcd12.jpg'
const ORIGIN = 'https://mjengo.test.r2.cloudflarestorage.com'

beforeEach(() => {
  fetchMock.mockReset()
})

describe('publicUrl', () => {
  it('uses S3_PUBLIC_BASE when configured (CDN/bucket front) — stable forever', () => {
    const d = driver({ publicBase: 'https://cdn.example.com' })
    expect(d.publicUrl('upp-1712345678-abcd12.jpg')).toBe(`https://cdn.example.com${PATH}`)
  })

  it('trims trailing slashes off the base', () => {
    const d = driver({ publicBase: 'https://cdn.example.com///' })
    expect(d.publicUrl('upp-1712345678-abcd12.jpg')).toBe(`https://cdn.example.com${PATH}`)
  })

  it('single-encodes the key in the public path', () => {
    const d = driver({ publicBase: 'https://cdn.example.com' })
    expect(d.publicUrl('photos/my file.jpg')).toBe('https://cdn.example.com/mjengo-photos/photos/my%20file.jpg')
  })

  it('without a base: a presigned GET with the SigV4 7-day maximum', () => {
    const d = driver()
    const url = d.publicUrl('upp-1712345678-abcd12.jpg')
    expect(url.startsWith(`${ORIGIN}${PATH}?`)).toBe(true)
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256')
    expect(url).toContain('X-Amz-Expires=604800')
    expect(url).toContain('X-Amz-SignedHeaders=host')
    expect(url).toContain('X-Amz-Credential=AKIATESTKEY%2F20260309%2Fauto%2Fs3%2Faws4_request')
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/)
    expect(DEFAULT_GET_PRESIGN_EXPIRES_SEC).toBe(604_800)
  })

  it('deterministic under the injected clock (same now → same URL)', () => {
    expect(driver().publicUrl('k.png')).toBe(driver().publicUrl('k.png'))
  })
})

describe('presignPut / presignGet capabilities', () => {
  it('presignPut returns a signed PUT URL + the advisory Content-Type header', () => {
    const d = driver()
    const p = d.presignPut!('upp-1712345678-abcd12.jpg', 'image/png', 300)
    expect(p.url.startsWith(`${ORIGIN}${PATH}?`)).toBe(true)
    expect(p.url).toContain('X-Amz-Expires=300')
    expect(p.url).toContain('X-Amz-SignedHeaders=host')
    expect(p.headers).toEqual({ 'Content-Type': 'image/png' })
    // The Content-Type is NOT in the signature (host-only) — the advisory
    // contract documented in types.ts:
    expect(p.url.toLowerCase()).not.toContain('content-type')
  })

  it('presignGet honors a custom expiry', () => {
    const d = driver()
    expect(d.presignGet!('upp-1712345678-abcd12.jpg', 900)).toContain('X-Amz-Expires=900')
  })

  it('presignGet ≠ presignPut for the same key (method-bound signatures)', () => {
    const d = driver()
    expect(d.presignGet!('x.png', 300)).not.toBe(d.presignPut!('x.png', 'image/png', 300).url)
  })

  it('asPresignCapable narrows this driver (canPresign true + methods present)', () => {
    const capped = asPresignCapable(driver())
    expect(capped).not.toBeNull()
    expect(capped!.id).toBe('s3-compat')
    expect(capped!.presignGet).toBeTypeOf('function')
  })
})

describe('put — server-mediated write reusing the presigner', () => {
  it('PUTs the exact bytes + Content-Type to a freshly presigned URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await driver().put('upp-1712345678-abcd12.png', bytes, 'image/png')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url.startsWith(`${ORIGIN}/mjengo-photos/upp-1712345678-abcd12.png?`)).toBe(true)
    expect(url).toContain('X-Amz-Expires=60') // short-lived: minted + consumed immediately
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png')
    expect(Buffer.from(init.body as Uint8Array)).toEqual(bytes)
  })

  it('a non-2xx response throws a single-line, secret-free error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('AccessDenied', { status: 403 }))
    await expect(driver().put('upp-1-abcdef.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow(
      /s3-compat put failed for key "upp-1-abcdef\.jpg" \(HTTP 403 from mjengo\.test\.r2\.cloudflarestorage\.com\)/,
    )
  })

  it('the thrown error never leaks the presigned URL (it carries the signature)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))
    let err: Error | null = null
    try {
      await driver().put('upp-1-abcdef.jpg', Buffer.from('x'), 'image/jpeg')
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).not.toContain('X-Amz-Signature')
    expect(err!.message).not.toContain('test-secret-not-real')
    expect(err!.message).not.toContain('\n') // single-line: passes route error redaction
  })
})

describe("statObject — the confirm route's verification probe", () => {
  it('200 + content-length/content-type → exists with size and type', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { 'content-length': '1234', 'content-type': 'image/png' } }),
    )
    expect(await driver().statObject!('upp-1712345678-abcd12.png')).toEqual({
      exists: true,
      sizeBytes: 1234,
      contentType: 'image/png',
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('HEAD')
    expect(url).toContain('X-Amz-Expires=60')
  })

  it('404 → exists:false (a plain answer, not a throw)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect(await driver().statObject!('upp-404-000000.png')).toEqual({
      exists: false,
      sizeBytes: null,
      contentType: null,
    })
  })

  it('other statuses → honest single-line error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(driver().statObject!('x.png')).rejects.toThrow(/s3-compat stat failed for key "x\.png" \(HTTP 503/)
  })
})

describe('construction fails closed', () => {
  it('unusable endpoint → honest error naming the problem', () => {
    expect(() => driver({ endpoint: 'not-a-url' })).toThrow(/S3 endpoint is not a valid URL/)
    expect(() => driver({ endpoint: 'ftp://x' })).toThrow(/http\(s\)/)
  })

  it('blank bucket / access key / missing secret → honest errors', () => {
    expect(() => driver({ bucket: '   ' })).toThrow(/S3_BUCKET is empty/)
    expect(() => driver({ accessKeyId: '' })).toThrow(/S3_ACCESS_KEY_ID is empty/)
    expect(() => driver({ secretAccessKey: '' })).toThrow(/S3_SECRET_ACCESS_KEY is empty/)
  })
})

describe('read — the GET seam (issue #37)', () => {
  it('GETs a freshly presigned URL; exact bytes + reported content type + real byte count', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    expect(await driver().read!('docs/doc-1712345678-abcd12.png')).toEqual({
      bytes,
      contentType: 'image/png',
      sizeBytes: bytes.length,
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('GET')
    expect(url.startsWith(`${ORIGIN}/mjengo-photos/docs/doc-1712345678-abcd12.png?`)).toBe(true)
    expect(url).toContain('X-Amz-Expires=60') // short-lived: minted + consumed immediately
  })

  it('404 → null (a plain answer, not a throw — same posture as statObject)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect(await driver().read!('upp-404-000000.png')).toBeNull()
  })

  it('other statuses → honest single-line, secret-free error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    let err: Error | null = null
    try {
      await driver().read!('upp-1-abcdef.jpg')
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toMatch(/s3-compat read failed for key "upp-1-abcdef\.jpg" \(HTTP 503 from mjengo\.test\.r2\.cloudflarestorage\.com\)/)
    expect(err!.message).not.toContain('X-Amz-Signature')
    expect(err!.message).not.toContain('test-secret-not-real')
    expect(err!.message).not.toContain('\n')
  })
})

describe('keyFor — the publicUrl inverse (issues #37 + #38)', () => {
  it('resolves a publicBase URL back to the exact key (docs tree included)', () => {
    const d = driver({ publicBase: 'https://cdn.example.com' })
    for (const key of ['upp-1712345678-abcd12.jpg', 'docs/doc-1712345678-abcd12.pdf']) {
      expect(d.keyFor!(d.publicUrl(key))).toBe(key)
    }
  })

  it('resolves the no-base presigned GET form — the recorded (possibly EXPIRED) query string is irrelevant', () => {
    const d = driver()
    const key = 'upp-1712345678-abcd12.jpg'
    const recorded = d.publicUrl(key) // a presigned GET, 7-day maximum
    expect(recorded).toContain('X-Amz-Signature=')
    expect(d.keyFor!(recorded)).toBe(key)
  })

  it('decodes percent-encoded key segments back to the raw key', () => {
    const d = driver({ publicBase: 'https://cdn.example.com' })
    expect(d.keyFor!(d.publicUrl('photos/my file.jpg'))).toBe('photos/my file.jpg')
  })

  it('a publicBase with its own path prefix resolves (base-path then bucket-path)', () => {
    const d = driver({ publicBase: 'https://cdn.example.com/prefix' })
    const url = d.publicUrl('upp-1-abcdef.jpg')
    expect(url).toBe('https://cdn.example.com/prefix/mjengo-photos/upp-1-abcdef.jpg')
    expect(d.keyFor!(url)).toBe('upp-1-abcdef.jpg')
  })

  it('local-path shapes and foreign origins → null (another backend\u2019s rows)', () => {
    const d = driver({ publicBase: 'https://cdn.example.com' })
    expect(d.keyFor!('/photos/upp-1-abcdef.jpg')).toBeNull()
    expect(d.keyFor!('/docs/doc-1-abcdef12.pdf')).toBeNull()
    expect(d.keyFor!('https://elsewhere.example/mjengo-photos/upp-1-abcdef.jpg')).toBeNull()
    expect(d.keyFor!('not a url')).toBeNull()
    expect(d.keyFor!('')).toBeNull()
  })

  it('traversal shapes refuse — dot segments collapse at URL parse, empty segments are null', () => {
    const d = driver()
    // %2E%2E / %2E are double/single dot segments: WHATWG URL parsing itself
    // collapses them BEFORE keyFor looks (the second layer of defense is the
    // segment check in keyFromObjectPath). After the collapse the bucket
    // prefix is gone → honest null, never a resolvable traversal key.
    expect(d.keyFor!(`${ORIGIN}/mjengo-photos/%2E%2E/secret`)).toBeNull()
    // empty segments survive parsing and are refused explicitly
    expect(d.keyFor!(`${ORIGIN}/mjengo-photos/a//b`)).toBeNull()
    // a path that is only the bucket itself addresses no object
    expect(d.keyFor!(`${ORIGIN}/mjengo-photos`)).toBeNull()
    expect(d.keyFor!(`${ORIGIN}/mjengo-photos/`)).toBeNull()
  })

  it('a base-prefixed path that is NOT the base\u2019s prefix does not resolve', () => {
    const d = driver({ publicBase: 'https://cdn.example.com/prefix' })
    // 'prefix2/...' starts with the string 'prefix' but is a different path —
    // after stripping, the bucket prefix no longer matches → honest null.
    expect(d.keyFor!('https://cdn.example.com/prefix2/mjengo-photos/upp-1-abcdef.jpg')).toBeNull()
  })
})
