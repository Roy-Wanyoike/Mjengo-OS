/**
 * SigV4 query-string presigning — golden-value pins (task 9-b).
 *
 * The goldens were computed INDEPENDENTLY of this implementation (openssl
 * CLI + a separate Python script — both agreed) for the fixed fixture:
 *   secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, key id
 *   AKIAIOSFODNN7EXAMPLE (the AWS documentation fixture pair), region
 *   us-east-1, bucket examplebucket, path-style endpoint
 *   https://s3.amazonaws.com, clock frozen at 2013-05-24T00:00:00Z.
 *
 * What is pinned EXACTLY (string-equality, not shape):
 *   · the FULL canonical request (method, canonical URI, canonical query,
 *     host: canonical header, empty line, host signed-headers line,
 *     UNSIGNED-PAYLOAD) for a GET and a PUT;
 *   · the FULL string-to-sign (algorithm line, X-Amz-Date, credential scope,
 *     sha256 hex of the canonical request);
 *   · the final X-Amz-Signature and the complete presigned URL;
 *   · the signing-key chain's first and last HMAC links (hex).
 *
 * Plus algorithm-SHAPE assertions the AWS spec demands: UNSIGNED-PAYLOAD
 * (never a payload hash), host-only signed headers, S3 single-encoding
 * (never %2520-style double encoding), uppercase-hex %XX, the 7-day expiry
 * ceiling, and honest failures for bad expiries/endpoints.
 */
import { describe, expect, it } from 'vitest'

import {
  MAX_PRESIGN_EXPIRES_SEC,
  amzTimestamps,
  awsUriEncode,
  canonicalUri,
  deriveSigningKey,
  hmacSha256,
  parseEndpoint,
  sha256Hex,
  sigv4Presign,
} from '@/backend/lib/storage/sigv4'

// ------------------------------------------------------------ fixed fixture

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const AKID = 'AKIAIOSFODNN7EXAMPLE'
const REGION = 'us-east-1'
const BUCKET = 'examplebucket'
const ENDPOINT = 'https://s3.amazonaws.com'
const NOW = () => new Date('2013-05-24T00:00:00Z')

const QUERY_GET =
  'X-Amz-Algorithm=AWS4-HMAC-SHA256&' +
  'X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&' +
  'X-Amz-Date=20130524T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host'

const CANONICAL_REQUEST_GET = [
  'GET',
  '/examplebucket/test.txt',
  QUERY_GET,
  'host:s3.amazonaws.com',
  '',
  'host',
  'UNSIGNED-PAYLOAD',
].join('\n')

const CRHASH_GET = '4de24c6947479d27ffd2fba26d85dd0beba54c56de85399505bba93c99f20a12'
const SIG_GET = '50be01b2c80c91cd5f525a9bce4a2b8bd2c700ab7d5c0a7965fb109831e80c05'

const QUERY_PUT =
  'X-Amz-Algorithm=AWS4-HMAC-SHA256&' +
  'X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&' +
  'X-Amz-Date=20130524T000000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host'

const CANONICAL_REQUEST_PUT = [
  'PUT',
  '/examplebucket/upp-1712345678-abcd12.jpg',
  QUERY_PUT,
  'host:s3.amazonaws.com',
  '',
  'host',
  'UNSIGNED-PAYLOAD',
].join('\n')

const CRHASH_PUT = 'fdf417340de9edfbd8e9c8f80a0089629b571679dd37b6ac69d3418f55c63d40'
const SIG_PUT = '6adfb9dfa65b6c43eae4143f3e3489c48609cb64378f358df4467744c2ef5409'

// The signing-key chain links, independently computed:
//   kDate = HMAC-SHA256(key="AWS4"+secret,  "20130524")
//   kSign = HMAC(HMAC(HMAC(kDate, "us-east-1"), "s3"), "aws4_request")
const KDATE_HEX = '68896419206d6240ad4cd7dc8ba658efbf3b43b53041950083a10833824fcfbb'
const KSIGN_HEX = 'dbb893acc010964918f1fd433add87c70e8b0db6be30c1fbeafefa5ec6ba8378'

const presign = (method: 'GET' | 'PUT' | 'HEAD', key: string, expiresSec: number) =>
  sigv4Presign({
    method,
    endpoint: ENDPOINT,
    region: REGION,
    bucket: BUCKET,
    key,
    accessKeyId: AKID,
    secretAccessKey: SECRET,
    expiresSec,
    now: NOW,
  })

// ---------------------------------------------------------- golden pins

describe('sigv4Presign — golden GET (presigned download)', () => {
  const r = presign('GET', 'test.txt', 3600)

  it('builds the exact canonical request', () => {
    expect(r.canonicalRequest).toBe(CANONICAL_REQUEST_GET)
  })

  it('hashes the canonical request exactly (independently computed hex)', () => {
    expect(sha256Hex(CANONICAL_REQUEST_GET)).toBe(CRHASH_GET)
  })

  it('builds the exact string-to-sign', () => {
    expect(r.stringToSign).toBe(
      ['AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', CRHASH_GET].join('\n'),
    )
  })

  it('derives the exact signature', () => {
    expect(r.signature).toBe(SIG_GET)
  })

  it('produces the exact final URL (path-style, query-encoded, signature last)', () => {
    expect(r.url).toBe(`https://s3.amazonaws.com/examplebucket/test.txt?${QUERY_GET}&X-Amz-Signature=${SIG_GET}`)
  })

  it('exposes the scope/timestamp shape honestly', () => {
    expect(r.credentialScope).toBe('20130524/us-east-1/s3/aws4_request')
    expect(r.amzDate).toBe('20130524T000000Z')
    expect(r.signedHeaders).toBe('host')
    expect(r.host).toBe('s3.amazonaws.com')
  })
})

describe('sigv4Presign — golden PUT (presigned client upload)', () => {
  const r = presign('PUT', 'upp-1712345678-abcd12.jpg', 300)

  it('builds the exact canonical request (real photo key shape)', () => {
    expect(r.canonicalRequest).toBe(CANONICAL_REQUEST_PUT)
  })

  it('derives the exact signature — method-bound, not the GET one', () => {
    expect(sha256Hex(CANONICAL_REQUEST_PUT)).toBe(CRHASH_PUT)
    expect(r.signature).toBe(SIG_PUT)
    expect(r.signature).not.toBe(SIG_GET)
  })

  it('final PUT URL carries X-Amz-Expires=300', () => {
    expect(r.url).toContain('X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=')
    expect(r.url).toBe(`https://s3.amazonaws.com/examplebucket/upp-1712345678-abcd12.jpg?${QUERY_PUT}&X-Amz-Signature=${SIG_PUT}`)
  })
})

describe('the AWS algorithm shape itself', () => {
  it('payload is UNSIGNED-PAYLOAD (bytes are never hashed or seen)', () => {
    for (const cr of [presign('GET', 'x.png', 60).canonicalRequest, presign('PUT', 'x.png', 60).canonicalRequest]) {
      expect(cr.endsWith('\nUNSIGNED-PAYLOAD')).toBe(true)
      expect(cr).not.toContain('X-Amz-Content-Sha256')
    }
  })

  it('signs HOST only — no content-type, no x-amz-* headers in the header set', () => {
    const r = presign('PUT', 'x.png', 60)
    expect(r.signedHeaders).toBe('host')
    expect(r.canonicalRequest).toContain('host:s3.amazonaws.com\n\nhost\n')
    expect(r.canonicalRequest).not.toContain('content-type')
  })

  it('S3 single-encodes each key segment — never double-encodes', () => {
    expect(canonicalUri('b', 'my file+&=1.jpg')).toBe('/b/my%20file%2B%26%3D1.jpg')
    expect(canonicalUri('b', 'photos/site 1.jpg')).toBe('/b/photos/site%201.jpg') // '/' kept as separator
    const uri = presign('GET', 'photos/my file.jpg', 60).canonicalRequest.split('\n')[1]
    expect(uri).toBe('/examplebucket/photos/my%20file.jpg')
    expect(uri).not.toContain('%2520') // the double-encoding bug
    expect(uri).not.toContain('%252F')
  })

  it('awsUriEncode: unreserved pass through, everything else uppercase %XX', () => {
    expect(awsUriEncode('AZaz09-._~')).toBe('AZaz09-._~')
    expect(awsUriEncode(' ')).toBe('%20')
    expect(awsUriEncode('+')).toBe('%2B')
    expect(awsUriEncode('/')).toBe('%2F')
    expect(awsUriEncode('!')).toBe('%21')
    expect(awsUriEncode('(')).toBe('%28')
    expect(awsUriEncode('=')).toBe('%3D')
    expect(awsUriEncode('é')).toBe('%C3%A9')
  })

  it('the signing key is the HMAC chain secret → date → region → s3 → aws4_request', () => {
    const kDate = hmacSha256(`AWS4${SECRET}`, '20130524')
    expect(kDate.toString('hex')).toBe(KDATE_HEX)
    const kSign = deriveSigningKey(SECRET, '20130524', REGION)
    expect(kSign.toString('hex')).toBe(KSIGN_HEX)
    // the scope terminator and service are baked in
    const kOther = deriveSigningKey(SECRET, '20130524', 'eu-central-1')
    expect(kOther.toString('hex')).not.toBe(KSIGN_HEX)
  })

  it('query params sort by encoded name (byte order)', () => {
    // X-Amz-Algorithm < X-Amz-Credential < X-Amz-Date < X-Amz-Expires <
    // X-Amz-SignedHeaders — pinned by the golden query strings above. The
    // signature is NOT part of the sorted set: AWS appends it AFTER the
    // canonical query, and so does this URL.
    const url = presign('GET', 'x.png', 60).url
    const parts = url.split('?')[1].split('&')
    const names = parts.slice(0, -1).map((p) => p.split('=')[0])
    expect(names).toEqual([...names].sort())
    expect(names).toContain('X-Amz-Algorithm')
    expect(parts.at(-1)).toMatch(/^X-Amz-Signature=[0-9a-f]{64}$/) // always last
  })

  it('timestamps: X-Amz-Date and the scope date derive from the injected clock (UTC)', () => {
    const t = amzTimestamps(new Date('2026-03-09T21:04:05.678Z'))
    expect(t.amzDate).toBe('20260309T210405Z')
    expect(t.dateStamp).toBe('20260309')
  })

  it('host keeps a non-default port (MinIO-style endpoints)', () => {
    const r = sigv4Presign({
      method: 'GET',
      endpoint: 'http://minio.local:9000',
      region: REGION,
      bucket: BUCKET,
      key: 'x.png',
      accessKeyId: AKID,
      secretAccessKey: SECRET,
      expiresSec: 60,
      now: NOW,
    })
    expect(r.host).toBe('minio.local:9000')
    expect(r.canonicalRequest).toContain('host:minio.local:9000\n')
    expect(r.url).toContain('http://minio.local:9000/examplebucket/x.png?')
  })
})

describe('honest failure modes', () => {
  it('rejects out-of-range / non-integer expiries (S3 caps at 7 days)', () => {
    expect(MAX_PRESIGN_EXPIRES_SEC).toBe(604_800)
    for (const bad of [0, -1, 604_801, 1.5, Number.NaN]) {
      expect(() => presign('GET', 'x.png', bad)).toThrow(/X-Amz-Expires/)
    }
    expect(() => presign('GET', 'x.png', 604_800)).not.toThrow()
  })

  it('rejects unusable endpoints with an honest, actionable message', () => {
    for (const bad of ['not a url', 'ftp://x', '']) {
      expect(() =>
        sigv4Presign({
          method: 'GET',
          endpoint: bad,
          region: REGION,
          bucket: BUCKET,
          key: 'x.png',
          accessKeyId: AKID,
          secretAccessKey: SECRET,
          expiresSec: 60,
          now: NOW,
        }),
      ).toThrow(/endpoint/)
    }
  })

  it('parses valid endpoints (origin + host)', () => {
    expect(parseEndpoint('https://s3.eu-central-1.amazonaws.com')).toEqual({
      origin: 'https://s3.eu-central-1.amazonaws.com',
      host: 's3.eu-central-1.amazonaws.com',
    })
    expect(parseEndpoint('https://acct.r2.cloudflarestorage.com/')).toEqual({
      origin: 'https://acct.r2.cloudflarestorage.com',
      host: 'acct.r2.cloudflarestorage.com',
    })
  })
})
