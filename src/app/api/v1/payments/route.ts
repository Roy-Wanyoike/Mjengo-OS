import { withGuard, PAYMENT_ROLES } from '@/lib/guard'
import { db } from '@/lib/db'
import { payPaymentRequest } from '@/modules/wallet/service'
import { withIdempotency } from '@/modules/wallet/http'
import { paymentPayBody, validateBody } from '../schemas'
import { mapServiceError, v1Err, v1Rate, V1_MUTATION_LIMIT } from '../respond'

export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/payments — pay an APPROVED PaymentRequest (spec §38/§57).
 * Guard: finance / admin / client. Client-role sessions may only pay requests
 * on their OWN project (tenant pin). Idempotency-Key honored.
 *
 * Body (zod-validated, unknown fields rejected):
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
 */
export const POST = withGuard(async (req, session) => {
  const limited = await v1Rate(req, 'v1.payments.pay', V1_MUTATION_LIMIT)
  if (limited) return limited
  try {
    const parsed = await validateBody(req, paymentPayBody)
    if (!parsed.ok) return parsed.response
    const body = parsed.data
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
  } catch (e) {
    return mapServiceError('payments POST', e, 'Payment failed')
  }
}, { roles: PAYMENT_ROLES })
