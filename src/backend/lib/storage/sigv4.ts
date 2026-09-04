// AWS Signature Version 4 — query-string presigning for S3-compatible object
// storage (task 9-b). PURE module: no env reads, no clock reads except the
// injectable `now` — everything it needs arrives as explicit arguments, so
// tests can pin exact golden values (see tests/unit/storage-sigv4.test.ts).
//
// This is the QUERY-STRING flavor (presigned URLs), not header auth:
//   · the signature travels as X-Amz-Signature in the URL, not as an
//     Authorization header;
//   · the ONLY signed header is `host` (X-Amz-SignedHeaders=host);
//   · the payload is UNSIGNED (literal "UNSIGNED-PAYLOAD" — the client's
//     bytes are never hashed or seen by the server that minted the URL);
//   · the Content-Type a presigned PUT should carry is returned to the caller
//     as an advisory header (it is not, and cannot be, part of a host-only
//     signature — /api/upload/confirm checks it against the object after the
//     fact).
//
// Algorithm (AWS SigV4 reference, service=s3, path-style addressing):
//   canonicalRequest =
//     METHOD \n canonicalURI \n canonicalQueryString \n
//     canonicalHeaders (host:…) \n \n signedHeaders (host) \n "UNSIGNED-PAYLOAD"
//   stringToSign =
//     "AWS4-HMAC-SHA256" \n amzDate \n date/region/s3/aws4_request \n
//     hex(sha256(canonicalRequest))
//   signingKey = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), "s3"),
//                     "aws4_request")
//   signature  = hex(HMAC(signingKey, stringToSign))
//   url        = origin "/" bucket "/" encodedKey "?" query "&X-Amz-Signature=" sig
//
// THE S3 ENCODING FLAVOR: S3 (unlike other AWS services) does NOT
// double-encode the path. Each path segment is URI-encoded ONCE with AWS's
// UriEncode (unreserved A–Z a–z 0–9 - _ . ~ kept, everything else %XX,
// uppercase hex); "/" stays the separator. Query values use the same
// encoding — X-Amz-Credential's "/" becomes %2F, which is why the credential
// appears percent-encoded in both the canonical query and the final URL.
//
// Works against AWS S3, Cloudflare R2 and MinIO (all accept SigV4 with
// service "s3", scope terminator "aws4_request", and path-style URLs).

import { createHash, createHmac } from 'crypto'

/** Methods we presign: GET (download/HEAD-replay), PUT (client upload), HEAD (verify). */
export type PresignMethod = 'GET' | 'PUT' | 'HEAD'

export interface SigV4PresignOptions {
  method: PresignMethod
  /** Endpoint origin, e.g. https://s3.eu-central-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com. */
  endpoint: string
  region: string
  bucket: string
  key: string
  accessKeyId: string
  secretAccessKey: string
  /** Seconds the URL stays valid. S3 caps this at 604800 (7 days). */
  expiresSec: number
  /** Injectable clock (deterministic tests). Defaults to () => new Date(). */
  now?: () => Date
}

/** Everything the signer computed — internals exposed for golden-value tests. */
export interface SigV4Presign {
  url: string
  signature: string
  canonicalRequest: string
  stringToSign: string
  amzDate: string
  credentialScope: string
  /** Always "host" — the only header this flavor signs. */
  signedHeaders: string
  /** The host: value used in canonicalHeaders (host[:port]). */
  host: string
}

/** AWS SigV4 upper limit for X-Amz-Expires (7 days) on S3-compatible stores. */
export const MAX_PRESIGN_EXPIRES_SEC = 604_800

// ---------------------------------------------------------------- primitives

/** hex(sha256(data)) — the canonical-request and payload hasher. */
export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Raw HMAC-SHA256 (binary key — the signing-key chain links these). */
export function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * The derived signing key: HMAC chain secret → date → region → service →
 * "aws4_request". Exported because the chain shape itself is part of the
 * pinned contract (tests assert the exact intermediate values).
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service = 's3',
): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

/**
 * AWS UriEncode: unreserved chars (A–Z a–z 0–9 - _ . ~) pass through,
 * everything else becomes %XX with UPPERCASE hex. encodeURIComponent already
 * matches for everything except ! ' ( ) * — the replace covers those.
 */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * S3 path-style canonical URI: "/<bucket>/<key>", each key segment encoded
 * ONCE (the S3 flavor — no double encoding), "/" kept as the separator.
 */
export function canonicalUri(bucket: string, key: string): string {
  const segments = key.split('/').map((seg) => awsUriEncode(seg))
  return `/${awsUriEncode(bucket)}/${segments.join('/')}`
}

/** The amz timestamp pair: X-Amz-Date (20130524T000000Z) + scope date (20130524). */
export function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString() // UTC — SigV4 timestamps are always UTC
  const dateStamp = iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10)
  const amzDate = `${dateStamp}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  return { amzDate, dateStamp }
}

/** Endpoint parsed once: origin + the host[:port] that goes into the signed header. */
export function parseEndpoint(endpoint: string): { origin: string; host: string } {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`S3 endpoint is not a valid URL: ${JSON.stringify(endpoint)} (include the scheme, e.g. https://s3.eu-central-1.amazonaws.com)`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`S3 endpoint must be http(s): ${JSON.stringify(endpoint)}`)
  }
  return { origin: url.origin, host: url.host }
}

// ---------------------------------------------------------------- the signer

/**
 * Mint a presigned URL. Pure and synchronous — the only I/O is the clock,
 * which is injectable. Throws on an out-of-range expiry (1..604800) so a
 * misconfigured caller fails before minting a URL the store will reject.
 */
export function sigv4Presign(opts: SigV4PresignOptions): SigV4Presign {
  if (
    !Number.isInteger(opts.expiresSec) ||
    opts.expiresSec < 1 ||
    opts.expiresSec > MAX_PRESIGN_EXPIRES_SEC
  ) {
    throw new Error(
      `X-Amz-Expires must be an integer between 1 and ${MAX_PRESIGN_EXPIRES_SEC} seconds (got ${opts.expiresSec})`,
    )
  }

  const { origin, host } = parseEndpoint(opts.endpoint)
  const now = opts.now ? opts.now() : new Date()
  const { amzDate, dateStamp } = amzTimestamps(now)
  const credentialScope = `${dateStamp}/${opts.region}/s3/aws4_request`
  const signedHeaders = 'host'
  const uri = canonicalUri(opts.bucket, opts.key)

  // Canonical query string: the five X-Amz-* params, URI-encoded values,
  // sorted by encoded name (all names are ASCII here, so a plain sort is the
  // AWS byte-order sort).
  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${opts.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(opts.expiresSec)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ]
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const canonicalQuery = params
    .map(([name, value]) => `${awsUriEncode(name)}=${awsUriEncode(value)}`)
    .join('&')

  const canonicalRequest =
    `${opts.method}\n${uri}\n${canonicalQuery}\n` +
    `host:${host}\n\n${signedHeaders}\nUNSIGNED-PAYLOAD`

  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n` +
    sha256Hex(canonicalRequest)

  const signingKey = deriveSigningKey(opts.secretAccessKey, dateStamp, opts.region)
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

  const url = `${origin}${uri}?${canonicalQuery}&X-Amz-Signature=${signature}`

  return {
    url,
    signature,
    canonicalRequest,
    stringToSign,
    amzDate,
    credentialScope,
    signedHeaders,
    host,
  }
}
