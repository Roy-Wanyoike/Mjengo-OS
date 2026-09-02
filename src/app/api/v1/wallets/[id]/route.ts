import { NextRequest } from 'next/server'
import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { walletWithBalance } from '@/modules/wallet/service'
import { jsonOk } from '@/modules/wallet/http'
import { validateQuery, walletRef, walletScopedQuery } from '../../schemas'
import { mapServiceError, v1Err, v1Rate, V1_READ_LIMIT } from '../../respond'

export const dynamic = 'force-dynamic'

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/wallets/:id — one wallet (id or code) with its ledger-derived
 * balance (spec §38/§39). Finance/admin only.
 *
 * B5-APIV1: `:id` is validated as a wallet id-or-code (2-40 chars — codes
 * like W-0001 are a documented lookup path, so a strict 20-40 cuid rule
 * would reject them); unknown wallet → 404 (was a catch-all 404 before —
 * now only the not-found family maps to 404, business errors 400).
 */
export const GET = withGuard<Ctx>(async (req, _session, ctx) => {
  const limited = await v1Rate(req, 'v1.wallet.get', V1_READ_LIMIT)
  if (limited) return limited
  try {
    const { id } = await ctx.params
    const idRef = walletRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, walletScopedQuery)
    if (!q.ok) return q.response
    const { wallet, balance } = await walletWithBalance(q.data.projectId ?? '', id)
    return jsonOk({
      id: wallet.id,
      code: wallet.code,
      label: wallet.label,
      ownerType: wallet.ownerType,
      ownerId: wallet.ownerId,
      currency: wallet.currency,
      status: wallet.status,
      ledgerAccountId: wallet.ledgerAccountId,
      balance, // derived from ledger entries — never a stored field
    })
  } catch (e) {
    return mapServiceError('wallets/:id GET', e, 'Wallet not found')
  }
}, { roles: FINANCE_ROLES })
