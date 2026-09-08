import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { derivedBalance } from '@/backend/modules/ledger/service'
import { projectEscrowQuery, projectIdRef, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied } from './scope'

// /api/v1/projects/:id/escrow (Phase C, read-only — the money-governance
// family) — src/app/api/v1/projects/[id]/escrow/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/escrow — the project's escrow position.
 *
 * THE LEDGER NEVER LIES (spec §39 / roadmap §8): `balance` is DERIVED from
 * the ESCROW:<projectId> ledger account's entries (credits − debits on the
 * liability account) — the same derivedBalance() the wallet module and the
 * v1 wallet family use, the ONLY way a balance is known. It is NEVER the
 * stored EscrowWallet.balance projection (which F-MONEY keeps in sync inside
 * the posting transaction — this route simply does not read it, so a drift
 * would surface here honestly instead of being copied).
 *
 * A project whose escrow account does not exist yet (no top-up ever posted —
 * the account is created lazily by the first escrow posting) derives an
 * honest 0; this route never creates the account and never writes anything.
 *
 * NO FEATURE FLAG gates this resource, deliberately: the `wallet` flag gates
 * the user-facing wallet & payment-request surface, but its documented
 * boundary (flags.ts) keeps the escrow governance ladder alive while the
 * flag is off. Mutations (escrow.topup, milestone releases) stay on
 * POST /api/actions, documented in the OpenAPI description.
 *
 * ROLE SCOPING: same as /api/v1/projects/:id (client pinned to their own
 * project, foreign → 403; unknown project → 404). Pagination does not apply
 * (one object). Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/escrow GET',
    rateLimit: { bucket: 'v1.projects.escrow', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/escrow GET', e, 'Project escrow failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectEscrowQuery)
    if (!q.ok) return q.response

    // Unknown project → 404 (an honest "nothing here", not a zero balance).
    const project = await db.project.findUnique({ where: { id } })
    if (!project) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, id)
    if (denied) return denied

    const ledgerAccountCode = `ESCROW:${id}`
    const balance = await derivedBalance(ledgerAccountCode)

    return v1Ok({
      projectId: id,
      currency: 'KES', // MjengoOS money is KES-only today (same honesty as the wallet family)
      balance,
      ledgerAccountCode,
      derivation:
        'ledger entries (credits − debits on the ESCROW:<projectId> liability account) — derived, never the stored EscrowWallet.balance projection',
    })
  },
)
