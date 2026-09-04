// Object-storage driver seam (upload module, task 9-b — issue "Move uploads
// to object storage (presigned URLs)").
//
// One narrow interface every upload path talks to, so the SAME route code
// serves the self-host single-box default (local disk under public/photos,
// served by the Next server) and an S3/R2/MinIO-compatible bucket (files
// PUT server-side, or client-direct via presigned URLs when the driver
// supports it). The factory lives in ./index.ts.
//
// KEY CONTRACT (mirrors the historical /api/upload photo key shape): a
// storage key is a single flat segment like `upp-1712345678-abcd12.jpg` —
// server-generated, never user-supplied. The DRIVER owns where it lands:
//   · local-disk  → public/photos/<key>   (exactly today's file layout)
//   · s3-compat   → s3://<bucket>/<key>   (path-style URLs)
//
// URL CONTRACT: `publicUrl(key)` is the string the app records and the
// frontend renders (<img src=…>). For local-disk it is the stable path
// /photos/<key>; for s3-compat it is the public CDN base (S3_PUBLIC_BASE)
// when one is configured, otherwise a presigned GET URL — see
// src/backend/lib/storage/s3-compat.ts for the honest expiry tradeoff.

import type { Buffer } from 'buffer'

/** Result shape of a presigned PUT (client-direct upload capability). */
export interface PresignedPut {
  /** Signed URL the client PUTs its bytes to (method-bound, time-limited). */
  url: string
  /**
   * Headers the client SHOULD send with the PUT. Content-Type is NOT part of
   * the signature (signed headers are host-only — see sigv4.ts), so this is
   * an advisory contract: S3 stores whatever Content-Type the PUT carries,
   * and /api/upload/confirm verifies it after the fact.
   */
  headers: Record<string, string>
}

/** Object metadata as reported by a HEAD-style check (confirm flow). */
export interface ObjectStat {
  exists: boolean
  sizeBytes: number | null
  contentType: string | null
}

/**
 * The storage adapter. `presignPut` / `presignGet` are OPTIONAL capabilities
 * (local disk cannot presign — its files are already served by the Next
 * server); `statObject` is optional for the same reason anything is: a driver
 * that cannot verify an object's existence answers the confirm route with an
 * honest 409 instead of guessing.
 */
export interface StorageAdapter {
  readonly id: 'local-disk' | 's3-compat'
  /** True when presignPut/presignGet are implemented (client-direct flow). */
  readonly canPresign: boolean
  /** Write bytes to the driver's storage at `key` (server-mediated put). */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>
  /** The URL the app records + the frontend renders for `key`. */
  publicUrl(key: string): string
  /** Capability: mint a time-limited signed PUT URL for `key`. */
  presignPut?(key: string, contentType: string, expiresSec: number): PresignedPut
  /** Capability: mint a time-limited signed GET URL for `key`. */
  presignGet?(key: string, expiresSec: number): string
  /** Capability: existence + size + content-type probe for `key`. */
  statObject?(key: string): Promise<ObjectStat>
}

/**
 * A driver that implements the presigned flow, narrowed so route code can
 * call presignPut/presignGet without non-null assertions. `asPresignCapable`
 * checks the capability honestly (canPresign AND both methods present) — a
 * driver that claims canPresign but lacks the methods is a bug, and this
 * guard turns it into a null the caller maps to an honest error.
 */
export interface PresignCapableAdapter extends StorageAdapter {
  presignPut(key: string, contentType: string, expiresSec: number): PresignedPut
  presignGet(key: string, expiresSec: number): string
}

export function asPresignCapable(driver: StorageAdapter): PresignCapableAdapter | null {
  if (
    driver.canPresign &&
    typeof driver.presignPut === 'function' &&
    typeof driver.presignGet === 'function'
  ) {
    return driver as PresignCapableAdapter
  }
  return null
}
