import { FINANCE_ROLES } from '@/backend/lib/guard'
import { route } from '@/backend/lib/route-kit'
import { depositWallet, walletWithBalance } from '@/backend/modules/wallet/service'
import { withIdempotency } from '@/backend/modules/wallet/http'
import { depositBody, walletRef } from './schemas'
import { mapServiceError, v1Err, V1_MUTATION_LIMIT } from './respond'

// /api/v1/wallets/:id/deposit — src/app/api/v1/wallets/[id]/deposit/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/v1/wallets/:id/deposit — credit the wallet from a cash rail
 * (debit CASH_MPESA/CASH_BANK, credit WALLET:<code>) inside one db.$transaction.
 * Finance/admin only. Idempotency-Key honored. Body (zod-validated, unknown
 * fields rejected — route-kit's schema mode):
 *   { amount (positive number ≤ 10^9, max 2dp), source?: 'mpesa'|'bank',
 *     reference? (≤200), currency?: 'KES', projectId? }
 * Invalid body → 400 { error, field } BEFORE the idempotency record or the
 * ledger is touched (failures are never recorded — retries stay possible).
 * Unknown wallet → 404 (was 400 — B5-APIV1 audit fix).
 */
export const POST = route(
  {
    scope: 'wallets/:id/deposit POST',
    roles: FINANCE_ROLES,
    rateLimit: { bucket: 'v1.wallet.deposit', limit: V1_MUTATION_LIMIT, windowMs: 60_000 },
    body: { schema: depositBody },
    onError: (e) => mapServiceError('wallets/:id/deposit POST', e, 'Deposit failed'),
  },
  async (req, session, body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = walletRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
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
  },
)
