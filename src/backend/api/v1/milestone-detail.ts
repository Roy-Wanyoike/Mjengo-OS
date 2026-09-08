import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { milestoneSummary, parseEvidencePhotoIds } from './milestone-rows'
import { milestoneDetailQuery, milestoneIdRef, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierProjectDenied } from './scope'

// /api/v1/milestones/:id (Phase C, read-only — the money-governance family) —
// src/app/api/v1/milestones/[id]/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/milestones/:id — one milestone with its full ladder:
 *
 *   · STATUS LADDER TIMESTAMPS — requestedAt / decidedAt / releasedAt (null
 *     until the milestone reaches that rung; there is no evidenceSubmittedAt
 *     column — that rung's honest signal is status 'evidence_submitted' plus
 *     the evidencePhotoIds it carries).
 *   · EVIDENCE PHOTO IDS — the parsed Milestone.evidencePhotoIds array
 *     (SitePhoto IDS ONLY, no bytes and no storage URLs — the same honesty
 *     rule as the v1 supply photos).
 *   · DECISION HISTORY — decidedAt / decidedBy / decisionNote (the client's
 *     approve/reject record; rejected milestones keep theirs forever).
 *   · RELEASE LEDGER — the Transaction row the runtime release posts
 *     (type 'milestone', reference MJP-<id tail>, the A-1-lite convention),
 *     so a released milestone carries its own money proof. NULL when the
 *     release predates the ledger convention (seeded pre-ledger history) or
 *     the milestone is not released — honest, never fabricated.
 *
 * Read-only — mutations stay on POST /api/actions (milestone.decide), the
 * OpenAPI description says so. NO FEATURE FLAG (the wallet flag's documented
 * boundary keeps the release ladder alive while it is off — flags.ts).
 *
 * ROLE SCOPING: resolve first, pin second (the v1 payments precedent) — the
 * milestone resolves by id (cuid; milestones carry no human code), then a
 * client-role session must be pinned to the milestone's own project (else
 * 403 'Not permitted for this project'). Unknown milestone → 404.
 *
 * DATA: the milestones module has no public single-milestone read (money.ts
 * reads rows directly), so the detail row is read here with the same columns
 * — the wallet-transactions precedent ("route-layer implementation; the
 * module is left untouched"). Pagination does not apply (one object).
 * Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'milestones/:id GET',
    rateLimit: { bucket: 'v1.milestone.get', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('milestones/:id GET', e, 'Milestone detail failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = milestoneIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, milestoneDetailQuery)
    if (!q.ok) return q.response

    const milestone = await db.milestone.findFirst({ where: { id } })
    if (!milestone) return v1Err(404, 'Milestone not found')
    const denied = clientProjectDenied(session, milestone.projectId)
    if (denied) return denied
    // W5-3: supplier sessions are not project readers (their surface is the
    // supplier-owned rows). Uniform 403 — no project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    // Phase name join (the payload's phases carry names; a single-row read
    // joins it directly — null phaseId or a vanished phase stays null).
    const phase = milestone.phaseId
      ? await db.phase.findUnique({ where: { id: milestone.phaseId }, select: { name: true } })
      : null

    // The release's ledger proof — money.ts releaseMilestoneAtomic writes
    // exactly one Transaction row per runtime release (reference MJP-<id
    // tail>, the convention computeLedgerConsistency matches on). Seeded
    // pre-ledger releases have none → honest null.
    const releaseTxn = milestone.status === 'released'
      ? await db.transaction.findFirst({
          where: { type: 'milestone', reference: `MJP-${milestone.id.slice(-6)}` },
          orderBy: { date: 'desc' },
        })
      : null

    return v1Ok({
      ...milestoneSummary(milestone, phase?.name ?? null),
      projectId: milestone.projectId,
      evidencePhotoIds: parseEvidencePhotoIds(milestone.evidencePhotoIds),
      decidedBy: milestone.decidedBy,
      decisionNote: milestone.decisionNote,
      releaseLedger: releaseTxn
        ? {
            transactionId: releaseTxn.id,
            reference: releaseTxn.reference,
            amount: releaseTxn.amount,
            method: releaseTxn.method,
            ledgerTxnId: releaseTxn.ledgerTxnId,
            costCode: releaseTxn.costCode,
            date: releaseTxn.date.toISOString(),
            note: releaseTxn.note,
          }
        : null,
    })
  },
)
