import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { requireFlagOn } from '@/backend/modules/intel/flags'
import { afterCreatedAtId, cursorRowOr400 } from './keyset'
import { projectIdRef, projectParcelsQuery, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, membershipProjectDenied, supplierProjectDenied } from './scope'

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
 * DATA (issue #154 / audit API-3): DIRECT READ — db.landParcel.findMany
 * scoped `where: { projectId }` (the same rows the land module's
 * loadLandSlice returns), with only the joins the summary needs: document
 * IDS (the count), the searches ordered newest-first (the count + the
 * latest row) and the assignments with their professional join. The old
 * path materialized the whole ~20-read getProjectPayload to slice the
 * parcels out of it; the page cost is now O(page): ?status=, the keyset
 * boundary and take = limit + 1 all ride the single query (the #155
 * attendance pattern), ordered (createdAt ASC, id ASC) — the same total
 * order the route's old in-memory sort produced. Rate limit: 120/min per
 * principal.
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

    // Unknown project → 404 (the attendance/deliveries resolve step).
    const project = await db.project.findUnique({ where: { id } })
    if (!project) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, id)
    if (denied) return denied
    // SEC-6 (issue #174): the site-team membership pin — supervisor /
    // procurement / qs / finance read only the projects they hold a
    // ProjectMembership row on (fail closed on zero rows); contractor/admin
    // keep the explicit portfolio-wide grant. Same uniform 403 body as the
    // client pin, after the resolve (resolve-then-pin, the v1 precedent).
    const membershipDenied = await membershipProjectDenied(session, id)
    if (membershipDenied) return membershipDenied
    // W5-3: supplier sessions are not project readers. Uniform 403 — no
    // project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    // Keyset cursor (#155 convention): resolve by id, refuse unless the row
    // belongs to THIS filtered list (project + status filter).
    const cursor = q.data.cursor
    let boundary: { createdAt: Date; id: string } | null = null
    if (cursor) {
      const c = await cursorRowOr400(
        () =>
          db.landParcel.findFirst({
            where: {
              id: cursor,
              projectId: id,
              ...(q.data.status ? { status: q.data.status } : {}),
            },
          }),
        'a parcel',
      )
      if (!c.ok) return c.response
      boundary = { createdAt: c.row.createdAt, id: c.row.id }
    }

    // One query: scope + filter + boundary + (createdAt ASC, id ASC) + take
    // limit+1, with only the joins the summary needs (the loadLandSlice
    // include, slimmed for the list: document ids for the count, searches
    // newest-first so [0] is the latest, assignments with the professional
    // join).
    const rows = await db.landParcel.findMany({
      where: {
        projectId: id,
        ...(q.data.status ? { status: q.data.status } : {}),
        ...(boundary ? afterCreatedAtId(boundary, 'asc') : {}),
      },
      include: {
        documents: { select: { id: true }, orderBy: { createdAt: 'desc' } },
        searches: { orderBy: { createdAt: 'desc' } },
        assignments: {
          include: { professional: { select: { name: true, category: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: q.data.limit + 1,
    })

    const hasMore = rows.length > q.data.limit
    const parcels = rows.slice(0, q.data.limit)
    const nextCursor = hasMore ? parcels[parcels.length - 1]?.id ?? null : null

    return v1Ok(
      parcels.map((parcel) => ({
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
          professionalName: a.professional.name,
          professionalCategory: a.professional.category,
          roleOnParcel: a.role,
          status: a.status,
          createdAt: a.createdAt.toISOString(),
        })),
        createdAt: parcel.createdAt.toISOString(),
        updatedAt: parcel.updatedAt.toISOString(),
      })),
      { nextCursor, hasMore },
    )
  },
)
