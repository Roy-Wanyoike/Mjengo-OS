import { withGuard, FINANCE_ROLES } from '@/backend/lib/guard'
import { transferWallet, walletWithBalance } from '@/backend/modules/wallet/service'
import { withIdempotency } from '@/backend/modules/wallet/http'
import { transferBody, validateBody, walletRef } from '../../../schemas'
import { mapServiceError, v1Err, v1Rate, V1_MUTATION_LIMIT } from '../../../respond'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/v1/wallets/:id/transfer — move funds between two wallets
 * (debit the source WALLET account, credit the destination) with the balance
 * re-checked INSIDE the transaction. Finance/admin only. Idempotency-Key
 * honored. Body (zod-validated, unknown fields rejected):
 *   { toWalletId (id or code, 2-40), amount (positive number ≤ 10^9, max
 *     2dp), note? (≤500), currency?: 'KES', projectId? } — the URL wallet is
 * the SOURCE. Transferring to the same wallet is rejected 422: the request
 * parses but is a no-op money movement (B5-APIV1 — 422 is reserved for
 * structurally-valid-but-nonsensical bodies; insufficient funds stays 400).
 */
export const POST = withGuard<Ctx>(async (req, session, ctx) => {
  const limited = await v1Rate(req, 'v1.wallet.transfer', V1_MUTATION_LIMIT)
  if (limited) return limited
  try {
    const { id } = await ctx.params
    const idRef = walletRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const parsed = await validateBody(req, transferBody)
    if (!parsed.ok) return parsed.response
    const body = parsed.data
    const projectId = body.projectId ?? session.user.projectId ?? ''
    const { wallet } = await walletWithBalance(projectId, id)
    const ownerProjectId = wallet.ownerType === 'project' ? wallet.ownerId ?? projectId : projectId
    // Same-wallet guard BEFORE the idempotency record: a from==to "transfer"
    // would post a balanced no-op ledger txn — honest 422, nothing recorded.
    const sameRef = body.toWalletId === id
    if (!sameRef && wallet.code === body.toWalletId) {
      // id given in URL, code given in the body — still the same wallet.
      return v1Err(422, 'Cannot transfer to the same wallet', 'toWalletId')
    }
    if (sameRef) return v1Err(422, 'Cannot transfer to the same wallet', 'toWalletId')
    return await withIdempotency(req, 'v1.wallet.transfer', ownerProjectId || null, () =>
      transferWallet(ownerProjectId, {
        fromWalletId: id,
        toWalletId: body.toWalletId,
        amount: body.amount,
        note: body.note,
        by: session.user.name,
      }),
    )
  } catch (e) {
    return mapServiceError('wallets/:id/transfer POST', e, 'Transfer failed')
  }
}, { roles: FINANCE_ROLES })
