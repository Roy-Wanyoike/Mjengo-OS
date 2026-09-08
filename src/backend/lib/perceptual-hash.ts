// 64-bit dHash (difference hash) for construction evidence photos — W6-3,
// issue "Evidence Authenticity Screen". In the genAI era a photo is no longer
// proof; a hash-chained, cross-checked, ledger-bound photo still is. This
// module is the deterministic half of the screen (the vision half lives in
// modules/ai/authenticity.ts): a perceptual hash per SitePhoto so the SAME
// image — re-uploaded as a new photo id or re-attached to a second milestone —
// is detectable as the exact fraud the platform exists to prevent ("this
// photo paid for the foundation AND the slab").
//
// ALGORITHM (the classic dHash, one implementation, zero deps beyond sharp):
//   1. decode the bytes and squash them to a 9×8 GRAYSCALE bitmap (fit 'fill'
//      forces the exact geometry — aspect-preserving resize would give 9×N);
//   2. for each of the 8 rows, compare each pixel with its RIGHT neighbour
//      (9 pixels → 8 comparisons per row → 8×8 = 64 bits);
//   3. bit = 1 when left > right (gradient direction, not magnitude — that
//      is what makes dHash survive re-encoding, brightness shifts and mild
//      compression: the RELATIVE structure survives even when absolute values
//      drift);
//   4. emit the 64 bits as a 16-character lowercase hex string (stable,
//      storable, comparable — the hash column the screen persists).
//
// HOUSE RULES (the module family's, applied to pure image math):
//   · NEVER THROWS: sharp failures (corrupt bytes, non-image input, an
//     unsupported codec) return an honest null — the caller skips the photo,
//     never a fake hash, never a thrown error into a release path. The task
//     9-b note applies: this is the first src/ call site of sharp (already a
//     ^0.34.5 dependency — zero new deps); if the native binary ever fails to
//     load, every call degrades to null and the screen records "not hashed"
//     — fail-closed, never blocks an upload or a release.
//   · FULLY DETERMINISTIC: same bytes → same hex, forever, on every machine —
//     the hash is a projection of pixels, not of time, order or environment.
//     No SDK, no network, no flag: hashing is pure math and the `ai` flag
//     gates the SCREEN that calls it, not the arithmetic.
//   · PURE COMPARISONS: hammingDistance(a, b) is plain bit math over two hex
//     strings; invalid input is an honest -1 sentinel ("not comparable"),
//     never NaN, never a throw.

import sharp from 'sharp'

/** Width of the dHash bitmap (9 pixels → 8 horizontal comparisons per row). */
export const DHASH_WIDTH = 9
/** Height of the dHash bitmap (8 rows × 8 comparisons = 64 bits). */
export const DHASH_HEIGHT = 8
/** Total bits in the hash (matches the 16-char hex representation). */
export const DHASH_BITS = 64

/**
 * Duplicate threshold: two photos whose dHashes sit at Hamming distance ≤ 6
 * (out of 64 bits) are flagged as the same image. CHOSEN CONSERVATIVELY on
 * purpose — a false "duplicate" accuses a contractor of double-billing, so
 * the rule must fire only on near-certain matches:
 *   · byte-identical re-uploads (the dominant real-world fraud) → distance 0;
 *   · re-encoded / recompressed / slightly-shifted re-uploads of the SAME
 *     capture → typically 0–4 bits apart (dHash is robust to exactly this);
 *   · two honest photos of the same wall taken seconds apart → typically
 *     12–25 bits apart (parallax, workers moving, exposure);
 *   · different scenes → 25+ bits apart.
 * A 6-bit line sits well below the honest-same-scene band: it catches the
 * recycled capture while staying clear of the "two photos of the same wall"
 * case. Every match is advisory — a HUMAN decides — so the cost of a rare
 * miss is a human reviewing two photos, not money moving wrongly.
 */
export const DUPLICATE_HAMMING_THRESHOLD = 6

/**
 * Compute the 64-bit dHash of image bytes.
 *
 * @returns 16-char lowercase hex (e.g. '0f1e2d3c4b5a6978') — or null when the
 * bytes are not a decodable image (honest skip; NEVER a throw).
 */
export async function dHash(bytes: Buffer): Promise<string | null> {
  if (!bytes || bytes.length === 0) return null
  try {
    // failOn 'error': only genuinely corrupt input fails; minor warnings
    // (truncated metadata, odd color profiles) still hash — an honest hash of
    // a real photo beats a null over a cosmetic warning.
    const { data, info } = await sharp(bytes, { failOn: 'error' })
      .grayscale()
      .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    // Defensive geometry: the pipeline above must yield exactly 9×8×1 bytes;
    // anything else is an honest null, never a partial hash.
    if (info.width !== DHASH_WIDTH || info.height !== DHASH_HEIGHT) return null
    if (info.channels !== 1 || data.length < DHASH_WIDTH * DHASH_HEIGHT) return null

    // 4 bits per hex char, 16 chars — pure TS, no BigInt needed.
    let hex = ''
    for (let nibble = 0; nibble < DHASH_BITS / 4; nibble++) {
      let v = 0
      for (let bit = 0; bit < 4; bit++) {
        const index = nibble * 4 + bit
        const row = Math.floor(index / 8)
        const col = index % 8
        const left = data[row * DHASH_WIDTH + col]
        const right = data[row * DHASH_WIDTH + col + 1]
        if (left > right) v |= 1 << bit
      }
      hex += v.toString(16)
    }
    return hex
  } catch {
    return null
  }
}

/**
 * Hamming distance between two dHash hex strings — the number of differing
 * bits (0 = identical image structure, 64 = maximally different).
 *
 * Pure and total: nibble-wise XOR + popcount, no BigInt, no allocation of
 * pixel data. Returns -1 when either input is not a comparable 16-char hex
 * hash (honest "not comparable" sentinel — callers treat < 0 as "no match",
 * never as "match").
 */
export function hammingDistance(a: string, b: string): number {
  if (typeof a !== 'string' || typeof b !== 'string') return -1
  if (a.length !== DHASH_BITS / 4 || b.length !== DHASH_BITS / 4) return -1
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16)
    const y = parseInt(b[i], 16)
    if (Number.isNaN(x) || Number.isNaN(y)) return -1
    // XOR the two nibbles, then count the set bits (max 4 per nibble).
    let diff = x ^ y
    while (diff) {
      diff &= diff - 1 // clear the lowest set bit
      distance++
    }
  }
  return distance
}

/**
 * Convenience predicate: two hashes are "the same image" per the documented
 * threshold (see DUPLICATE_HAMMING_THRESHOLD). Uncomparable hashes (−1) are
 * NEVER duplicates — fail toward no-accusation.
 */
export function isDuplicateHash(a: string, b: string): boolean {
  const d = hammingDistance(a, b)
  return d >= 0 && d <= DUPLICATE_HAMMING_THRESHOLD
}
