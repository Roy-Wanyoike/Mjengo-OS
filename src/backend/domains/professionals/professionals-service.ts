import { db } from '@/lib/db'
import type { MjengoSessionUser } from '@/lib/auth'
import { fieldStr, normalizeReference } from '@/backend/core/http'

/**
 * Professionals registry service (lawyers, surveyors, engineers, architects,
 * quantity surveyors) + verify-someone.
 *
 * HONESTY RULES
 *  · A registration number NOT on a board roll returns not_found with a plain
 *    explanation: "unverified is NOT the same as fake — we cannot confirm it".
 *  · A FOUND verification marks the professional verified with its source —
 *    the registry record, not personal opinion.
 *
 * This endpoint is open to every signed-in role ON PURPOSE: a diaspora client
 * verifying their own lawyer's LSK number is exactly the protection this
 * feature exists to provide.
 */

/** GET payload: full directory + recent verification requests. */
export async function listProfessionals() {
  const [professionals, requests] = await Promise.all([
    db.professional.findMany({ orderBy: [{ role: 'asc' }, { name: 'asc' }] }),
    db.verificationRequest.findMany({ orderBy: { requestedAt: 'desc' }, take: 10 }),
  ])
  return { professionals, requests }
}

/**
 * action=verify — look a registration number up on the board rolls.
 * Found → detail + verified flag; not found → honest miss.
 */
export async function verifyRegistration(body: Record<string, unknown>, actor: MjengoSessionUser) {
  const registrationNo = normalizeReference(
    fieldStr(body.registrationNo, 'Enter a registration number to verify'),
  )

  const professional = await db.professional.findFirst({ where: { registrationNo } })

  if (professional) {
    const [request, updated] = await db.$transaction([
      db.verificationRequest.create({
        data: {
          registrationNo,
          entityName: professional.name,
          entityType: 'professional',
          status: 'found',
          resultDetail: `Found on the ${professional.board} roll: ${professional.name}, ${professional.role}, ${professional.county}. Registered ${professional.registrationNo}.`,
          requestedBy: actor.name,
        },
      }),
      db.professional.update({
        where: { id: professional.id },
        data: { verified: true, verifiedAt: new Date(), verificationSource: `${professional.board} registry (simulated)` },
      }),
    ])
    return { ok: true, request, professional: updated }
  }

  // HONEST MISS
  const request = await db.verificationRequest.create({
    data: {
      registrationNo,
      entityType: 'professional',
      status: 'not_found',
      resultDetail: `Registration "${registrationNo}" was not found on any board roll we can check. This does not prove it is fake — it means we cannot confirm it. Verify directly with the board (LSK/BORAQS/EBK) before relying on it.`,
      requestedBy: actor.name,
    },
  })
  return { ok: true, request }
}
