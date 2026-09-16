// Shared money-amount bounds (issue #241 — QA found a KSh ~1e12 top-up persisted).
//
// WHY THIS EXISTS: the legacy action appliers (escrow.topup, milestone.create,
// expense.create, wallet deposit/withdraw/transfer, payment.request, manual
// ledger lines) validated only `amount > 0` — no upper bound, no 2-dp check.
// The v1 REST family already enforced exactly this contract via zod
// (schemas.ts moneyAmount); this module single-sources the rule so both
// surfaces share one constant and one message.
//
// The bound: KSh 1,000,000,000 (one billion) per single money movement —
// generous for real Kenyan construction transactions (even large developments
// move money in installs far below this), while making garbage inputs
// (the QA repro: 999,999,999,999) impossible to persist. Tighten by editing
// MAX_MONEY_KES in one place.

/** Maximum single money movement, in whole Kenyan Shillings. */
export const MAX_MONEY_KES = 1_000_000_000

/** The one honest message every money path shares when an amount is refused. */
export const MONEY_AMOUNT_ERROR = `amount must be a positive number of at most ${MAX_MONEY_KES} (KSh) with no more than 2 decimal places`

/**
 * Parse and validate a money amount (KSh). Returns the validated number, or
 * null when the value is not a positive, finite, ≤ MAX_MONEY_KES number with
 * at most 2 decimal places. Booleans/objects/arrays are refused (Number()
 * would happily coerce some of them).
 */
export function parseMoneyAmount(v: unknown): number | null {
  if (typeof v === 'boolean' || v === null || v === undefined) return null
  if (typeof v === 'object') return null // arrays/Date/objects — Number() would coerce some
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_MONEY_KES) return null
  if (Math.round(n * 100) !== n * 100) return null
  return n
}

/**
 * Validating variant for appliers that prefer throwing: parses with
 * parseMoneyAmount and throws the shared honest error on refusal.
 */
export function assertMoneyAmount(v: unknown, field = 'amount'): number {
  const n = parseMoneyAmount(v)
  if (n === null) throw new Error(`${field}: ${MONEY_AMOUNT_ERROR}`)
  return n
}
