import { NextRequest, NextResponse } from 'next/server'
import { withGuard, FINANCE_ROLES } from '@/backend/lib/guard'
import { createWallet, listWallets } from '@/backend/modules/wallet/service'
import { jsonOk, withIdempotency } from '@/backend/modules/wallet/http'
import { getProvider, PROVIDER_METHODS } from '@/backend/modules/wallet/providers'
import { walletCreateBody, walletsListQuery, validateBody, validateQuery } from '../schemas'
import { mapServiceError, pageOf, v1Err, v1Rate, V1_MUTATION_LIMIT, V1_READ_LIMIT } from '../respond'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/wallets — list wallets (optionally ?projectId=) with
 * ledger-derived balances, or the provider-rail surface with ?providers=1.
 * Finance/admin only (spec §38 — internal finance infrastructure; balances
 * are derived from LedgerEntry, never stored).
 *
 * PAGINATION (B5-APIV1): `?limit` (1-200, default 50) + `?cursor` (wallet id
 * of the last item of the previous page). The response keeps today's
 * contract — `{ ok: true, data: <array> }` — and adds top-level
 * `nextCursor` + `hasMore` (the money-tab UI does not call /api/v1; the
 * consumers are API clients, so `data` stays the array rather than a new
 * `items` key, and the default page already covers every wallet seeded
 * today). The wallet set is bounded, so pagination slices the full
 * code-ordered list in the route layer (listWallets stays read-only).
 * The ?providers=1 branch is a static rail introspection list — pagination
 * does not apply there.
 */
export const GET = withGuard(async (req) => {
  const limited = await v1Rate(req, 'v1.wallets.list', V1_READ_LIMIT)
  if (limited) return limited
  try {
    const q = validateQuery(req, walletsListQuery)
    if (!q.ok) return q.response
    if (q.data.providers === '1') {
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
    const wallets = await listWallets(q.data.projectId)
    const p = pageOf(wallets, q.data.limit, q.data.cursor)
    if (!p.ok) return p.response
    return jsonOk(p.page.items, { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore })
  } catch (e) {
    return mapServiceError('wallets GET', e, 'Failed to list wallets')
  }
}, { roles: FINANCE_ROLES })

/**
 * POST /api/v1/wallets — create a wallet via the wallet.create service.
 * Finance/admin only. Idempotency-Key honored. Body (zod-validated, unknown
 * fields rejected):
 *   { label?, ownerType?: 'project'|'organization'|'supplier'|'user' (default
 *     'project'), ownerId?, projectId?, currency?: 'KES' }
 */
export const POST = withGuard(async (req, session) => {
  const limited = await v1Rate(req, 'v1.wallets.create', V1_MUTATION_LIMIT)
  if (limited) return limited
  try {
    const parsed = await validateBody(req, walletCreateBody)
    if (!parsed.ok) return parsed.response
    const body = parsed.data
    const projectId =
      body.projectId ??
      (body.ownerType === 'project' ? session.user.projectId ?? undefined : undefined)
    // Project wallets need a project (ledger scope); organization / supplier /
    // user wallets are platform-scoped (projectId null) — ownerId is explicit.
    if (!projectId && body.ownerType === 'project') {
      return v1Err(400, 'projectId required for project wallets (body or a project-bound session)', 'projectId')
    }
    return await withIdempotency(req, 'v1.wallet.create', projectId ?? null, () =>
      createWallet(projectId ?? 'platform', body),
    )
  } catch (e) {
    return mapServiceError('wallets POST', e, 'Failed to create wallet')
  }
}, { roles: FINANCE_ROLES })
