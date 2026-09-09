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
