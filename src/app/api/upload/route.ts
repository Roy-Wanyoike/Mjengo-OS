import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { randomBytes } from 'crypto'
import { withGuard } from '@/lib/guard'

// Photo upload (spec §84 no-dead-UI fix for the Copilot fresh-photo flow).
//
// POST { dataUrl } — validates a data:image/* URL, decodes it, enforces the
// 4 MB decoded-size cap, and writes the bytes to public/photos/ so the photo
// gets a real served URL. That URL is what /api/ai/analyze-photo and the
// photo.apply action both consume — a data URL used to make the "apply"
// step silently dead (no url, no photoId → server error). Honest limits:
// PNG / JPEG / WebP / GIF only (SVG rejected — script risk), and the file
// name is server-generated so nothing user-controlled touches the path.
//
// NOTE: files written at runtime are served by the Next dev server; in a
// frozen production build, public/ is snapshotted at build time — a durable
// object store would replace this seam (documented, not hidden).

export const dynamic = 'force-dynamic'

const MAX_BYTES = 4 * 1024 * 1024 // 4 MB decoded

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export const POST = withGuard(
  async (req: NextRequest) => {
    try {
      const { dataUrl } = (await req.json()) as { dataUrl?: string }
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        return NextResponse.json({ error: 'A data:image/* URL is required' }, { status: 400 })
      }
      const m = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
      if (!m) {
        return NextResponse.json({ error: 'Invalid data URL (expected base64 image data)' }, { status: 400 })
      }
      const mime = m[1].toLowerCase()
      const ext = MIME_EXT[mime]
      if (!ext) {
        return NextResponse.json(
          { error: `Unsupported image type ${mime} — use PNG, JPEG, WebP or GIF` },
          { status: 400 },
        )
      }
      const buf = Buffer.from(m[2], 'base64')
      if (buf.length === 0) {
        return NextResponse.json({ error: 'Empty image payload' }, { status: 400 })
      }
      if (buf.length > MAX_BYTES) {
        return NextResponse.json(
          { error: `Image is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is 4 MB (Data Saver compresses uploads)` },
          { status: 413 },
        )
      }

      const dir = path.join(process.cwd(), 'public', 'photos')
      await mkdir(dir, { recursive: true })
      const name = `upp-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`
      await writeFile(path.join(dir, name), buf)

      return NextResponse.json({ ok: true, url: `/photos/${name}`, bytes: buf.length })
    } catch (e) {
      console.error('[api/upload]', e)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }
  },
  { roles: ['contractor', 'admin', 'client'] },
)
