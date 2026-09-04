/**
 * PII scrubbing for voice-log transcripts (issue "Voice-log transcript PII
 * scrubbing", task 8-b).
 *
 * WHAT THIS MASKS — Kenyan mobile phone numbers in the four canonical shapes,
 * each with optional single spaces/hyphens between digit groups (any
 * grouping: "0712 345 678", "+254-712-345-678", "254 712 345 678"):
 *   · 07XXXXXXXX / 01XXXXXXXX         (10 digits, local — Safaricom/Airtel/Telkom)
 *   · +2547XXXXXXXX / +2541XXXXXXXX   (12 digits + "+", international)
 *   · 2547XXXXXXXX / 2541XXXXXXXX     (12 digits, country code without "+")
 *
 * MASK STYLE (constant, pinned by tests): keep the recognizable prefix and
 * the last 2 digits, replace every other digit with "•" —
 *   0712345678     → 07••••••78
 *   +254712345678  → +2547••••••78
 *   254712345678   → 2547••••••78
 * Both shapes mask exactly 6 middle digits, so the masked output keeps the
 * input's length ("my number is 07••••••78" stays recognizable as *that*
 * number while the full number is unrecoverable). Internal spaces/hyphens
 * are dropped: the mask is the canonical contiguous form of the number.
 *
 * WHAT IS DELIBERATELY NOT MASKED — false-positive guards (each pinned in
 * tests/unit/pii-scrub.test.ts):
 *   · Amounts/quantities ("45000", "ksh 45000", "45,000", "12.5"): no
 *     0[17]/254 prefix and never 10+ digits.
 *   · Times ("07:30", "07:30:15"): a colon is not a legal separator between
 *     phone digit groups, so the digit run breaks at the colon.
 *   · Longer digit runs, contiguous or space/hyphen-then-contiguous
 *     ("071234567890", "0712 345 6789", "890712345678"): a match must be
 *     exactly 10 digits (local) or 12 (254-form) AND not glued to any other
 *     digit — a digit immediately after the 10th digit refuses the match, so
 *     a substring of a reference/account number can never pose as a phone.
 *   · Digit runs glued to letters ("X0712345678Y", "id0712345678"): a real
 *     phone in natural speech is delimited by spaces or punctuation, never
 *     welded into a larger token.
 *   · The 9-digit "no leading zero" form ("712345678"): out of scope — it is
 *     indistinguishable from any other 9-digit run, and this module's brief
 *     pins the four canonical shapes above.
 *
 * DOCUMENTED AMBIGUITY (resolved toward masking): when a phone-shaped
 * 10-digit run is followed by MORE digits after a space ("0712 345 678 901"),
 * the phone-shaped prefix is masked and the tail left verbatim. The same
 * shape also carries two adjacent numbers ("0712345678 0712345679"), which
 * must BOTH mask, so the pattern cannot also require "not followed by
 * space+digit". Contiguous continuation always blocks the match, and
 * quantity-then-phone ("50 0712345678") always masks the phone.
 *
 * WHERE IT RUNS (the PII boundary): scrubTranscriptPhones is applied where a
 * transcript ENTERS the system, before anything else sees it —
 *   1. src/app/api/ai/voice-log/route.ts, immediately after ASR;
 *   2. src/backend/lib/ai.ts parseDeliveryTranscript — the shared parse seam
 *      (also covers /api/ai/parse-text), so the LLM prompt itself is
 *      scrubbed: the raw number never leaves the process, and LLM-derived
 *      fields (supplier/notes/items) cannot echo what the model never saw.
 * Both layers call this pure function; it is idempotent, so re-scrubbing an
 * already-scrubbed transcript is a no-op. Everything downstream — the HTTP
 * response, the rawTranscript the copilot UI persists via delivery.create,
 * the offline mirror and the deliveries tooltip — only ever sees the masked
 * form because the only producer of that transcript field is this boundary.
 *
 * SCOPING DECISION (honest): names, locations and other personal detail are
 * NOT masked. Field notes are operator-private speech about the operator's
 * own crew, site and suppliers, and the supplier name is operationally
 * required by the delivery parser. This module targets the one PII class
 * that is both high-likelihood (people dictate phone numbers into notes) and
 * high-harm when captured verbatim: the full phone number. Widening scope
 * (names, national IDs, …) is a deliberate product decision, not a regex.
 */

/**
 * One optional separator between phone digits: a single space or hyphen.
 * Deliberately NOT: colon (times "07:30"), dot (decimals "12.5"), comma
 * (thousands "45,000"), slash (dates) or parentheses — none of those occur
 * inside a dictated Kenyan phone, and each of them breaks the digit run so
 * time/amount/date shapes can never assemble a phone pattern.
 */
const SEP = '[ -]?'

/**
 * Boundary assertion (lookbehind-free, ES2017-safe): a phone must not be
 * glued to other digits or letters. The character BEFORE the number is
 * captured and re-emitted verbatim, so masking never eats punctuation or
 * spacing that belongs to the sentence. The trailing side uses a plain
 * lookahead.
 */
const BOUNDARY_L = '(^|[^0-9A-Za-z])'
const BOUNDARY_R = '(?![0-9A-Za-z])'

/**
 * The four phone shapes, most specific first: "+254…" must be consumed
 * before the bare "254…" pattern can match the digits behind the "+".
 * Each pattern captures (boundary, phoneRun) and requires the full digit
 * count — 8 digits after "07"/"01"/"+2547"/"2547" — with no digit glued to
 * either end of the match.
 */
const PHONE_PATTERNS: RegExp[] = [
  new RegExp(`${BOUNDARY_L}(\\+254${SEP}[17](?:${SEP}\\d){8})${BOUNDARY_R}`, 'g'),
  new RegExp(`${BOUNDARY_L}(254${SEP}[17](?:${SEP}\\d){8})${BOUNDARY_R}`, 'g'),
  new RegExp(`${BOUNDARY_L}(0[17](?:${SEP}\\d){8})${BOUNDARY_R}`, 'g'),
]

const MASK_CHAR = '•'

/**
 * Mask one matched phone run: keep the prefix ("07"/"01" for local,
 * "2547"/"2541" — plus a leading "+" when present — for the 254 forms) and
 * the last 2 digits; every remaining digit becomes a bullet. The run arrives
 * from PHONE_PATTERNS, so its digit count is 10 or 12 by construction.
 */
function maskPhone(run: string): string {
  const plus = run.startsWith('+') ? '+' : ''
  const digits = run.replace(/[^0-9]/g, '')
  const keep = digits.length === 12 ? 4 : 2
  return plus + digits.slice(0, keep) + MASK_CHAR.repeat(digits.length - keep - 2) + digits.slice(-2)
}

/**
 * Mask Kenyan phone numbers in a transcript (see module header for the
 * exact shapes, false-positive guards and scoping decision).
 *
 * @returns `scrubbed` — the transcript with every phone number replaced by
 *            its mask (identical string when nothing matched), and `masked`
 *            — how many phone numbers were masked (0 when unchanged).
 *          Idempotent: scrubbing an already-scrubbed transcript returns it
 *          unchanged with `masked: 0`.
 */
export function scrubTranscriptPhones(text: string): { scrubbed: string; masked: number } {
  let out = text
  let masked = 0
  for (const pattern of PHONE_PATTERNS) {
    out = out.replace(pattern, (_match: string, boundary: string, run: string) => {
      masked += 1
      return boundary + maskPhone(run)
    })
  }
  return { scrubbed: out, masked }
}
