import { NextRequest, NextResponse } from 'next/server'
import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { depositWallet, walletWithBalance } from '@/modules/wallet/service'
import { jsonErr, withIdempotency } from '@/modules/wallet/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/v1/wallets/:id/deposit — credit the wallet from a cash rail
 * (debit CASH_MPESA/CASH_BANK, credit WALLET:<code>) inside one db.$transaction.
 * Finance/admin only. Idempotency-Key honored. Body:
 *   { amount, source?: 'mpesa'|'bank', reference?, projectId? (for project wallets) }
 */
export const POST = withGuard<Ctx>(async (req, session, ctx) => {
  try {
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const projectId =
      typeof body.projectId === 'string' && body.projectId
        ? body.projectId
        : session.user.projectId ?? ''
    // Resolve the wallet's owning project first so deposits post into the
    // right ledger scope even without an explicit projectId.
    const { wallet } = await walletWithBalance(projectId, id)
    const ownerProjectId = wallet.ownerType === 'project' ? wallet.ownerId ?? projectId : projectId
    return await withIdempotency(req, 'v1.wallet.deposit', ownerProjectId || null, () =>
      depositWallet(ownerProjectId, {
        walletId: id,
        amount: Number(body.amount),
        source: body.source,
        reference: body.reference,
        idempotencyKey: undefined, // handled by withIdempotency / natural keys in the service
        by: session.user.name,
      }),
    )
  } catch (e) {
    console.error('[api/v1/wallets/:id/deposit POST]', e)
    return jsonErr(e instanceof Error ? e.message : 'Deposit failed', 400)
  }
}, { roles: FINANCE_ROLES })
