import { FINANCE_ROLES } from '@/backend/lib/guard'
import { route } from '@/backend/lib/route-kit'
import { withdrawWallet, walletWithBalance } from '@/backend/modules/wallet/service'
import { withIdempotency } from '@/backend/modules/wallet/http'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { withdrawBody, walletRef } from './schemas'
import { mapServiceError, v1Err, V1_MUTATION_LIMIT } from './respond'

// /api/v1/wallets/:id/withdraw — src/app/api/v1/wallets/[id]/withdraw/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/v1/wallets/:id/withdraw — debit the wallet into a cash rail
 * (debit WALLET:<code>, credit CASH_MPESA/CASH_BANK) with the balance
 * re-checked INSIDE the transaction. Finance/admin only. Idempotency-Key
 * honored. Body (zod-validated, unknown fields rejected — route-kit's
 * schema mode):
 *   { amount (positive number ≤ 10^9, max 2dp), destination?: 'mpesa'|'bank',
 *     note? (≤500), currency?: 'KES', projectId? }
 * Invalid body → 400 { error, field }; unknown wallet → 404 (was 400).
 *
 * Feature flag (spec §81, task 9-a): gated by `wallet` — OFF → 403 for
 * non-admin sessions (admins bypass; see flags.ts).
 */
export const POST = route(
  {
    scope: 'wallets/:id/withdraw POST',
    roles: FINANCE_ROLES,
    rateLimit: { bucket: 'v1.wallet.withdraw', limit: V1_MUTATION_LIMIT, windowMs: 60_000 },
    body: { schema: withdrawBody },
    onError: (e) => mapServiceError('wallets/:id/withdraw POST', e, 'Withdrawal failed'),
  },
  async (req, session, body, ctx: Ctx) => {
    // Feature flag (spec §81, task 9-a) — the uniform wallet gate, BEFORE the
    // idempotency record and any ledger write.
    const flagDenied = await requireFlagOn('wallet', session)
    if (flagDenied) return flagDenied

    const { id } = await ctx.params
    const idRef = walletRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
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
  },
)
