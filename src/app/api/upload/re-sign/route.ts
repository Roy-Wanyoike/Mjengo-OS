// POST /api/upload/re-sign — fresh short-lived presigned GET URLs for stored
// attachments (issue #38: "presigned GETs expire").
//
// WHY THIS EXISTS: on a private bucket without S3_PUBLIC_BASE, the driver's
// publicUrl is a presigned GET with the SigV4 7-day MAXIMUM — rows recorded
// today stop resolving next week (the §9.2 expiry tradeoff in DEPLOYMENT.md).
// This endpoint is the mitigation: a caller who can already SEE an attachment
// (the same entitlement the photo replay path — /api/project → supply slice —
// grants) exchanges its id for a FRESH presigned GET, short-lived on purpose
// (15 min): a re-signed URL is a bearer capability, so it should live just
// long enough to render, not another week.
//
// HONEST CAPABILITY GATE (mirrors /api/upload/presign): the flow exists only
// when the active storage driver can presign. The local-disk default cannot —
// its public URLs are stable paths served by the Next server and never expire
// — so this route answers 409 with that explanation instead of pretending.
//
// ENTITLEMENT (the photo replay path's checks, generalized):
//   · client-role sessions are PINNED to their project (tenant isolation,
//     exactly like /api/project and /api/sync): a row is theirs only when its
//     project — or the project of a delivery it is linked to — is the pinned
//     one; anything else is 403, fail closed;
//   · owner-app roles mirror /api/project's posture: any project's payload is
//     loadable, so any row that is reachable at all is re-signable;
//   · a row is reachable when it carries a projectId, or when a DeliveryPhoto
//     link ties it to a delivery (the evidence-photo shape: rows created by
//     /api/upload/confirm carry projectId null and only become visible
//     through delivery links). A row reachable NOWHERE answers 403 — there is
//     no honest entitlement to mint a bearer URL for it.
//
// Contract (zod strictObject, route-kit wrapper like the sibling upload
// routes — session guard → rate limit → strict body):
//   POST { attachmentIds: string[] }   — Attachment ids (cuid strings), 1..50
//   200 { ok: true, expiresSec, urls: [{ attachmentId, url }] }
//   400 invalid body · 401 no session · 403 role/entitlement ·
//   404 unknown id (named) · 409 driver cannot presign / storageKey the
//   active driver cannot address · 429 rate limit (10/min per principal)
//
// The route resolves each row's recorded storageKey back to a driver key via
// the driver's keyFor and mints a NEW presigned GET — the recorded
// storageKey is never rewritten (Attachment rows are append-only evidence,
// transport-only change; the frontend follow-up is to call this before
// rendering when a URL has gone stale).
//
// NOTE: implemented inline (like /api/ai/extract-document/route.ts) rather
// than the thin-shim → src/backend/api/upload-*.ts pattern, to keep every
// file this change touches inside the storage/upload route ownership.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/backend/lib/db'
import { route, genericError } from '@/backend/lib/route-kit'
import type { GuardSession } from '@/backend/lib/guard'
import { asPresignCapable, getStorageDriver } from '@/backend/lib/storage'

/** How long a re-signed GET stays usable — short on purpose (render window). */
export const RESIGN_GET_EXPIRES_SEC = 900

/** Batch cap — one gallery page's worth of evidence photos, no more. */
const MAX_IDS_PER_CALL = 50

const resignBody = z.strictObject({
  attachmentIds: z
    .array(z.string('attachmentIds must be an array of attachment ids'), {
      error: 'attachmentIds must be an array of attachment ids',
    })
    .min(1, 'attachmentIds must contain at least one id')
    .max(MAX_IDS_PER_CALL, `attachmentIds is capped at ${MAX_IDS_PER_CALL} ids per call`),
})

export const POST = route(
  {
    scope: 'api/upload/re-sign',
    roles: ['contractor', 'admin', 'client'], // session guard mirrors the other upload routes
    rateLimit: { bucket: 'upload:resign', limit: 10, windowMs: 60_000 },
    body: { schema: resignBody, maxBytes: 8 * 1024 },
    onError: genericError(500, 'Re-sign failed'),
  },
  async (_req, session, body) => {
    const ids: string[] = body.attachmentIds

    // Capability gate FIRST (the /api/upload/presign pattern): an honest 409
    // before any db work when the active driver cannot presign at all.
    const driver = getStorageDriver()
    const capable = asPresignCapable(driver)
    if (!capable) {
      if (!driver.canPresign) {
        return NextResponse.json(
          {
            error:
              `Presigned URLs unavailable — local-disk driver in use ` +
              `(its public URLs never expire; re-signing is only for private object storage)`,
          },
          { status: 409 },
        )
      }
      // canPresign claimed but the methods are missing — a driver bug, not a
      // deployment state. Fail loudly, not silently.
      return NextResponse.json(
        { error: `Storage driver "${driver.id}" claims presign support but does not implement it` },
        { status: 500 },
      )
    }

    const rows = await db.attachment.findMany({
      where: { id: { in: ids } },
      select: { id: true, storageKey: true, projectId: true },
    })

    // Unknown ids are named honestly (404) — ids are unguessable cuids, so
    // this is the caller's own stale state, not an enumeration vector.
    const foundIds = new Set(rows.map((r) => r.id))
    const missing = ids.filter((id) => !foundIds.has(id))
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Attachment not found: ${missing.join(', ')}` },
        { status: 404 },
      )
    }

    // Entitlement — fail closed: ONE non-entitled id blocks the whole batch
    // (differential per-item answers would turn this route into an
    // existence/entitlement oracle).
    for (const row of rows) {
      if (!(await entitledToReSign(row, session))) {
        return NextResponse.json(
          {
            error:
              `Attachment "${row.id}" is not reachable through a project your session can access — ` +
              `re-signing refused`,
          },
          { status: 403 },
        )
      }
    }

    // Resolve + mint. A row whose storageKey the ACTIVE driver cannot address
    // (a row written by a different storage backend — the local→S3 migration
    // case) fails the whole batch with an honest 409 naming the row.
    const urls: Array<{ attachmentId: string; url: string }> = []
    for (const row of rows) {
      const key = typeof driver.keyFor === 'function' ? driver.keyFor(row.storageKey) : null
      if (!key) {
        return NextResponse.json(
          {
            error:
              `Attachment "${row.id}" records a storage URL the "${driver.id}" driver cannot address ` +
              `(written by a different storage backend?) — re-upload the file to make it re-signable`,
          },
          { status: 409 },
        )
      }
      urls.push({ attachmentId: row.id, url: capable.presignGet(key, RESIGN_GET_EXPIRES_SEC) })
    }

    return NextResponse.json({
      ok: true,
      expiresSec: RESIGN_GET_EXPIRES_SEC,
      urls,
    })
  },
)

/**
 * The photo replay path's visibility checks, generalized to one row: a
 * project-linked row is visible through its project, and an unattached row
 * (delivery evidence photos, legacy uploads) is visible only through a
 * DeliveryPhoto link — no link, no entitlement. Client sessions are pinned to
 * their own project (tenant isolation — the /api/project + /api/sync
 * posture); an UNPINNED client can establish entitlement to nothing, fail
 * closed. Owner-app roles mirror /api/project's any-project posture.
 */
async function entitledToReSign(
  row: { id: string; projectId: string | null },
  session: NonNullable<GuardSession>,
): Promise<boolean> {
  if (session.user.role === 'client') {
    const pinned = session.user.projectId
    if (!pinned) return false
    if (row.projectId) return row.projectId === pinned
    const link = await db.deliveryPhoto.findFirst({
      where: { attachmentId: row.id, delivery: { order: { projectId: pinned } } },
      select: { id: true },
    })
    return Boolean(link)
  }

  if (row.projectId) {
    const project = await db.project.findUnique({ where: { id: row.projectId }, select: { id: true } })
    return Boolean(project)
  }
  const link = await db.deliveryPhoto.findFirst({
    where: { attachmentId: row.id },
    select: { id: true },
  })
  return Boolean(link)
}
