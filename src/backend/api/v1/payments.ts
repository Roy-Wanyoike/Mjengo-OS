import { PAYMENT_ROLES } from '@/backend/lib/guard'
import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { payPaymentRequest } from '@/backend/modules/wallet/service'
import { withIdempotency } from '@/backend/modules/wallet/http'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { paymentPayBody } from './schemas'
import { mapServiceError, v1Err, V1_MUTATION_LIMIT } from './respond'

// /api/v1/payments — src/app/api/v1/payments/route.ts is the shim.

/**
 * POST /api/v1/payments — pay an APPROVED PaymentRequest (spec §38/§57).
 * Guard: finance / admin / client. Client-role sessions may only pay requests
 * on their OWN project (tenant pin). Idempotency-Key honored.
 *
 * Body (zod-validated, unknown fields rejected — route-kit's schema mode):
 *   { paymentRequestId | id (cuid or requestCode, e.g. PR-2026-000001),
 *     method?: 'mpesa'|'bank'|'card'|'wallet'|'cash', reference? (≤200),
 *     costCode? (≤120) }
 * Invalid body → 400 { error, field }; unknown request → 404; client paying
 * another project's request → 403 (all pre-existing semantics, unchanged).
 *
 * There is no GET list on /api/v1/payments — pagination does not apply (the
 * money tab pays through /api/actions payment.pay, not this route).
 *
 * The payment runs through the provider seam (spec §40, simulated rails) and
 * posts a balanced double-entry ledger transaction; the legacy Transaction row
 * gains costCode + ledgerTxnId. Every financial transaction is audited via
 * applyAction-style trails (the service notifies + the caller can audit).
 *
 * Feature flag (spec §81, task 9-a): gated by `wallet` — OFF → 403 for
 * non-admin sessions BEFORE the request is resolved or money moves (admins
 * bypass; see flags.ts — internal ledger postings by other flows, e.g.
 * invoice.pay, deliberately stay open while the flag is off).
 */
export const POST = route(
  {
    scope: 'payments POST',
    roles: PAYMENT_ROLES,
    rateLimit: { bucket: 'v1.payments.pay', limit: V1_MUTATION_LIMIT, windowMs: 60_000 },
    body: { schema: paymentPayBody },
    onError: (e) => mapServiceError('payments POST', e, 'Payment failed'),
  },
  async (req, session, body) => {
    // Feature flag (spec §81, task 9-a) — the uniform wallet gate, BEFORE the
    // idempotency record, the request lookup and any money movement.
    const flagDenied = await requireFlagOn('wallet', session)
    if (flagDenied) return flagDenied

    const id = body.paymentRequestId ?? body.id ?? ''

    // Resolve the request FIRST so client-role sessions are pinned to their
    // own project before any money moves.
    const request = await db.paymentRequest.findFirst({
      where: { OR: [{ id }, { requestCode: id }] },
    })
    if (!request) return v1Err(404, 'Payment request not found')
    if (session.user.role === 'client') {
      if (!session.user.projectId || session.user.projectId !== request.projectId) {
        return v1Err(403, 'Not permitted for this project')
      }
    }

    return await withIdempotency(req, 'v1.payment.pay', request.projectId, () =>
      payPaymentRequest(request.projectId, {
        id: request.id,
        method: body.method,
        reference: body.reference,
        costCode: body.costCode,
        paidBy: session.user.name,
        paidByRole: session.user.role,
      }),
    )
  },
)
