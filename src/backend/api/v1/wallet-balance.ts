import { FINANCE_ROLES } from '@/backend/lib/guard'
import { route } from '@/backend/lib/route-kit'
import { walletWithBalance } from '@/backend/modules/wallet/service'
import { jsonOk } from '@/backend/modules/wallet/http'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { validateQuery, walletRef, walletScopedQuery } from './schemas'
import { mapServiceError, v1Err, V1_READ_LIMIT } from './respond'

// /api/v1/wallets/:id/balance — src/app/api/v1/wallets/[id]/balance/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/wallets/:id/balance — the DERIVED balance of the wallet's
 * backing ledger account (spec §38/§39: balance is never a stored field; it
 * is computed from debit/credit entries every time). Finance/admin only.
 *
 * B5-APIV1: `:id` validated as id-or-code; unknown wallet → 404 (not-found
 * family only — other errors no longer masquerade as 404).
 *
 * Feature flag (spec §81, task 9-a): gated by `wallet` — OFF → 403 for
 * non-admin sessions (admins bypass; see flags.ts).
 */
export const GET = route(
  {
    scope: 'wallets/:id/balance GET',
    roles: FINANCE_ROLES,
    rateLimit: { bucket: 'v1.wallet.balance', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('wallets/:id/balance GET', e, 'Wallet not found'),
  },
  async (req, session, _body, ctx: Ctx) => {
    // Feature flag (spec §81, task 9-a) — the uniform wallet gate.
    const flagDenied = await requireFlagOn('wallet', session)
    if (flagDenied) return flagDenied

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
  },
)
