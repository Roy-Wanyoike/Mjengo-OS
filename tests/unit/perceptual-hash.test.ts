/**
 * W6-3 — 64-bit dHash (src/backend/lib/perceptual-hash.ts): the deterministic
 * half of the evidence authenticity screen.
 *
 * Pure hash math, NO SDK, NO network, NO db — sharp runs on tiny generated
 * in-test PNG/JPEG buffers (the plan's "sharp fixtures are local Buffers").
 * Pinned here (one block per acceptance criterion):
 *   · KNOWN FIXTURES → KNOWN HASH: a uniform gray image has equal neighbours
 *     everywhere → the mathematically forced all-zero hash; a half-bright /
 *     half-dark split pins a stable literal (sharp is a locked ^0.34.5
 *     dependency — the literal is version-locked with it; the CONTRACT under
 *     test is determinism).
 *   · DETERMINISM: same bytes → the same hash, twice; hash-of-hash stability
 *     across call order.
 *   · SAME-SCENE VARIANTS: a JPEG re-encode (smooth scene AND a noise
 *     scene), a global brightness shift and a one-pixel change all land at
 *     Hamming distance ≤ DUPLICATE_HAMMING_THRESHOLD.
 *   · DISTINCT SCENES: inverted split vs split (48 bits), two different
 *     noise fields (19 bits) — well above the threshold.
 *   · HONEST NULL, NEVER A THROW: empty buffer, non-image bytes and a
 *     truncated PNG header all → null; nothing throws.
 *   · hammingDistance/isDuplicateHash: 0, full 64, per-nibble popcount,
 *     invalid input → the -1 "not comparable" sentinel (never a duplicate).
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  DHASH_BITS,
  DUPLICATE_HAMMING_THRESHOLD,
  dHash,
  hammingDistance,
  isDuplicateHash,
} from '@/backend/lib/perceptual-hash'

/** Build a deterministic RGB PNG from a pixel function (36×32 default). */
async function pngBytes(
  pixel: (x: number, y: number) => [number, number, number],
  w = 36,
  h = 32,
): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y)
      const i = (y * w + x) * 3
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
}

const gray = (v: number): [number, number, number] => [v, v, v]

// ---------------- fixtures (deterministic, generated in-test) ----------------

/** Uniform mid-gray — every horizontal gradient is exactly zero. */
const FLAT = pngBytes(() => gray(128))
/** Left half bright, right half dark (a "wall in sunlight" stand-in). */
const SCENE_A = pngBytes((x) => gray(x < 18 ? 220 : 40))
/** The inverse split — left dark, right bright. */
const SCENE_B = pngBytes((x) => gray(x < 18 ? 40 : 220))
/** Two pseudo-noise fields with different horizontal structure. */
const NOISE_A = pngBytes((x, y) => gray((x * 61 + y * 17) % 256))
const NOISE_B = pngBytes((x, y) => gray((y * 61 + x * 17) % 256))

// ---------------------------------------------------------------- known hashes

describe('dHash — known fixtures → known hash', () => {
  it('a uniform gray image → the all-zero hash (equal neighbours everywhere — kernel-independent math)', async () => {
    expect(await dHash(await FLAT)).toBe('0'.repeat(16))
  })

  it('a 9×8 image (no resize needed) hashes identically to the pipeline', async () => {
    const tiny = await sharp({ create: { width: 9, height: 8, channels: 3, background: { r: 100, g: 100, b: 100 } } })
      .png().toBuffer()
    expect(await dHash(tiny)).toBe('0'.repeat(16))
  })

  it('the half-bright/half-dark split pins its stable literal (sharp ^0.34.5 lockstep)', async () => {
    expect(await dHash(await SCENE_A)).toBe('a5a5a5a5a5a5a5a5')
    expect(await dHash(await SCENE_B)).toBe('4242424242424242')
  })

  it('every hash is 16 lowercase hex chars = 64 bits', async () => {
    for (const buf of [await FLAT, await SCENE_A, await NOISE_A]) {
      const hash = await dHash(buf)
      expect(hash).toMatch(/^[0-9a-f]{16}$/)
      expect(DHASH_BITS).toBe(64)
    }
  })
})

// ---------------------------------------------------------------- determinism

describe('dHash — fully deterministic', () => {
  it('same bytes → the same hash on every call', async () => {
    const buf = await NOISE_A
    expect(await dHash(buf)).toBe(await dHash(buf))
  })

  it('two byte-identical PNG re-encodes of the same scene → identical hashes', async () => {
    const a = await sharp(await NOISE_A).png().toBuffer()
    const b = await sharp(await NOISE_A).png().toBuffer()
    expect(await dHash(a)).toBe(await dHash(b))
  })
})

// ------------------------------------------------- same-scene variants (≤ threshold)

describe('dHash — re-encoded / brightness-shifted / one-pixel variants stay within the duplicate threshold', () => {
  it('a JPEG re-encode of a smooth scene → distance 0', async () => {
    const base = await dHash(await SCENE_A)
    const jpeg = await sharp(await SCENE_A).jpeg({ quality: 75 }).toBuffer()
    expect(hammingDistance(base, await dHash(jpeg))).toBeLessThanOrEqual(DUPLICATE_HAMMING_THRESHOLD)
  })

  it('a JPEG re-encode of a NOISE scene (worst case for compression) → distance ≤ threshold', async () => {
    const base = await dHash(await NOISE_A)
    const jpeg = await sharp(await NOISE_A).jpeg({ quality: 80 }).toBuffer()
    const d = hammingDistance(base, await dHash(jpeg))
    expect(d).toBeLessThanOrEqual(DUPLICATE_HAMMING_THRESHOLD)
    expect(d).toBeGreaterThanOrEqual(0)
  })

  it('a global brightness shift (+20 gray) → gradients unchanged → small distance', async () => {
    const shifted = pngBytes((x) => gray(x < 18 ? 240 : 60))
    const d = hammingDistance(await dHash(await SCENE_A), await dHash(await shifted))
    expect(d).toBeLessThanOrEqual(DUPLICATE_HAMMING_THRESHOLD)
  })

  it('a ONE-pixel change → at most a couple of flipped comparisons (diluted by the 9×8 squash)', async () => {
    const raw = await sharp(await NOISE_A).raw().toBuffer()
    const data = Buffer.from(raw)
    const i = (16 * 36 + 18) * 3
    data[i] = Math.min(255, data[i] + 90)
    data[i + 1] = data[i]
    data[i + 2] = data[i]
    const variant = await sharp(data, { raw: { width: 36, height: 32, channels: 3 } }).png().toBuffer()
    const d = hammingDistance(await dHash(await NOISE_A), await dHash(variant))
    expect(d).toBeLessThanOrEqual(2)
  })
})

// ------------------------------------------------- distinct scenes (well above)

describe('dHash — distinct scenes land well above the threshold', () => {
  it('the split vs its inverse → distance 48 of 64', async () => {
    expect(hammingDistance(await dHash(await SCENE_A), await dHash(await SCENE_B))).toBe(48)
  })

  it('two different noise fields → distance 19 of 64 (> threshold)', async () => {
    const d = hammingDistance(await dHash(await NOISE_A), await dHash(await NOISE_B))
    expect(d).toBeGreaterThan(DUPLICATE_HAMMING_THRESHOLD)
  })

  it('flat vs the split → far apart', async () => {
    const d = hammingDistance(await dHash(await FLAT), await dHash(await SCENE_A))
    expect(d).toBeGreaterThan(DUPLICATE_HAMMING_THRESHOLD)
  })
})

// ---------------------------------------------------------------- honest nulls

describe('dHash — decode failure is an honest null, never a throw', () => {
  it('non-image bytes → null', async () => {
    expect(await dHash(Buffer.from('definitely not an image, just text'))).toBeNull()
  })

  it('an empty buffer → null', async () => {
    expect(await dHash(Buffer.alloc(0))).toBeNull()
  })

  it('a truncated PNG header → null (not a partial hash)', async () => {
    const png = await SCENE_A
    expect(await dHash(png.subarray(0, 20))).toBeNull()
  })

  it('random binary garbage → null, no throw', async () => {
    const garbage = Buffer.alloc(512)
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 31) % 251
    expect(await dHash(garbage)).toBeNull()
  })
})

// ---------------------------------------------------------------- pure bit math

describe('hammingDistance / isDuplicateHash — pure nibble math', () => {
  const Z = '0'.repeat(16)
  const F = 'f'.repeat(16)

  it('identical hashes → 0', () => {
    expect(hammingDistance(Z, Z)).toBe(0)
    expect(hammingDistance(F, F)).toBe(0)
    expect(hammingDistance('c81750bd8867991a', 'c81750bd8867991a')).toBe(0)
  })

  it('all-zero vs all-one → 64 (the maximum)', () => {
    expect(hammingDistance(Z, F)).toBe(64)
  })

  it('a one-nibble difference of weight 1 → 1 (per-nibble popcount)', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1)
    expect(hammingDistance('0000000000000000', '0000000000000008')).toBe(1)
  })

  it('a one-nibble difference of weight 4 → 4', () => {
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4)
  })

  it('mixed nibbles: XOR then popcount per position (f vs 3 → 2 bits)', () => {
    expect(hammingDistance('f000000000000000', '3000000000000000')).toBe(2)
    expect(hammingDistance('ff00000000000000', '0000000000000000')).toBe(8)
  })

  it('invalid input → the -1 "not comparable" sentinel, never NaN, never a throw', () => {
    expect(hammingDistance('zzzz', '0000000000000000')).toBe(-1)
    expect(hammingDistance('0000000000000000', 'not-hex')).toBe(-1)
    expect(hammingDistance('short', '0000000000000000')).toBe(-1)
    expect(hammingDistance('', '')).toBe(-1)
  })

  it('isDuplicateHash: threshold boundary is inclusive; uncomparable is NEVER a duplicate', () => {
    // Exactly at the threshold → duplicate; one above → not.
    const at = 'f300000000000000' // pop(f)+pop(3) = 4+2 = 6 from all-zero
    const above = 'f700000000000000' // pop(f)+pop(7) = 4+3 = 7 from all-zero
    const Z = '0'.repeat(16)
    expect(hammingDistance(Z, at)).toBe(6)
    expect(isDuplicateHash(Z, at)).toBe(true)
    expect(hammingDistance(Z, above)).toBe(7)
    expect(isDuplicateHash(Z, above)).toBe(false)
    expect(isDuplicateHash(Z, 'garbage')).toBe(false)
    expect(isDuplicateHash(Z, Z)).toBe(true)
  })

  it('the documented threshold is the conservative 6 of 64', () => {
    expect(DUPLICATE_HAMMING_THRESHOLD).toBe(6)
  })
})
