import { NextRequest, NextResponse } from 'next/server'
import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { walletWithBalance } from '@/modules/wallet/service'
import { jsonErr } from '@/modules/wallet/http'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/wallets/:id/balance — the DERIVED balance of the wallet's
 * backing ledger account (spec §38/§39: balance is never a stored field; it
 * is computed from debit/credit entries every time). Finance/admin only.
 */
export const GET = withGuard<Ctx>(async (req, _session, ctx) => {
  try {
    const { id } = await ctx.params
    const projectId = req.nextUrl.searchParams.get('projectId') ?? ''
    const { wallet, balance } = await walletWithBalance(projectId, id)
    return NextResponse.json({
      ok: true,
      data: {
        wallet: wallet.code,
        currency: wallet.currency,
        balance,
        derivation: 'ledger entries (debits − credits on the backing liability account)',
      },
    })
  } catch (e) {
    console.error('[api/v1/wallets/:id/balance GET]', e)
    return jsonErr(e instanceof Error ? e.message : 'Wallet not found', 404)
  }
}, { roles: FINANCE_ROLES })
