import { route } from '@/backend/lib/route-kit'
import { getProjectPayload } from '@/backend/lib/mjengo'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { projectIdRef, projectParcelsQuery, validateQuery } from './schemas'
import { mapServiceError, pageOfKind, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierProjectDenied } from './scope'

// /api/v1/projects/:id/parcels (Phase D, read-only — the land family) —
// src/app/api/v1/projects/[id]/parcels/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/parcels — the project's land parcels with the
 * verification ladder's summary (Doc A §3-8): identity (plot/county/area),
 * tenure, status (searching | verified | flagged), document and title-search
 * counts, the latest search's state, and the assigned professionals.
 *
 * FEATURE FLAG (spec §81, task 9-a): gated by `land_verification` exactly as
 * the webapp is — the flag's enforcement map (flags.ts) closes "the parcels
 * section of the Land tab", so the v1 read mirrors it: OFF → 403 'Feature
 * disabled by feature flag (land_verification)' for NON-ADMIN sessions
 * (admins bypass). (The professionals directory — a separate module sharing
 * the Land tab — is deliberately NOT gated by this flag; that surface is not
 * part of Phase D.)
 *
 * ROLE SCOPING: same as /api/v1/projects/:id (client pinned to their own
 * project, foreign → 403; unknown project → 404). W5-3: supplier sessions
 * are not project readers — uniform 403.
 *
 * HONEST LANGUAGE (land/policy.ts): "verified" is a record state produced by
 * the ladder (document + registry search reviewed), NEVER a government
 * certification claim; "flagged" is an anomaly state for human review, never
 * an accusation.
 *
 * DATA: the parcel rows come from getProjectPayload()'s land slice —
 * loadLandSlice(projectId), the land module's public read (parcels with
 * documents, searches and assignments; the same rows the webapp Land tab
 * renders). The per-project set is bounded, so pagination is the wallet-list
 * pattern: a deterministic (createdAt ASC, id ASC) total order sliced in the
 * route layer. ?status= (searching|verified|flagged) filters BEFORE
 * pagination — a cursor that falls out of the filtered list → 400. Rate
 * limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/parcels GET',
    rateLimit: { bucket: 'v1.projects.parcels', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/parcels GET', e, 'Project parcels failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    // Feature flag (spec §81, task 9-a) — the land ladder gate, mirrored from
    // the webapp's parcels-section hiding.
    const flagDenied = await requireFlagOn('land_verification', session)
    if (flagDenied) return flagDenied

    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectParcelsQuery)
    if (!q.ok) return q.response

    const payload = await getProjectPayload(id)
    if (!payload) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, payload.project.id)
    if (denied) return denied
    // W5-3: supplier sessions are not project readers. Uniform 403 — no
    // project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    let parcels = payload.land.parcels
    if (q.data.status) {
      parcels = parcels.filter((p) => p.status === q.data.status)
    }
    // Deterministic keyset order: (createdAt ASC, id ASC) — the slice's own
    // oldest-first order with the id tiebreak the keyset needs.
    parcels = [...parcels].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )

    const rows = parcels.map((parcel) => ({
      id: parcel.id,
      item: {
        id: parcel.id,
        projectId: parcel.projectId,
        plotNumber: parcel.plotNumber,
        county: parcel.county,
        town: parcel.town,
        lat: parcel.lat,
        lng: parcel.lng,
        approxArea: parcel.approxArea,
        tenureType: parcel.tenureType,
        status: parcel.status,
        documentCount: parcel.documents.length,
        searchCount: parcel.searches.length,
        assignmentCount: parcel.assignments.length,
        latestSearch: parcel.searches[0]
          ? {
              id: parcel.searches[0].id,
              searchRef: parcel.searches[0].searchRef,
              status: parcel.searches[0].status,
              transcriptionMatch: parcel.searches[0].transcriptionMatch,
              requestedAt: parcel.searches[0].requestedAt.toISOString(),
              receivedAt: parcel.searches[0].receivedAt
                ? parcel.searches[0].receivedAt.toISOString()
                : null,
              reviewedAt: parcel.searches[0].reviewedAt
                ? parcel.searches[0].reviewedAt.toISOString()
                : null,
            }
          : null,
        assignments: parcel.assignments.map((a) => ({
          id: a.id,
          professionalName: a.professionalName,
          professionalCategory: a.professionalCategory,
          roleOnParcel: a.role,
          status: a.status,
          createdAt: a.createdAt.toISOString(),
        })),
        createdAt: parcel.createdAt.toISOString(),
        updatedAt: parcel.updatedAt.toISOString(),
      },
    }))
    const p = pageOfKind(rows, q.data.limit, q.data.cursor, 'a parcel')
    if (!p.ok) return p.response

    return v1Ok(
      p.page.items.map((r) => r.item),
      { nextCursor: p.page.nextCursor, hasMore: p.page.hasMore },
    )
  },
)
