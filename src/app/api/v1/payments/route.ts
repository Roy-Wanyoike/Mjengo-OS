import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { withGuard, PAYMENT_ROLES } from '@/lib/guard'
import { payPaymentRequest } from '@/modules/wallet/service'
import { jsonErr, withIdempotency } from '@/modules/wallet/http'

export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/payments — pay an APPROVED PaymentRequest (spec §38/§57).
 * Guard: finance / admin / client. Client-role sessions may only pay requests
 * on their OWN project (tenant pin). Idempotency-Key honored.
 *
 * Body: { paymentRequestId | id, method?: 'mpesa'|'bank'|'card'|'wallet'|'cash',
 *         reference?, costCode? }
 *
 * The payment runs through the provider seam (spec §40, simulated rails) and
 * posts a balanced double-entry ledger transaction; the legacy Transaction row
 * gains costCode + ledgerTxnId. Every financial transaction is audited via
 * applyAction-style trails (the service notifies + the caller can audit).
 */
export const POST = withGuard(async (req, session) => {
  try {
    const body = await req.json().catch(() => ({}))
    const id = String(body.paymentRequestId ?? body.id ?? '')
    if (!id) return jsonErr('paymentRequestId (or id) required', 400)

    // Resolve the request FIRST so client-role sessions are pinned to their
    // own project before any money moves.
    const request = await db.paymentRequest.findFirst({
      where: { OR: [{ id }, { requestCode: id }] },
    })
    if (!request) return jsonErr('Payment request not found', 404)
    if (session.user.role === 'client') {
      if (!session.user.projectId || session.user.projectId !== request.projectId) {
        return jsonErr('Not permitted for this project', 403)
      }
    }

    const result = await withIdempotency(req, 'v1.payment.pay', request.projectId, () =>
      payPaymentRequest(request.projectId, {
        id: request.id,
        method: body.method,
        reference: body.reference,
        costCode: body.costCode,
        paidBy: session.user.name,
        paidByRole: session.user.role,
      }),
    )
    return result
  } catch (e) {
    console.error('[api/v1/payments POST]', e)
    return jsonErr(e instanceof Error ? e.message : 'Payment failed', 400)
  }
}, { roles: PAYMENT_ROLES })
