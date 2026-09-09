// POST /api/upload/presign — step 1 of the client-direct upload flow
// (task 9-b, issue "Move uploads to object storage (presigned URLs)").
//
// The server mints a short-lived SigV4 presigned PUT URL and hands it to a
// signed-in client, which uploads its photo bytes STRAIGHT to object storage
// (no base64 detour through the app server — the 4 MB photo path's JSON
// envelope was ~5.4 MB per upload). Step 2 is POST /api/upload/confirm,
// which verifies the object landed and creates the Attachment row.
//
// HONEST CAPABILITY GATE: the flow exists only when the active storage
// driver can presign (S3/R2/MinIO env set). The local-disk default cannot —
// its files are served by the Next server itself, presigning is meaningless —
// so this route answers 409 with that explanation instead of pretending.
// The legacy server-mediated POST /api/upload keeps working unchanged for
// every driver (local-disk included): clients on a local-disk deployment
// lose nothing.
//
// Session guard mirrors /api/upload exactly (contractor/admin/client).
// Contract (zod strictObject):
//   { contentType: 'image/png' | 'image/jpeg',
//     sizeBytes: int 1..4 MB,          — advisory: enforced at confirm (HEAD)
//     category: one of the Attachment categories }
// Response: { uploadUrl, key, expiresSec, headers: { 'Content-Type': … } }
// The key has EXACTLY the legacy photo shape (upp-<ts>-<hex>.<ext>) —
// objects written through either flow are indistinguishable in the bucket.

import { randomBytes } from 'crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { route, genericError } from '@/backend/lib/route-kit'
import { asPresignCapable, getStorageDriver } from '@/backend/lib/storage'
import { DOCUMENT_CATEGORIES, MIME_EXT } from '@/backend/modules/documents/types'

/** How long a presigned PUT stays usable — 5 minutes is generous for one PUT. */
export const PRESIGN_PUT_EXPIRES_SEC = 300

const MAX_BYTES = 4 * 1024 * 1024 // same 4 MB cap as the photo path

const presignBody = z.strictObject({
  contentType: z.enum(['image/png', 'image/jpeg'], {
    error: 'contentType must be "image/png" or "image/jpeg"',
  }),
  sizeBytes: z
    .number('sizeBytes must be a number')
    .int('sizeBytes must be an integer')
    .min(1, 'sizeBytes must be at least 1 byte')
    .max(MAX_BYTES, `sizeBytes exceeds the 4 MB photo cap (${MAX_BYTES} bytes)`),
  category: z.enum(DOCUMENT_CATEGORIES, {
    error: `category must be one of: ${DOCUMENT_CATEGORIES.join(', ')}`,
  }),
})

export const POST = route(
  {
    scope: 'api/upload/presign',
    roles: ['contractor', 'admin', 'client'],
    rateLimit: { bucket: 'upload:presign', limit: 10, windowMs: 60_000 },
    body: { schema: presignBody, maxBytes: 64 * 1024 },
    onError: genericError(500, 'Presign failed'),
  },
  async (_req, _session, body) => {
    // `category` is validated here but consumed at the confirm step — the
    // client holds it and sends it back with the key (see the contract note
    // in the file header).
    const { contentType } = body

    const driver = getStorageDriver()
    const capable = asPresignCapable(driver)
    if (!capable) {
      if (!driver.canPresign) {
        return NextResponse.json(
          {
            error:
              `Presigned uploads unavailable — local-disk driver in use ` +
              `(server-mediated upload only)`,
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

    const ext = MIME_EXT[contentType]
    const key = `upp-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`
    const presigned = capable.presignPut(key, contentType, PRESIGN_PUT_EXPIRES_SEC)

    return NextResponse.json({
      uploadUrl: presigned.url,
      key,
      expiresSec: PRESIGN_PUT_EXPIRES_SEC,
      headers: presigned.headers,
    })
  },
)
