import { NextRequest, NextResponse } from 'next/server'
import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { transferWallet, walletWithBalance } from '@/modules/wallet/service'
import { jsonErr, withIdempotency } from '@/modules/wallet/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST /api/v1/wallets/:id/transfer — move funds between two wallets
 * (debit the source WALLET account, credit the destination) with the balance
 * re-checked INSIDE the transaction. Finance/admin only. Idempotency-Key
 * honored. Body: { toWalletId, amount, note?, projectId? } — the URL wallet
 * is the SOURCE.
 */
export const POST = withGuard<Ctx>(async (req, session, ctx) => {
  try {
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    if (!body.toWalletId) return jsonErr('toWalletId required', 400)
    const projectId =
      typeof body.projectId === 'string' && body.projectId
        ? body.projectId
        : session.user.projectId ?? ''
    const { wallet } = await walletWithBalance(projectId, id)
    const ownerProjectId = wallet.ownerType === 'project' ? wallet.ownerId ?? projectId : projectId
    return await withIdempotency(req, 'v1.wallet.transfer', ownerProjectId || null, () =>
      transferWallet(ownerProjectId, {
        fromWalletId: id,
        toWalletId: String(body.toWalletId),
        amount: Number(body.amount),
        note: body.note,
        by: session.user.name,
      }),
    )
  } catch (e) {
    console.error('[api/v1/wallets/:id/transfer POST]', e)
    return jsonErr(e instanceof Error ? e.message : 'Transfer failed', 400)
  }
}, { roles: FINANCE_ROLES })
