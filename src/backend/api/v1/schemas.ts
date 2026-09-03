// /api/v1 request validation (spec §64 API QUALITY — validation; B5-APIV1).
// Moved from src/app/api/v1/schemas.ts by the backend reorg (W-BACKEND).
//
// One zod schema set shared by every v1 route. Rules (honest bounds, kept
// aligned with what the wallet service actually accepts):
//   * money amounts: positive number, ≤ 1_000_000_000 (KSh 10^9), max 2 dp
//   * wallet references: id OR human code — the service resolves BOTH
//     (WalletAccount.id is a ~25-char cuid, codes are "W-0001"), so the
//     honest bound is 2–40 chars of [A-Za-z0-9_-], NOT a strict cuid shape
//     (a strict 20–40 rule would reject every valid wallet code).
//   * currency: "KES" only (MjengoOS money is KES-only today)
//   * references: trimmed string ≤ 200 chars; notes ≤ 500
//   * unknown top-level body fields are rejected (typo protection, same
//     policy as the /api/ai/* gate in lib/rate-limit.ts)
//
// Invalid body → 400 { error, field } — rendered by route-kit's body
// pipeline (zodIssueResponse), which absorbed the old validateBody helper
// verbatim: empty body → {}, unparseable JSON → 'Invalid JSON body',
// non-object → 'Body must be a JSON object', first zod issue → the honest
// message + field. Query params are still validated per-route via
// validateQuery below.

import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { zodIssueResponse } from '@/backend/lib/route-kit'

// ---------------------------------------------------------------- primitives

/** Money amount in KES: positive, ≤ 10^9, at most 2 decimal places. */
export const moneyAmount = z
  .number('amount must be a number')
  .positive('amount must be positive')
  .max(1_000_000_000, 'amount must be at most 1000000000')
  .refine((v) => Math.round(v * 100) === v * 100, 'amount supports at most 2 decimal places')

/** Wallet id OR code (service resolves both — see file header). */
export const walletRef = z
  .string('wallet reference must be a string')
  .regex(/^[A-Za-z0-9_-]{2,40}$/, 'wallet reference must be 2-40 characters (wallet id or code, e.g. W-0001)')

/** Project id (cuid) — used as a filter/scope, 1-40 chars. */
export const projectIdRef = z
  .string('projectId must be a string')
  .min(1, 'projectId must not be empty')
  .max(40, 'projectId must be at most 40 characters')

/** KES only — the platform is single-currency today. */
export const kesOnly = z
  .literal('KES', { error: 'currency must be "KES" — MjengoOS money is KES-only today' })
  .optional()

/** Free-text reference (deposit/payment) — trimmed, ≤ 200 chars. */
export const referenceText = z
  .string('reference must be a string')
  .trim()
  .max(200, 'reference must be at most 200 characters')

/** Free-text note — trimmed, ≤ 500 chars. */
export const noteText = z
  .string('note must be a string')
  .trim()
  .max(500, 'note must be at most 500 characters')

// ---------------------------------------------------------------- body schemas

/** POST /api/v1/wallets/:id/deposit */
export const depositBody = z.strictObject({
  amount: moneyAmount,
  source: z.enum(['mpesa', 'bank'], { error: 'source must be "mpesa" or "bank"' }).optional(),
  reference: referenceText.optional(),
  currency: kesOnly,
  projectId: projectIdRef.optional(),
})

/** POST /api/v1/wallets/:id/withdraw — the URL wallet is the source. */
export const withdrawBody = z.strictObject({
  amount: moneyAmount,
  destination: z.enum(['mpesa', 'bank'], { error: 'destination must be "mpesa" or "bank"' }).optional(),
  note: noteText.optional(),
  currency: kesOnly,
  projectId: projectIdRef.optional(),
})

/** POST /api/v1/wallets/:id/transfer — the URL wallet is the SOURCE. */
export const transferBody = z.strictObject({
  toWalletId: walletRef,
  amount: moneyAmount,
  note: noteText.optional(),
  currency: kesOnly,
  projectId: projectIdRef.optional(),
})

/** POST /api/v1/wallets — create a wallet. */
export const walletCreateBody = z.strictObject({
  label: z
    .string('label must be a string')
    .trim()
    .min(1, 'label must not be empty')
    .max(120, 'label must be at most 120 characters')
    .optional(),
  ownerType: z
    .enum(['project', 'organization', 'supplier', 'user'], {
      error: 'ownerType must be one of project, organization, supplier, user',
    })
    .default('project'),
  ownerId: z
    .string('ownerId must be a string')
    .min(1, 'ownerId must not be empty')
    .max(40, 'ownerId must be at most 40 characters')
    .optional(),
  projectId: projectIdRef.optional(),
  currency: kesOnly,
})

/**
 * POST /api/v1/payments — `paymentRequestId` or the legacy `id` alias (both
 * accept the cuid or the human requestCode, e.g. PR-2026-000001, because the
 * route resolves either).
 */
export const paymentPayBody = z
  .strictObject({
    paymentRequestId: z
      .string('paymentRequestId must be a string')
      .min(1, 'paymentRequestId must not be empty')
      .max(40, 'paymentRequestId must be at most 40 characters')
      .optional(),
    id: z
      .string('id must be a string')
      .min(1, 'id must not be empty')
      .max(40, 'id must be at most 40 characters')
      .optional(),
    method: z
      .enum(['mpesa', 'bank', 'card', 'wallet', 'cash'], {
        error: 'method must be one of mpesa, bank, card, wallet, cash',
      })
      .optional(),
    reference: referenceText.optional(),
    costCode: z
      .string('costCode must be a string')
      .trim()
      .max(120, 'costCode must be at most 120 characters')
      .optional(),
  })
  .refine((v) => Boolean(v.paymentRequestId ?? v.id), 'paymentRequestId (or id) required')

// ---------------------------------------------------------------- query schemas

/** Shared list query: limit 1-200 (default 50) + optional id cursor. */
export const listQuery = {
  limit: z
    .coerce.number('limit must be a number')
    .int('limit must be an integer')
    .min(1, 'limit must be between 1 and 200')
    .max(200, 'limit must be between 1 and 200')
    .default(50),
  cursor: z
    .string('cursor must be a string')
    .min(1, 'cursor must not be empty')
    .max(40, 'cursor must be at most 40 characters')
    .optional(),
}

/** GET /api/v1/wallets query (providers=1 switches to the rail surface). */
export const walletsListQuery = z.strictObject({
  projectId: projectIdRef.optional(),
  providers: z.enum(['1'], { error: 'providers must be "1"' }).optional(),
  ...listQuery,
})

/** GET /api/v1/wallets/:id/transactions query. */
export const transactionsQuery = z.strictObject({
  projectId: projectIdRef.optional(),
  ...listQuery,
})

/** GET /api/v1/wallets/:id and /balance query. */
export const walletScopedQuery = z.strictObject({
  projectId: projectIdRef.optional(),
})

// ---------------------------------------------------------------- parse helpers

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: NextResponse }

/** Validate a route's query params against a schema (same 400 contract). */
export function validateQuery<S extends z.ZodType>(
  req: NextRequest,
  schema: S,
): Parsed<z.output<S>> {
  const params: Record<string, string> = {}
  req.nextUrl.searchParams.forEach((value, key) => {
    params[key] = value
  })
  const result = schema.safeParse(params)
  if (!result.success) return { ok: false, response: zodIssueResponse(result.error.issues) }
  return { ok: true, data: result.data }
}
