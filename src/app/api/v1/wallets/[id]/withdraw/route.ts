import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { withdrawWallet, walletWithBalance } from '@/modules/wallet/service'
import { withIdempotency } from '@/modules/wallet/http'
import { validateBody, walletRef, withdrawBody } from '../../../schemas'
import { mapServiceError, v1Err, v1Rate, V1_MUTATION_LIMIT } from '../../../respond'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/v1/wallets/:id/withdraw — debit the wallet into a cash rail
 * (debit WALLET:<code>, credit CASH_MPESA/CASH_BANK) with the balance
 * re-checked INSIDE the transaction. Finance/admin only. Idempotency-Key
 * honored. Body (zod-validated, unknown fields rejected):
 *   { amount (positive number ≤ 10^9, max 2dp), destination?: 'mpesa'|'bank',
 *     note? (≤500), currency?: 'KES', projectId? }
 * Invalid body → 400 { error, field }; unknown wallet → 404 (was 400).
 */
export const POST = withGuard<Ctx>(async (req, session, ctx) => {
  const limited = await v1Rate(req, 'v1.wallet.withdraw', V1_MUTATION_LIMIT)
  if (limited) return limited
  try {
    const { id } = await ctx.params
    const idRef = walletRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const parsed = await validateBody(req, withdrawBody)
    if (!parsed.ok) return parsed.response
    const body = parsed.data
    const projectId = body.projectId ?? session.user.projectId ?? ''
    const { wallet } = await walletWithBalance(projectId, id)
    const ownerProjectId = wallet.ownerType === 'project' ? wallet.ownerId ?? projectId : projectId
    return await withIdempotency(req, 'v1.wallet.withdraw', ownerProjectId || null, () =>
      withdrawWallet(ownerProjectId, {
        walletId: id,
        amount: body.amount,
        destination: body.destination,
        note: body.note,
        by: session.user.name,
      }),
    )
  } catch (e) {
    return mapServiceError('wallets/:id/withdraw POST', e, 'Withdrawal failed')
  }
}, { roles: FINANCE_ROLES })
