import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { walletWithBalance } from '@/modules/wallet/service'
import { jsonOk } from '@/modules/wallet/http'
import { validateQuery, walletRef, walletScopedQuery } from '../../../schemas'
import { mapServiceError, v1Err, v1Rate, V1_READ_LIMIT } from '../../../respond'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/wallets/:id/balance — the DERIVED balance of the wallet's
 * backing ledger account (spec §38/§39: balance is never a stored field; it
 * is computed from debit/credit entries every time). Finance/admin only.
 *
 * B5-APIV1: `:id` validated as id-or-code; unknown wallet → 404 (not-found
 * family only — other errors no longer masquerade as 404).
 */
export const GET = withGuard<Ctx>(async (req, _session, ctx) => {
  const limited = await v1Rate(req, 'v1.wallet.balance', V1_READ_LIMIT)
  if (limited) return limited
  try {
    const { id } = await ctx.params
    const idRef = walletRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, walletScopedQuery)
    if (!q.ok) return q.response
    const { wallet, balance } = await walletWithBalance(q.data.projectId ?? '', id)
    return jsonOk({
      wallet: wallet.code,
      currency: wallet.currency,
      balance,
      derivation: 'ledger entries (debits − credits on the backing liability account)',
    })
  } catch (e) {
    return mapServiceError('wallets/:id/balance GET', e, 'Wallet not found')
  }
}, { roles: FINANCE_ROLES })
