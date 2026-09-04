// S3/R2/MinIO-compatible driver (task 9-b). Path-style URLs
// (https://<endpoint-host>/<bucket>/<key>), SigV4 query-string presigning
// via ./sigv4.ts, and fetch for ALL wire traffic — zero new dependencies.
//
// WHY EVERYTHING GOES THROUGH PRESIGNED URLS (including server-side writes):
// the alternative would be a second, header-based SigV4 implementation
// (Authorization header + x-amz-content-sha256) that no test pins. Minting a
// short-lived presigned URL and fetching it reuses the SAME signer the
// client-direct flow exercises — one signing code path, fully covered by the
// golden tests. put() mints a 60s PUT URL and sends the bytes immediately;
// statObject() mints a 60s HEAD URL. The signature never leaves the process
// in a response (only the presign route hands one to a client, deliberately).
//
// publicUrl(key) — the honest tradeoff, choose per deployment:
//   · S3_PUBLIC_BASE set (recommended: bucket or CDN fronting it):
//     `${base}/${key}` — stable, replayable forever, what Attachment rows
//     should store.
//   · UNSET: a presigned GET (default 7 days — the SigV4 maximum). Works
//     immediately, but URLs recorded today stop resolving next week. This is
//     the documented limitation of a private bucket without a public base;
//     the fix is operational (set the base), not code (a replay-time
//     re-signing seam is the follow-up this consciously defers).
//
// Content-Type on put()/presignPut(): the signature covers host only, so the
// header is advisory — S3 stores whatever the PUT carries and reports it on
// HEAD, which /api/upload/confirm uses to verify the client kept the
// contract. Errors thrown here are single-line and secret-free (no URLs —
// they carry signatures; no credentials) so route error mappers pass them
// through honestly.

import type { ObjectStat, PresignedPut, StorageAdapter } from './types'
import { canonicalUri, parseEndpoint, sigv4Presign } from './sigv4'

/** Server-mediated put() mints + consumes the URL immediately. */
const SERVER_OP_EXPIRES_SEC = 60
/** publicUrl() default when no S3_PUBLIC_BASE: the SigV4 7-day maximum. */
export const DEFAULT_GET_PRESIGN_EXPIRES_SEC = 604_800

export interface S3CompatConfig {
  /** Full endpoint origin, e.g. https://s3.eu-central-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Public base for stable URLs (CDN or public bucket). No trailing slash. */
  publicBase?: string
  /** Injectable clock for deterministic URLs in tests. */
  now?: () => Date
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch
}

export function createS3CompatDriver(config: S3CompatConfig): StorageAdapter {
  // Fail closed at construction: an unusable endpoint must never degrade to
  // a silently-wrong driver (and a missing bucket/credentials is a factory
  // concern — see index.ts).
  const { origin, host } = parseEndpoint(config.endpoint)
  if (!config.bucket.trim()) throw new Error('s3-compat driver: S3_BUCKET is empty')
  if (!config.accessKeyId.trim()) throw new Error('s3-compat driver: S3_ACCESS_KEY_ID is empty')
  if (!config.secretAccessKey) throw new Error('s3-compat driver: S3_SECRET_ACCESS_KEY is empty')

  const doFetch = config.fetchImpl ?? fetch
  const presign = (method: 'GET' | 'PUT' | 'HEAD', key: string, expiresSec: number) =>
    sigv4Presign({
      method,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      key,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSec,
      now: config.now,
    })

  /** Object URL path, single-encoded (same shape the signer canonicalizes). */
  const objectPath = (key: string) => canonicalUri(config.bucket, key)

  return {
    id: 's3-compat',
    canPresign: true,

    async put(key: string, bytes, contentType) {
      const { url } = presign('PUT', key, SERVER_OP_EXPIRES_SEC)
      const res = await doFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: new Uint8Array(bytes),
      })
      if (!res.ok) {
        // Single-line, secret-free: no URL (it carries the signature).
        throw new Error(
          `s3-compat put failed for key "${key}" (HTTP ${res.status} from ${host})`,
        )
      }
    },

    publicUrl(key: string): string {
      const base = config.publicBase?.trim().replace(/\/+$/, '')
      if (base) return `${base}${objectPath(key)}`
      return presign('GET', key, DEFAULT_GET_PRESIGN_EXPIRES_SEC).url
    },

    presignPut(key: string, contentType: string, expiresSec: number): PresignedPut {
      const { url } = presign('PUT', key, expiresSec)
      return { url, headers: { 'Content-Type': contentType } }
    },

    presignGet(key: string, expiresSec: number): string {
      return presign('GET', key, expiresSec).url
    },

    async statObject(key: string): Promise<ObjectStat> {
      const { url } = presign('HEAD', key, SERVER_OP_EXPIRES_SEC)
      const res = await doFetch(url, { method: 'HEAD' })
      if (res.status === 404) return { exists: false, sizeBytes: null, contentType: null }
      if (!res.ok) {
        throw new Error(
          `s3-compat stat failed for key "${key}" (HTTP ${res.status} from ${host})`,
        )
      }
      const len = Number(res.headers.get('content-length') ?? '')
      return {
        exists: true,
        sizeBytes: Number.isFinite(len) ? len : null,
        contentType: res.headers.get('content-type'),
      }
    },
  }
}

