// POST /api/upload/confirm — step 2 of the client-direct upload flow
// (task 9-b). After PUTting bytes to the URL /api/upload/presign handed out,
// the client confirms: this route VERIFIES the object actually landed (HEAD
// via the storage driver — existence, size ≤ 4 MB, image Content-Type) and
// only then creates the Attachment row.
//
// VERIFICATION IS THE POINT: a presigned URL is bearer-only for a few
// minutes, but the ROW is the durable record — it must never describe an
// object that was never uploaded. No magic-number sniffing happens here
// (bytes are never proxied through the app in this flow); the honest
// approximation is HEAD metadata: Content-Length for the cap, Content-Type
// for the image contract. Content-Type on S3 is whatever the client's PUT
// carried — the presign response's headers told it exactly what to send,
// so a mismatch here is a client that ignored the contract, and the row is
// refused with an explanation rather than created with a lie.
//
// The row matches the document-mode Attachment shape (reviewStatus 'pending'
// default, category provenance, sizeBytes/mimeType from the HEAD). Fields
// this flow does NOT take (projectId/entityType/entityId/expiresAt/title)
// are a deliberate scope cut — the document mode's richer provenance is its
// own route; photo provenance rides the delivery-verification links that
// consume attachment ids (agent 8-a).
//
// NON-IDEMPOTENT BY DESIGN: Attachment rows are append-only evidence in this
// app (same posture as the orphaned-upload follow-up documented in 8-a) —
// confirming the same key twice records two rows pointing at one object.
// A replay/dedupe seam would need a schema index (out of scope, noted in
// the worklog).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/backend/lib/db'
import { route, genericError } from '@/backend/lib/route-kit'
import { getStorageDriver } from '@/backend/lib/storage'
import { DOCUMENT_CATEGORIES } from '@/backend/modules/documents/types'

const MAX_BYTES = 4 * 1024 * 1024 // same 4 MB cap as the photo path

/** The only keys this route will ever confirm — server-minted photo keys. */
const UPP_KEY_RE = /^upp-\d+-[a-f0-9]{6}\.(png|jpg)$/

const PHOTO_MIME_TYPES = new Set(['image/png', 'image/jpeg'])

const confirmBody = z.strictObject({
  key: z
    .string('key must be a string')
    .regex(UPP_KEY_RE, {
      error: 'key must be a presigned-upload key (upp-<timestamp>-<hex>.png|jpg — from POST /api/upload/presign)',
    }),
  category: z.enum(DOCUMENT_CATEGORIES, {
    error: `category must be one of: ${DOCUMENT_CATEGORIES.join(', ')}`,
  }),
})

export const POST = route(
  {
    scope: 'api/upload/confirm',
    roles: ['contractor', 'admin', 'client'],
    rateLimit: { bucket: 'upload:confirm', limit: 10, windowMs: 60_000 },
    body: { schema: confirmBody, maxBytes: 64 * 1024 },
    onError: genericError(500, 'Confirm failed'),
  },
  async (_req, session, body) => {
    const { key, category } = body

    const driver = getStorageDriver()
    if (typeof driver.statObject !== 'function') {
      return NextResponse.json(
        {
          error:
            `Upload confirmation unavailable — storage driver "${driver.id}" ` +
            `cannot verify objects (server-mediated upload only)`,
        },
        { status: 409 },
      )
    }

    const stat = await driver.statObject(key)
    if (!stat.exists) {
      return NextResponse.json(
        {
          error:
            `No uploaded object for key "${key}" — PUT the file to the presigned ` +
            `URL first (POST /api/upload/presign), then confirm`,
        },
        { status: 404 },
      )
    }
    if (stat.sizeBytes !== null && stat.sizeBytes > MAX_BYTES) {
      return NextResponse.json(
        {
          error:
            `Uploaded object is ${(stat.sizeBytes / 1024 / 1024).toFixed(1)} MB — ` +
            `the limit is 4 MB; re-upload a compressed photo and confirm the new key`,
        },
        { status: 413 },
      )
    }
    if (stat.contentType && !PHOTO_MIME_TYPES.has(stat.contentType)) {
      return NextResponse.json(
        {
          error:
            `Uploaded object reports Content-Type "${stat.contentType}" — expected ` +
            `image/png or image/jpeg. Send the Content-Type header from the presign ` +
            `response with your PUT (it is not part of the signature, so the store ` +
            `kept whatever the PUT carried)`,
        },
        { status: 400 },
      )
    }

    // storageKey is the driver's PUBLIC URL (what the frontend renders, same
    // field semantics as every existing Attachment row). With S3_PUBLIC_BASE
    // it is stable forever; without it, it is a presigned GET with the SigV4
    // 7-day maximum — the documented tradeoff (DEPLOYMENT.md object storage
    // section; replay-time re-signing is the parked follow-up).
    const attachment = await db.attachment.create({
      data: {
        entityType: 'photo',
        entityId: 'unattached',
        fileName: key,
        storageKey: driver.publicUrl(key),
        kind: `${category}_photo`,
        uploadedBy: session.user.email,
        projectId: null,
        category,
        mimeType: stat.contentType,
        sizeBytes: stat.sizeBytes,
        reviewStatus: 'pending', // the existing upload default — humans review
      },
    })

    return NextResponse.json({
      ok: true,
      attachment: {
        id: attachment.id,
        storageKey: attachment.storageKey,
        fileName: attachment.fileName,
        category: attachment.category,
        reviewStatus: attachment.reviewStatus,
      },
    })
  },
)
