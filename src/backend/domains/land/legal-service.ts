import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import type { MjengoSessionUser } from '@/lib/auth'
import { ApiError, badRequest, fieldStr } from '@/backend/core/http'
import { logAudit } from '@/backend/core/audit'
import { getSessionFromReq } from '@/backend/core/guard'

/**
 * Legal review service — scope-honest opinions per parcel.
 *
 * HONESTY RULES
 *  · `coveredChecks` lists EXACTLY what was checked — never blanket assurance.
 *  · `requestedBy` is stamped from the signed-in session (server truth),
 *    never trusted from the request body.
 */

export const SCOPE_CHECKS: Record<string, string> = {
  title: 'Official search certificate; Title deed authenticity; Encumbrances register',
  transfer: 'Stamp duty status; Transfer instrument execution; Consent to transfer',
  diligence: 'Official search certificate; Encumbrances register; Succession status; Boundary reference check',
  dispute: 'Caution register; Active case search (courts); Beacon records',
}

/**
 * List reviews for a parcel.
 * Access: site team → any parcel; client role → their project's parcels;
 * share link → parcels of the project the token unlocks.
 */
export async function listReviews(req: NextRequest) {
  const url = new URL(req.url)
  const parcelId = fieldStr(url.searchParams.get('parcelId'), 'parcelId required')

  const session = await getSessionFromReq(req)
  if (session) {
    if (session.user.role === 'client') {
      const parcel = await db.landParcel.findUnique({ where: { id: parcelId } })
      if (!parcel || parcel.projectId !== session.user.projectId) {
        throw new ApiError(404, 'Parcel not found')
      }
    }
  } else {
    const shareToken = url.searchParams.get('share')
    if (!shareToken) throw new ApiError(401, 'Sign in required')
    const project = await db.project.findUnique({ where: { shareToken } })
    const parcel = await db.landParcel.findUnique({ where: { id: parcelId } })
    if (!project || !parcel || parcel.projectId !== project.id) {
      throw new ApiError(404, 'Invalid share link')
    }
  }

  const reviews = await db.legalReview.findMany({
    where: { parcelId },
    orderBy: { createdAt: 'desc' },
  })
  return { reviews }
}

/**
 * action=request — create a review request for a parcel.
 * The lawyer is assigned deterministically (first verified lawyer on the roll).
 */
export async function requestReview(body: Record<string, unknown>, actor: MjengoSessionUser) {
  const scope = fieldStr(body.scope, 'Pick a review scope (title, transfer, diligence or dispute)')
  if (!SCOPE_CHECKS[scope]) {
    badRequest('Pick a review scope (title, transfer, diligence or dispute)')
  }
  const parcelId = fieldStr(body.parcelId, 'Parcel id required')
  const parcel = await db.landParcel.findUnique({ where: { id: parcelId } })
  if (!parcel) throw new ApiError(404, 'Parcel not found')

  // Deterministically assign a verified lawyer from the registry
  const lawyer = await db.professional.findFirst({
    where: { role: 'lawyer', verified: true },
    orderBy: { name: 'asc' },
  })

  const review = await db.legalReview.create({
    data: {
      parcelId: parcel.id,
      scope,
      requestedBy: actor.name, // server-side truth — the ledger records who asked
      lawyerName: lawyer?.name ?? null,
      lawyerReg: lawyer?.registrationNo ?? null,
      status: 'requested',
      coveredChecks: SCOPE_CHECKS[scope],
    },
  })

  if (parcel.projectId) {
    await logAudit(parcel.projectId, 'legal', actor, `Legal review requested for parcel ${parcel.parcelNo} — scope: ${scope}`)
  }
  return { ok: true, review }
}
