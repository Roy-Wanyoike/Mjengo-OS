import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import type { MjengoSessionUser } from '@/lib/auth'
import { ApiError, badRequest, fieldStr, fieldPos, notFound, normalizeReference, optionalId } from '@/backend/core/http'
import { logAudit } from '@/backend/core/audit'
import { getSessionFromReq } from '@/backend/core/guard'

/**
 * LandVerify service — parcels, honest title searches, surveyor directory,
 * parcel registry history.
 *
 * HONESTY RULES
 *  · An unknown title/parcel number returns an HONEST MISS (found:false) plus
 *    the pointer to the only authoritative sources (Ministry of Lands /
 *    Ardhisasa). The app never guesses.
 *  · The registry is simulated and every response says so.
 *
 * ACCESS SCOPING (production hardening)
 *  · site team (contractor/admin) — sees any project's parcels
 *  · client role — pinned to THEIR project (client-projectId), regardless of
 *    what projectId they pass
 *  · share links — pinned to the project the token unlocks
 */

export const REGISTRY_SOURCE = 'eRegistry (simulated)'

type ReadScope =
  | { kind: 'site'; projectId: string | null }
  | { kind: 'client'; projectId: string }

/**
 * Resolve read scope for a request: session beats share token; clients and
 * share links are pinned to one project. Throws 401/404 for anonymous access
 * with a missing/invalid token.
 */
export async function resolveReadScope(req: NextRequest): Promise<ReadScope> {
  const url = new URL(req.url)
  const session = await getSessionFromReq(req)
  if (session) {
    if (session.user.role === 'client') {
      return { kind: 'client', projectId: session.user.projectId ?? '' }
    }
    return { kind: 'site', projectId: url.searchParams.get('projectId') }
  }
  const shareToken = url.searchParams.get('share')
  if (!shareToken) throw new ApiError(401, 'Sign in required')
  const project = await db.project.findUnique({ where: { shareToken } })
  if (!project) throw new ApiError(404, 'Invalid share link')
  return { kind: 'client', projectId: project.id }
}

/** GET payload: parcels (scoped), surveyors, recent title searches. */
export async function listLandData(req: NextRequest) {
  const scope = await resolveReadScope(req)
  const [parcels, surveyors, searches] = await Promise.all([
    db.landParcel.findMany({
      where: scope.projectId ? { projectId: scope.projectId } : undefined,
      include: { documents: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.surveyor.findMany({ orderBy: { name: 'asc' } }),
    db.titleSearch.findMany({
      orderBy: { searchedAt: 'desc' },
      take: 10,
      include: { parcel: { select: { parcelNo: true } } },
    }),
  ])
  return { parcels, surveyors, searches }
}

/**
 * action=title.search — case/whitespace-normalized lookup with a
 * punctuation-insensitive fallback (Kenyan titles are written "I.R. 118923",
 * "IR 118923", "ir118923" — all must find the same record, because a false
 * miss on an existing parcel is the scariest answer this product can give).
 * FOUND → registry summary; NOT FOUND → honest miss with the official pointer.
 */
export async function searchTitle(body: Record<string, unknown>, actor: MjengoSessionUser) {
  const query = normalizeReference(fieldStr(body.query, 'Enter a title or parcel number to search'))

  let parcel = await db.landParcel.findFirst({
    where: { OR: [{ parcelNo: query }, { titleNo: query }] },
  })
  if (!parcel) {
    // Fallback: same reference, different punctuation/spacing
    const squashed = query.replace(/[.\s]/g, '')
    if (squashed.length >= 4) {
      const candidates = await db.landParcel.findMany({
        select: { id: true, parcelNo: true, titleNo: true },
      })
      const hit = candidates.find(
        (c) =>
          c.parcelNo.replace(/[.\s]/g, '') === squashed ||
          (c.titleNo ?? '').replace(/[.\s]/g, '') === squashed,
      )
      if (hit) parcel = await db.landParcel.findUnique({ where: { id: hit.id } })
    }
  }

  if (parcel) {
    const search = await db.titleSearch.create({
      data: {
        parcelId: parcel.id,
        query,
        found: true,
        resultSummary: `Found: parcel ${parcel.parcelNo}${parcel.titleNo ? `, title ${parcel.titleNo}` : ''}, ${parcel.sizeAcres} acres, ${parcel.location}, ${parcel.county} — registered to ${parcel.ownerName}. Status: ${parcel.status}.`,
        source: REGISTRY_SOURCE,
        searchedBy: actor.name,
      },
    })
    if (parcel.projectId) {
      await logAudit(parcel.projectId, 'land', actor, `Registry search "${query}" — found (${parcel.status})`)
    }
    return { ok: true, search }
  }

  // HONEST MISS — the product's core promise
  const search = await db.titleSearch.create({
    data: {
      parcelId: null,
      query,
      found: false,
      resultSummary: `No record found for "${query}" in the registry. We do not guess — an official search at the Ministry of Lands or Ardhisasa is the only authoritative source.`,
      source: REGISTRY_SOURCE,
      searchedBy: actor.name,
    },
  })
  return { ok: true, search }
}

/**
 * Parcel registry event history (read-only).
 * Scoping: site team → any parcel; client role → their project's parcels;
 * share link → parcels of the project the token unlocks. A mismatched parcel
 * is indistinguishable from an invalid link (404) — no cross-project probing.
 */
export async function listParcelEvents(req: NextRequest) {
  const url = new URL(req.url)
  const parcelId = fieldStr(url.searchParams.get('parcelId'), 'parcelId required')

  const session = await getSessionFromReq(req)
  let allowedProjectId: string | null | undefined = undefined // undefined = unrestricted (site team)

  if (session) {
    if (session.user.role === 'client') allowedProjectId = session.user.projectId ?? null
  } else {
    const shareToken = url.searchParams.get('share')
    if (!shareToken) throw new ApiError(401, 'Sign in required')
    const project = await db.project.findUnique({ where: { shareToken } })
    if (!project) throw new ApiError(404, 'Invalid share link')
    allowedProjectId = project.id
  }

  const parcel = await db.landParcel.findUnique({ where: { id: parcelId } })
  if (allowedProjectId !== undefined) {
    if (!parcel || parcel.projectId !== allowedProjectId) {
      throw new ApiError(404, 'Invalid share link')
    }
  }

  const events = await db.parcelEvent.findMany({
    where: { parcelId },
    orderBy: { eventDate: 'desc' },
  })
  return { events }
}

/* ------------------------------------------------------------------ *
 * PROPERTY PASSPORT (spec §13)                                        *
 * A consolidated per-parcel view COMPILED from records already in     *
 * MjengoOS — registry record, searches, events, documents, legal      *
 * reviews, linked build. It is explicitly NOT a government            *
 * certificate; the UI and the PDF export both say so.                 *
 * ------------------------------------------------------------------ */

/** Budget-weighted build progress — same math as lib/mjengo.ts overallProgress. */
function passportProgress(
  phases: Array<{ budget: number; progressManual: number | null; tasks: Array<{ progress: number }> }>,
): number {
  const phasePct = (p: { progressManual: number | null; tasks: Array<{ progress: number }> }) => {
    if (p.progressManual !== null && p.progressManual !== undefined) return p.progressManual
    if (!p.tasks.length) return 0
    return Math.round(p.tasks.reduce((s, t) => s + t.progress, 0) / p.tasks.length)
  }
  const totalBudget = phases.reduce((s, p) => s + p.budget, 0)
  if (!totalBudget) return 0
  return Math.round(
    (phases.reduce((s, p) => s + (phasePct(p) / 100) * p.budget, 0) / totalBudget) * 100,
  )
}

/**
 * GET ?passport=1&parcelId=… — everything the Property Passport renders,
 * in one read. Scoping identical to the rest of the land surface: site
 * team → any parcel; client role + share links → their project's parcels
 * only (a foreign parcelId is indistinguishable from a miss).
 */
export async function getParcelPassport(req: NextRequest) {
  const url = new URL(req.url)
  const parcelId = fieldStr(url.searchParams.get('parcelId'), 'parcelId required')
  const scope = await resolveReadScope(req)

  const parcel = await db.landParcel.findUnique({
    where: { id: parcelId },
    include: {
      documents: { orderBy: { uploadedAt: 'desc' } },
      events: { orderBy: { eventDate: 'desc' } },
      legalReviews: { orderBy: { createdAt: 'desc' } },
    },
  })
  if (!parcel) throw new ApiError(404, 'Parcel not found')
  if (scope.kind === 'client' && parcel.projectId !== scope.projectId) {
    throw new ApiError(404, 'Parcel not found')
  }

  const [latestSearch, projectRow] = await Promise.all([
    db.titleSearch.findFirst({ where: { parcelId: parcel.id }, orderBy: { searchedAt: 'desc' } }),
    parcel.projectId
      ? db.project.findUnique({
          where: { id: parcel.projectId },
          include: { phases: { orderBy: { order: 'asc' }, include: { tasks: true } } },
        })
      : Promise.resolve(null),
  ])

  const project = projectRow
    ? {
        id: projectRow.id,
        name: projectRow.name,
        status: projectRow.status,
        progressPct: passportProgress(projectRow.phases),
        dayCount: Math.max(1, Math.ceil((Date.now() - projectRow.startDate.getTime()) / 86400000)),
      }
    : null

  return { parcel, latestSearch, project }
}

/* ------------------------------------------------------------------ *
 * PARCEL DOCUMENT UPLOAD + CONSISTENCY CHECK (spec §8, honest)        *
 * The user TRANSCRIBES key fields from a document they hold; we       *
 * compare the transcription against the MjengoOS registry record.     *
 * No OCR claim, no AI-read claim — the record says who transcribed    *
 * it. Mismatches are flagged as inconsistencies, never as fraud.      *
 * ------------------------------------------------------------------ */

export const PARCEL_DOC_TYPES: Record<string, string> = {
  title_deed: 'Title deed',
  certificate_of_lease: 'Certificate of lease',
  official_search: 'Official search',
  survey_plan: 'Survey plan',
  other: 'Other document',
}

export type FieldCheck = {
  field: 'parcelNo' | 'ownerName' | 'acreage'
  label: string
  matched: boolean
  documentValue: string
  registryValue: string
}

/**
 * action=document.add — create a ParcelDocument with an honest
 * transcription-vs-registry comparison score (matched fields / 3 × 100)
 * and a matching ParcelEvent. Site team only (enforced by the route).
 */
export async function addParcelDocument(body: Record<string, unknown>, actor: MjengoSessionUser) {
  const parcelId = fieldStr(body.parcelId, 'parcelId required')
  const docType = fieldStr(body.docType, 'Choose a document type')
  const docLabel = PARCEL_DOC_TYPES[docType]
  if (!docLabel) badRequest('Choose a valid document type')
  const fileUrl = optionalId(body.fileUrl)

  const t = (body.transcribed && typeof body.transcribed === 'object')
    ? (body.transcribed as Record<string, unknown>)
    : {}
  const tParcelNo = fieldStr(t.parcelNo, 'Transcribe the parcel number from the document')
  const tOwner = fieldStr(t.ownerName, 'Transcribe the owner name from the document')
  const tAcres = fieldPos(t.acreage, 'Transcribe the acreage from the document')

  const parcel = await db.landParcel.findUnique({ where: { id: parcelId } })
  if (!parcel) notFound('Parcel not found')

  // --- comparison: user-transcribed fields vs the registry record ---
  const parcelMatch = normalizeReference(tParcelNo) === normalizeReference(parcel.parcelNo)
  const ownerMatch = tOwner.trim().toLowerCase() === parcel.ownerName.trim().toLowerCase()
  const acreageMatch = Math.abs(tAcres - parcel.sizeAcres) / parcel.sizeAcres <= 0.05
  const checks: FieldCheck[] = [
    { field: 'parcelNo', label: 'Parcel number', matched: parcelMatch, documentValue: tParcelNo, registryValue: parcel.parcelNo },
    { field: 'ownerName', label: 'Owner name', matched: ownerMatch, documentValue: tOwner, registryValue: parcel.ownerName },
    { field: 'acreage', label: 'Acreage', matched: acreageMatch, documentValue: String(tAcres), registryValue: String(parcel.sizeAcres) },
  ]
  const matchedCount = checks.filter((c) => c.matched).length
  const score = Math.round((matchedCount / checks.length) * 100)
  const mismatchLines = checks
    .filter((c) => !c.matched)
    .map((c) => `${c.label} differs: document says ${c.documentValue}, registry says ${c.registryValue}`)

  // HONESTY: the fields are transcribed by a human, not read by OCR/AI.
  const transcriptionNote = `Transcribed from the document by ${actor.name} — not OCR, not AI-read.`

  const document = await db.parcelDocument.create({
    data: {
      parcelId: parcel.id,
      docType,
      fileName: fileUrl ?? `${docType}-transcription-only`,
      extractedText: `Transcribed from the document by ${actor.name}: parcel no. ${tParcelNo}; owner ${tOwner}; acreage ${tAcres} acres.`,
      ocrMatchScore: score,
      ocrNote: mismatchLines.length
        ? `${matchedCount} of 3 transcribed fields match the registry record. ${mismatchLines.join('; ')}. ${transcriptionNote}`
        : `All 3 transcribed fields match the registry record. ${transcriptionNote}`,
    },
  })

  const event = await db.parcelEvent.create({
    data: {
      parcelId: parcel.id,
      eventDate: new Date(),
      eventType: 'document',
      title: `${docLabel} added`,
      detail: mismatchLines.length
        ? `${docLabel} added and compared to the registry record: ${matchedCount} of 3 transcribed fields match (${score}%). ${mismatchLines.join('; ')}. ${transcriptionNote}`
        : `${docLabel} added and compared to the registry record: all 3 transcribed fields match (${score}% consistent). ${transcriptionNote}`,
      source: `Site team upload · recorded by ${actor.name}`,
      needsAttention: score < 90, // any mismatch is worth a human look
    },
  })

  if (parcel.projectId) {
    await logAudit(
      parcel.projectId,
      'land',
      actor,
      `Document "${docLabel}" added to parcel ${parcel.parcelNo} — ${matchedCount}/3 transcribed fields match (${score}%)`,
    )
  }

  return { ok: true, document, event, comparison: { score, checks } }
}
