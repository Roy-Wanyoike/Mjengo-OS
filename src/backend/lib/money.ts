// Integer-cents money core (issue #122 — "the ledger never lies", DB-1).
//
// THE RULE: money is stored, moved and compared as integer KSh cents
// (`Cents` = bigint). Kenyan Shillings appear ONLY at the boundaries:
//   IN  — HTTP/action payloads (validated ≤ 2 decimal places) → parse*Cents
//   OUT — API/UI responses (centsToKes / centsToKesString) for humans
// Every sum, balance, invariant and money comparison runs in bigint —
// exact by construction, no float tolerance anywhere.
//
// Why bigint and not Int: the platform bound (MAX_MONEY_KES = 1e9, issue
// #241) is 1e11 cents — beyond Int32. SQLite INTEGER is 64-bit; bigint
// round-trips it exactly. The Supabase path (ADR-0002) stores
// NUMERIC(18,2) KSh and converts to cents at the repository boundary —
// both paths share this module as the canonical in-memory form.
//
// Fixes a live defect of the float era: 0.29 * 100 === 28.999999999999996
// in IEEE-754, so the previous `Math.round(v*100) !== v*100` 2-dp check
// spuriously REJECTED valid amounts (0.29, 0.57, 1234567.89 …). The
// toFixed(2) + round-trip-epsilon parse below accepts every true 2-dp
// value and refuses every >2-dp value (0.005, 0.295 …).

/** Canonical money: integer KSh cents. Always bigint, always exact. */
export type Cents = bigint

/** Maximum single money movement, in whole Kenyan Shillings (issue #241). */
export const MAX_MONEY_KES = 1_000_000_000

/** The same bound in cents — the form every service checks against. */
export const MAX_MONEY_CENTS: Cents = 100_000_000_000n

/** Maximum site quantity (bags, tonnes, pieces) — quantities are NOT money. */
export const MAX_QTY = 1_000_000_000

/** Quantities carry at most 3 decimal places (Supabase numeric(18,3) parity). */
export const QTY_DP = 3

const KES_IN_CENTS = 100n
const QTY_SCALE = 1000n // 10^QTY_DP

/**
 * Snap a number that is *expected* to be a clean ≤2-dp KSh value to exact
 * cents (float noise tolerated, silently rounded away). For UNTRUSTED input
 * use parseMoneyCents / parseSignedMoneyCents instead — they refuse >2-dp.
 */
export function snapCents(kes: number): Cents {
  if (!Number.isFinite(kes)) throw new Error(`Cannot convert non-finite amount to cents: ${kes}`)
  return BigInt(Math.round(Number(kes.toFixed(2)) * 100))
}

/**
 * Parse UNTRUSTED input into positive cents. Returns null when the value is
 * not a positive, finite number ≤ MAX_MONEY_KES with at most 2 decimal
 * places. Booleans/objects/arrays are refused (Number() would coerce some).
 * Accepts numbers and numeric strings ("65000.50").
 */
export function parseMoneyCents(v: unknown): Cents | null {
  return parseSigned(v, false)
}

/**
 * Parse UNTRUSTED input into non-negative cents (zero allowed — tax lines,
 * zero-priced items). Same rules otherwise.
 */
export function parseNonNegativeMoneyCents(v: unknown): Cents | null {
  if (v === 0 || v === '0' || v === '0.0' || v === '0.00') return 0n
  return parseMoneyCents(v)
}

/**
 * Parse UNTRUSTED input into signed cents (negative allowed — variation
 * orders record savings as negative budget impact). Same 2-dp / bound rules
 * applied to the absolute value; zero is refused (money must move).
 */
export function parseSignedMoneyCents(v: unknown): Cents | null {
  return parseSigned(v, true)
}

function parseSigned(v: unknown, signed: boolean): Cents | null {
  if (typeof v === 'boolean' || v === null || v === undefined) return null
  if (typeof v === 'object') return null // arrays/Date/objects — Number() would coerce some
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null
  }
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  if (signed ? n === 0 : n <= 0) return null
  const abs = Math.abs(n)
  if (abs > MAX_MONEY_KES) return null
  // 2-dp check that survives IEEE-754: round-trip through toFixed(2) and
  // require the delta to be pure float noise (< 1e-9 KSh).
  const snapped = Number(abs.toFixed(2))
  if (Math.abs(abs - snapped) >= 1e-9) return null
  const cents = BigInt(Math.round(snapped * 100))
  return signed ? BigInt(Math.sign(n)) * cents : cents
}

/** Validating variant that throws the shared honest error (positive only). */
export function assertMoneyCents(v: unknown, field = 'amount'): Cents {
  const c = parseMoneyCents(v)
  if (c === null) throw new Error(`${field}: ${moneyAmountError()}`)
  return c
}

/** Validating variant that throws (signed). */
export function assertSignedMoneyCents(v: unknown, field = 'amount'): Cents {
  const c = parseSignedMoneyCents(v)
  if (c === null) throw new Error(`${field}: ${moneyAmountError(true)}`)
  return c
}

/** Validating variant that throws (zero allowed — tax, rates, zero-priced). */
export function assertNonNegativeMoneyCents(v: unknown, field = 'amount'): Cents {
  const c = parseNonNegativeMoneyCents(v)
  if (c === null) throw new Error(`${field}: must be a non-negative number of at most ${MAX_MONEY_KES} (KSh) with no more than 2 decimal places`)
  return c
}

/** Convert an already-validated KSh number (e.g. zod moneyAmount output) to cents. */
export function kesToCents(kes: number): Cents {
  return assertMoneyCents(kes)
}

/** Convert a validated signed KSh number to cents. */
export function signedKesToCents(kes: number): Cents {
  return assertSignedMoneyCents(kes)
}

/**
 * Cents → KSh number for API/UI responses. Exact for every value within the
 * platform bound (1e11 cents ≪ 2^53): cents/100 with ≤2 dp is exactly
 * representable… as a decimal, and the returned float is the closest
 * double to it — the same double every JSON parser produces for that
 * decimal, so round-trips are stable.
 */
export function centsToKes(c: Cents): number {
  return Number(c) / 100
}

/**
 * Cents → fixed-2dp KSh string ("65000.50"). Use for logs, notifications and
 * anywhere a stable textual form matters more than a number.
 */
export function centsToKesString(c: Cents): string {
  const neg = c < 0n
  const abs = neg ? -c : c
  const whole = abs / KES_IN_CENTS
  const frac = abs % KES_IN_CENTS
  return `${neg ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`
}

/** Human formatting for logs and error messages: "KSh 65,000.50". */
export function fmtKes(c: Cents): string {
  const s = centsToKesString(c)
  const [whole, frac] = s.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `KSh ${grouped}.${frac}`
}

/** Exact sum — the only way money totals are accumulated. */
export function sumCents(values: Iterable<Cents>): Cents {
  let sum = 0n
  for (const v of values) sum += v
  return sum
}

/**
 * Quantity (Float, ≤3 dp) × unit price (cents) → line total in cents.
 * Exact: the quantity is lifted to an integer thousandth first, then the
 * multiply-and-divide runs entirely in bigint with half-up rounding.
 * Refuses non-finite/negative/>3-dp quantities and overflow past the bound.
 */
export function mulQtyCents(qty: number, unitCents: Cents): Cents {
  const milli = parseQtyMilli(qty)
  if (milli === null) throw new Error(`quantity must be a positive number with at most ${QTY_DP} decimal places`)
  const product = unitCents * milli // cents × thousandths
  // half-up division back to cents (product is non-negative: both factors are)
  const cents = (product + 500n) / QTY_SCALE
  if (cents > MAX_MONEY_CENTS) throw new Error(moneyAmountError())
  return cents
}

/**
 * Lift a quantity to an integer number of thousandths (2.5 bags → 2500n).
 * Returns null for non-finite, ≤0, >MAX_QTY or >3-dp values.
 */
export function parseQtyMilli(qty: unknown): bigint | null {
  if (typeof qty === 'boolean' || qty === null || qty === undefined) return null
  if (typeof qty === 'object') return null
  const n = Number(qty)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_QTY) return null
  const snapped = Number(n.toFixed(QTY_DP))
  if (Math.abs(n - snapped) >= 1e-9) return null
  return BigInt(Math.round(snapped * 1000))
}

function moneyAmountError(signed = false): string {
  const sign = signed ? 'non-zero' : 'positive'
  return `amount must be a ${sign} number of at most ${MAX_MONEY_KES} (KSh) with no more than 2 decimal places`
}
