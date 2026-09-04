// The default storage driver: local disk, byte-identical to the historical
// /api/upload photo path (task 9-b). Files land in public/photos/<key> and
// are served by the Next server at /photos/<key> — the single-box self-host
// contract every prior release shipped. canPresign is FALSE: there is no
// signing to do when the web server is also the file server, so the
// client-direct presigned flow honestly 409s instead of pretending.
//
// `put` is deliberately strict about the key: one flat segment of safe
// characters ([A-Za-z0-9][A-Za-z0-9._-]*), no traversal, no separators —
// exactly the shapes the server itself generates (upp-<ts>-<hex>.<ext>).
// Today's route never wrote anything else; the adapter just refuses to
// become a general-purpose file writer.

import { mkdir, stat, writeFile } from 'fs/promises'
import path from 'path'
import type { ObjectStat, StorageAdapter } from './types'

/** Flat, traversal-free, server-generated key shapes only. */
const SAFE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
}

export interface LocalDiskOptions {
  /**
   * Base directory the key is written under. Defaults to
   * <cwd>/public/photos — exactly where /api/upload always wrote. The option
   * exists as the test seam (tmp dir), not as a deployment knob.
   */
  photosDir?: string
}

export function createLocalDiskDriver(opts: LocalDiskOptions = {}): StorageAdapter {
  const dir = opts.photosDir ?? path.join(process.cwd(), 'public', 'photos')

  return {
    id: 'local-disk',
    canPresign: false,

    async put(key: string, bytes, _contentType) {
      if (!SAFE_KEY_RE.test(key)) {
        throw new Error(
          `local-disk driver: unsafe storage key ${JSON.stringify(key)} — expected a single server-generated segment like upp-<ts>-<hex>.<ext>`,
        )
      }
      await mkdir(dir, { recursive: true }) // runtime state, created on demand (as before)
      await writeFile(path.join(dir, key), bytes)
    },

    publicUrl(key: string): string {
      return `/photos/${key}`
    },

    // Not required by any current flow (presign 409s for this driver), but
    // honest + cheap: the confirm route can verify a key against the real
    // disk instead of special-casing. Content-Type is derived from the
    // extension — local files carry no metadata side-channel.
    async statObject(key: string): Promise<ObjectStat> {
      if (!SAFE_KEY_RE.test(key)) return { exists: false, sizeBytes: null, contentType: null }
      const s = await stat(path.join(dir, key)).catch(() => null)
      if (!s) return { exists: false, sizeBytes: null, contentType: null }
      const ext = key.split('.').pop() ?? ''
      return { exists: true, sizeBytes: s.size, contentType: EXT_MIME[ext] ?? null }
    },
  }
}

/** The process-wide default instance (public/photos of the running app). */
export const localDiskDriver: StorageAdapter = createLocalDiskDriver()
