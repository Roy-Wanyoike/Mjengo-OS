import { withGuard, FINANCE_ROLES } from '@/backend/lib/guard'
import { depositWallet, walletWithBalance } from '@/backend/modules/wallet/service'
import { withIdempotency } from '@/backend/modules/wallet/http'
import { depositBody, validateBody, walletRef } from '../../../schemas'
import { mapServiceError, v1Err, v1Rate, V1_MUTATION_LIMIT } from '../../../respond'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/v1/wallets/:id/deposit — credit the wallet from a cash rail
 * (debit CASH_MPESA/CASH_BANK, credit WALLET:<code>) inside one db.$transaction.
 * Finance/admin only. Idempotency-Key honored. Body (zod-validated, unknown
 * fields rejected):
 *   { amount (positive number ≤ 10^9, max 2dp), source?: 'mpesa'|'bank',
 *     reference? (≤200), currency?: 'KES', projectId? }
 * Invalid body → 400 { error, field } BEFORE the idempotency record or the
 * ledger is touched (failures are never recorded — retries stay possible).
 * Unknown wallet → 404 (was 400 — B5-APIV1 audit fix).
 */
export const POST = withGuard<Ctx>(async (req, session, ctx) => {
  const limited = await v1Rate(req, 'v1.wallet.deposit', V1_MUTATION_LIMIT)
  if (limited) return limited
  try {
    const { id } = await ctx.params
    const idRef = walletRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const parsed = await validateBody(req, depositBody)
    if (!parsed.ok) return parsed.response
    const body = parsed.data
    const projectId = body.projectId ?? session.user.projectId ?? ''
    // Resolve the wallet's owning project first so deposits post into the
    // right ledger scope even without an explicit projectId.
    const { wallet } = await walletWithBalance(projectId, id)
    const ownerProjectId = wallet.ownerType === 'project' ? wallet.ownerId ?? projectId : projectId
    return await withIdempotency(req, 'v1.wallet.deposit', ownerProjectId || null, () =>
      depositWallet(ownerProjectId, {
        walletId: id,
        amount: body.amount,
        source: body.source,
        reference: body.reference,
        idempotencyKey: undefined, // handled by withIdempotency / natural keys in the service
        by: session.user.name,
      }),
    )
  } catch (e) {
    return mapServiceError('wallets/:id/deposit POST', e, 'Deposit failed')
  }
}, { roles: FINANCE_ROLES })
