/**
 * Invariants of the voice-log PII scrubber (src/backend/lib/pii-scrub.ts).
 *
 * Pins the module header's contract:
 *  · every canonical Kenyan phone shape masks — 07xx/01xx local (10 digits),
 *    +2547xx/2541xx international (12 digits + "+") and bare 2547xx/2541xx —
 *    including spaced and hyphenated groupings, in any grouping width;
 *  · the mask is CONSTANT: recognizable prefix + 6 bullets + last 2 digits,
 *    same length as the input, internal separators collapsed;
 *  · false positives are refused: amounts/quantities ("45000", "ksh 45000",
 *    "KES 45,000", decimals), times ("07:30", "07:30:15" — colons are not
 *    phone separators), task numbers, short runs, 9-digit no-zero forms,
 *    longer contiguous or contiguous-continuation runs, and digit runs
 *    welded into tokens ("X0712345678Y", "id0712345678");
 *  · the documented ambiguities resolve toward masking: two space-adjacent
 *    phones both mask; a 10-digit prefix followed by space + more digits
 *    masks the prefix (that shape also carries adjacent numbers, which must
 *    both mask);
 *  · `masked` counts every phone masked (0 when nothing matched);
 *  · idempotent: scrubbing an already-scrubbed transcript is a no-op
 *    (both layers of the 8-b wiring scrub — route + parse seam).
 */
import { describe, expect, it } from 'vitest'
import { scrubTranscriptPhones } from '@/backend/lib/pii-scrub'

const scrub = (text: string) => scrubTranscriptPhones(text)

describe('canonical phone shapes are masked', () => {
  it('local 07 mobile, contiguous', () => {
    expect(scrub('0712345678')).toEqual({ scrubbed: '07\u2022\u2022\u2022\u2022\u2022\u202278', masked: 1 })
  })

  it('local 01 mobile, contiguous', () => {
    expect(scrub('0110123456')).toEqual({ scrubbed: '01\u2022\u2022\u2022\u2022\u2022\u202256', masked: 1 })
  })

  it('local mobile, spaced (0712 345 678)', () => {
    expect(scrub('0712 345 678')).toEqual({ scrubbed: '07\u2022\u2022\u2022\u2022\u2022\u202278', masked: 1 })
  })

  it('local mobile, hyphenated (0712-345-678)', () => {
    expect(scrub('0712-345-678')).toEqual({ scrubbed: '07\u2022\u2022\u2022\u2022\u2022\u202278', masked: 1 })
  })

  it('local mobile, 2-digit groupings (07 12 34 56 78)', () => {
    expect(scrub('07 12 34 56 78')).toEqual({ scrubbed: '07\u2022\u2022\u2022\u2022\u2022\u202278', masked: 1 })
  })

  it('international +254 mobile, contiguous', () => {
    expect(scrub('+254712345678')).toEqual({ scrubbed: '+2547\u2022\u2022\u2022\u2022\u2022\u202278', masked: 1 })
  })

  it('international +254 mobile, spaced (+254 712 345 678)', () => {
    expect(scrub('+254 712 345 678')).toEqual({ scrubbed: '+2547\u2022\u2022\u2022\u2022\u2022\u202278', masked: 1 })
  })

  it('international +254 mobile, hyphenated (+254-711-223-344)', () => {
    expect(scrub('+254-711-223-344')).toEqual({ scrubbed: '+2547\u2022\u2022\u2022\u2022\u2022\u202244', masked: 1 })
  })

  it('bare 254 country code, contiguous (254712345678)', () => {
    expect(scrub('254712345678')).toEqual({ scrubbed: '2547\u2022\u2022\u2022\u2022\u2022\u202278', masked: 1 })
  })

  it('bare 254 country code, spaced (254 712 345 678)', () => {
    expect(scrub('254 712 345 678')).toEqual({ scrubbed: '2547\u2022\u2022\u2022\u2022\u2022\u202278', masked: 1 })
  })

  it('bare 254 after a word-glued plus keeps the "+" (call+254712345678)', () => {
    expect(scrub('call+254712345678')).toEqual({ scrubbed: 'call+2547\u2022\u2022\u2022\u2022\u2022\u202278', masked: 1 })
  })

  it('phone at the very start and at the very end of the string', () => {
    expect(scrub('0712345678 alifika').scrubbed.startsWith('07\u2022\u2022\u2022\u2022\u2022\u202278')).toBe(true)
    expect(scrub('piga 0712345678').scrubbed.endsWith('07\u2022\u2022\u2022\u2022\u2022\u202278')).toBe(true)
  })
})

describe('mask style is constant (prefix + 6 bullets + last 2 digits)', () => {
  it('masked output is the same length as the digits it replaces and keeps prefix + last 2', () => {
    const { scrubbed } = scrub('0712345678')
    expect(scrubbed).toBe('07\u2022\u2022\u2022\u2022\u2022\u202278')
    expect(scrubbed).toHaveLength(10)
    expect(scrub('+254712345678').scrubbed).toBe('+2547\u2022\u2022\u2022\u2022\u2022\u202278')
    expect(scrub('+254712345678').scrubbed).toHaveLength(13)
    expect(scrub('254712345678').scrubbed).toBe('2547\u2022\u2022\u2022\u2022\u2022\u202278')
    expect(scrub('254712345678').scrubbed).toHaveLength(12)
  })

  it('every mask hides exactly the 6 middle digits — prefix and last 2 stay recognizable', () => {
    // 0712345678: keep "07" + "78", hide 123456 (6 digits)
    expect(scrub('0712345678').scrubbed).not.toContain('123456')
    expect(scrub('+254712345678').scrubbed).not.toContain('123456')
  })
})

describe('amounts, times and references are NOT masked', () => {
  const untouched = [
    '45000',
    'ksh 45000',
    'KES 45,000',
    'jumla 45000 bob',
    '12.5 na 0.5',
    '07:30',
    '07:30:15',
    'kufika 07:30 asubuhi',
    'task 12',
    'task 0712',
    '071234567', // 9 digits — not a full local phone
    '712345678', // 9-digit no-leading-zero form — out of scope by design
    '071234567890', // 12 contiguous digits starting 07 — reference-shaped, no 254 prefix
    '0712345678901', // 13 contiguous digits
    '890712345678', // a "0712345678" substring inside a longer run must not mask
    '0712 345 6789', // contiguous continuation: the 11th digit touches the 10th
    '+25471234567', // 11 digits — not the full international shape
    'piga 0700 kesho asubuhi', // "0700" time-like short run
    'X0712345678Y', // digits welded into a token
    'id0712345678',
  ]
  for (const text of untouched) {
    it(`leaves "${text}" verbatim`, () => {
      expect(scrub(text)).toEqual({ scrubbed: text, masked: 0 })
    })
  }
})

describe('real-world transcript shapes', () => {
  it('mixed Swahili sentence: phone masked, quantity and amount intact', () => {
    const text =
      'Habari, nimepokea bags 80 za cement kutoka Karioke Hardware. ' +
      'Simu yake ni 0712 345 678 kwa malipo. Jumla KES 45000, deliveri 07:30 asubuhi.'
    const { scrubbed, masked } = scrub(text)
    expect(masked).toBe(1)
    expect(scrubbed).toContain('80 za cement')
    expect(scrubbed).toContain('KES 45000')
    expect(scrubbed).toContain('07:30')
    expect(scrubbed).not.toContain('0712 345 678')
    expect(scrubbed).toBe(
      'Habari, nimepokea bags 80 za cement kutoka Karioke Hardware. ' +
        'Simu yake ni 07\u2022\u2022\u2022\u2022\u2022\u202278 kwa malipo. Jumla KES 45000, deliveri 07:30 asubuhi.',
    )
  })

  it('multiple phone numbers in one transcript, mixed forms', () => {
    const { scrubbed, masked } = scrub('Piga 0712345678 ama +254 722 345 678, na ya bosi 254711223344')
    expect(masked).toBe(3)
    expect(scrubbed).toBe('Piga 07\u2022\u2022\u2022\u2022\u2022\u202278 ama +2547\u2022\u2022\u2022\u2022\u2022\u202278, na ya bosi 2547\u2022\u2022\u2022\u2022\u2022\u202244')
  })

  it('quantity then phone, space-separated: the phone masks, the quantity survives', () => {
    expect(scrub('nekta 50 0712345678 kesho')).toEqual({
      scrubbed: 'nekta 50 07\u2022\u2022\u2022\u2022\u2022\u202278 kesho',
      masked: 1,
    })
  })

  it('two space-adjacent phones both mask (documented ambiguity, toward masking)', () => {
    const { scrubbed, masked } = scrub('0712345678 0712345679')
    expect(masked).toBe(2)
    expect(scrubbed).toBe('07\u2022\u2022\u2022\u2022\u2022\u202278 07\u2022\u2022\u2022\u2022\u2022\u202279')
  })

  it('a 10-digit prefix before space + more digits masks the prefix (adjacent-number shape)', () => {
    expect(scrub('0712 345 678 901')).toEqual({ scrubbed: '07\u2022\u2022\u2022\u2022\u2022\u202278 901', masked: 1 })
  })
})

describe('count and idempotency', () => {
  it('empty string and phone-free text return unchanged with masked 0', () => {
    expect(scrub('')).toEqual({ scrubbed: '', masked: 0 })
    expect(scrub('hakuna simu hapa, cement tu')).toEqual({
      scrubbed: 'hakuna simu hapa, cement tu',
      masked: 0,
    })
  })

  it('masked counts every occurrence, including repeats of the same number', () => {
    const { masked } = scrub('simu yangu 0712345678, tena 0712345678, na 0712 345 678')
    expect(masked).toBe(3)
  })

  it('idempotent: scrubbing a scrubbed transcript changes nothing', () => {
    const text = 'Nimepokea cement 20, simu +254 712 345 678 na 0712-345-678, KES 45000'
    const first = scrub(text)
    expect(first.masked).toBe(2)
    const second = scrub(first.scrubbed)
    expect(second).toEqual({ scrubbed: first.scrubbed, masked: 0 })
    // and a third pass stays stable
    expect(scrub(second.scrubbed).scrubbed).toBe(first.scrubbed)
  })
})
