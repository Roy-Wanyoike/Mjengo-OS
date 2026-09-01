import { NextRequest, NextResponse } from 'next/server'
import { withGuard, FINANCE_ROLES } from '@/lib/guard'
import { createWallet, listWallets } from '@/modules/wallet/service'
import { jsonErr, withIdempotency } from '@/modules/wallet/http'
import { getProvider, PROVIDER_METHODS } from '@/modules/wallet/providers'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/wallets — list wallets (optionally ?projectId=) with
 * ledger-derived balances, or the provider-rail surface with ?providers=1.
 * Finance/admin only (spec §38 — internal finance infrastructure; balances
 * are derived from LedgerEntry, never stored).
 */
export const GET = withGuard(async (req) => {
  try {
    if (req.nextUrl.searchParams.get('providers') === '1') {
      // Payment-rail seam introspection (spec §40) — every provider honestly
      // reports its integration state (simulated).
      return NextResponse.json({
        ok: true,
        data: PROVIDER_METHODS.map((m) => {
          const p = getProvider(m)
          return { method: m, provider: p.id, label: p.label, integrationNote: p.integrationNote }
        }),
      })
    }
    const projectId = req.nextUrl.searchParams.get('projectId') ?? undefined
    const wallets = await listWallets(projectId || undefined)
    return NextResponse.json({ ok: true, data: wallets })
  } catch (e) {
    console.error('[api/v1/wallets GET]', e)
    return jsonErr(e instanceof Error ? e.message : 'Failed to list wallets', 500)
  }
}, { roles: FINANCE_ROLES })

/**
 * POST /api/v1/wallets — create a wallet via the wallet.create service.
 * Finance/admin only. Idempotency-Key honored. Body:
 *   { label, ownerType?: 'project'|'organization'|'supplier'|'user', ownerId?, projectId? }
 */
export const POST = withGuard(async (req, session) => {
  try {
    const body = await req.json().catch(() => ({}))
    const ownerType = String(body.ownerType ?? 'project')
    const projectId =
      typeof body.projectId === 'string' && body.projectId
        ? body.projectId
        : ownerType === 'project'
          ? session.user.projectId ?? undefined
          : undefined
    // Project wallets need a project (ledger scope); organization / supplier /
    // user wallets are platform-scoped (projectId null) — ownerId is explicit.
    if (!projectId && ownerType === 'project') {
      return jsonErr('projectId required for project wallets (body or a project-bound session)', 400)
    }
    return await withIdempotency(req, 'v1.wallet.create', projectId ?? null, () =>
      createWallet(projectId ?? 'platform', body),
    )
  } catch (e) {
    console.error('[api/v1/wallets POST]', e)
    return jsonErr(e instanceof Error ? e.message : 'Failed to create wallet', 400)
  }
}, { roles: FINANCE_ROLES })
