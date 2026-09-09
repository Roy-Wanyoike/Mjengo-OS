/**
 * Local-disk driver (task 9-b): byte-identical to the historical /api/upload
 * photo write. Round-trips through a tmp directory (the photosDir test seam)
 * and pins: exact bytes on disk, the /photos/<key> public URL, mkdir-on-
 * demand, flat-key fail-closed behavior, statObject, and the honest
 * canPresign=false / asPresignCapable=null capability reporting.
 *
 * Issue #37 additions: the `docs/` key prefix (the document tree — same
 * flat-segment rules, landing in <docsDir> instead of <photosDir>, publicUrl
 * /docs/<name> — byte-identical to the documents service's historical
 * public/docs layout), the read() passthrough seam, and keyFor() — the
 * publicUrl inverse both the extraction read and the re-sign endpoint use.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLocalDiskDriver, localDiskDriver } from '@/backend/lib/storage/local-disk'
import { asPresignCapable } from '@/backend/lib/storage/types'
import type { StorageAdapter } from '@/backend/lib/storage/types'

let dir: string
let driver: StorageAdapter
let docsTree: string
let docDriver: StorageAdapter

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mj-storage-'))
  driver = createLocalDiskDriver({ photosDir: dir })
  // Issue #37: an ISOLATED docs tree (explicit docsDir — never the derived
  // /tmp sibling, which would be shared across test runs). Both sub-dirs are
  // created up front so "nothing landed" assertions can readdir them.
  docsTree = await mkdtemp(path.join(tmpdir(), 'mj-storage-docs-'))
  await mkdir(path.join(docsTree, 'photos'), { recursive: true })
  await mkdir(path.join(docsTree, 'docs'), { recursive: true })
  docDriver = createLocalDiskDriver({
    photosDir: path.join(docsTree, 'photos'),
    docsDir: path.join(docsTree, 'docs'),
  })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(docsTree, { recursive: true, force: true })
})

describe('put — exactly the historical photo write', () => {
  it('round-trips exact bytes under <dir>/<key> (mkdir on demand)', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    await driver.put('upp-1712345678-abcd12.png', bytes, 'image/png')
    expect(await readFile(path.join(dir, 'upp-1712345678-abcd12.png'))).toEqual(bytes)
    // the directory was created on demand inside the (empty) tmp dir
    expect((await readdir(path.dirname(dir))).length).toBeGreaterThan(0)
  })

  it('re-creates the photos dir after it disappears (runtime state, not a committed tree)', async () => {
    await rm(dir, { recursive: true, force: true })
    await driver.put('upp-1-abcdef.jpg', Buffer.from('jpeg-ish'), 'image/jpeg')
    expect(await readFile(path.join(dir, 'upp-1-abcdef.jpg'))).toEqual(Buffer.from('jpeg-ish'))
  })

  it('overwrites byte-for-byte on the same key (last write wins, like writeFile)', async () => {
    await driver.put('upp-1-abcdef.jpg', Buffer.from('first'), 'image/jpeg')
    await driver.put('upp-1-abcdef.jpg', Buffer.from('second!'), 'image/jpeg')
    expect(await readFile(path.join(dir, 'upp-1-abcdef.jpg'))).toEqual(Buffer.from('second!'))
  })

  it('fail-closed on non-flat / traversal keys — never a general file writer', async () => {
    for (const bad of ['../evil.png', 'a/b.png', 'a/b', '', '.hidden', '..foo.png', 'sub/../x.png', 'x y.png']) {
      await expect(driver.put(bad, Buffer.from('x'), 'image/png')).rejects.toThrow(/unsafe storage key/)
    }
    expect(await readdir(dir)).toEqual([]) // rejected before mkdir/write — nothing landed
  })
})

describe('publicUrl — the stable Next-served path', () => {
  it('is /photos/<key>, byte-identical to the legacy response URL', () => {
    expect(driver.publicUrl('upp-1712345678-abcd12.png')).toBe('/photos/upp-1712345678-abcd12.png')
    expect(driver.publicUrl('upp-1-abcdef.jpg')).toBe('/photos/upp-1-abcdef.jpg')
  })

  it('the process-wide default instance answers the same (no write attempted)', () => {
    expect(localDiskDriver.id).toBe('local-disk')
    expect(localDiskDriver.publicUrl('upp-9-zz.jpg')).toBe('/photos/upp-9-zz.jpg')
  })
})

describe('capability reporting — honest, no pretending', () => {
  it('canPresign is false and asPresignCapable narrows to null', () => {
    expect(driver.canPresign).toBe(false)
    expect(driver.presignPut).toBeUndefined()
    expect(driver.presignGet).toBeUndefined()
    expect(asPresignCapable(driver)).toBeNull()
    expect(asPresignCapable(localDiskDriver)).toBeNull()
  })
})

describe('statObject — real disk answers the confirm route honestly', () => {
  it('reports existence, size and extension-derived content type', async () => {
    const bytes = Buffer.alloc(2048, 7)
    await driver.put('upp-1712345678-abcd12.png', bytes, 'image/png')
    expect(await driver.statObject!('upp-1712345678-abcd12.png')).toEqual({
      exists: true,
      sizeBytes: 2048,
      contentType: 'image/png',
    })
  })

  it('jpg extension → image/jpeg', async () => {
    await driver.put('upp-1-abcdef.jpg', Buffer.from('x'), 'image/jpeg')
    expect((await driver.statObject!('upp-1-abcdef.jpg'))!.contentType).toBe('image/jpeg')
  })

  it('missing key → exists false, no throw', async () => {
    expect(await driver.statObject!('upp-404-000000.png')).toEqual({
      exists: false,
      sizeBytes: null,
      contentType: null,
    })
  })

  it('unsafe keys never touch the disk', async () => {
    expect((await driver.statObject!('../../etc/passwd'))!.exists).toBe(false)
  })
})

describe('docs/ keys — the document tree (issue #37)', () => {
  it('put writes <docsDir>/<name> (mkdir on demand) — the exact public/docs layout', async () => {
    const bytes = Buffer.from('%PDF-1.4 fake pdf')
    await docDriver.put('docs/doc-1712345678-abcd12.pdf', bytes, 'application/pdf')
    expect(await readFile(path.join(docsTree, 'docs', 'doc-1712345678-abcd12.pdf'))).toEqual(bytes)
    expect(await readdir(path.join(docsTree, 'photos'))).toEqual([]) // nothing in the photo tree
  })

  it('publicUrl is /docs/<name> — byte-identical to the historical documents storageKey', () => {
    expect(docDriver.publicUrl('docs/doc-1712345678-abcd12.pdf')).toBe('/docs/doc-1712345678-abcd12.pdf')
    // flat keys still answer the photo shape on the SAME driver:
    expect(docDriver.publicUrl('upp-1712345678-abcd12.jpg')).toBe('/photos/upp-1712345678-abcd12.jpg')
  })

  it('the process-wide default instance serves the same two URL shapes', () => {
    expect(localDiskDriver.publicUrl('docs/doc-9-zz.pdf')).toBe('/docs/doc-9-zz.pdf')
    expect(localDiskDriver.publicUrl('upp-9-zz.jpg')).toBe('/photos/upp-9-zz.jpg')
  })

  it('docsDir defaults to the photosDir sibling — public/docs next to public/photos', async () => {
    const derived = createLocalDiskDriver({ photosDir: path.join(docsTree, 'custom', 'photos') })
    await derived.put('docs/doc-1-abcdef12.png', Buffer.from('png-ish'), 'image/png')
    expect(await readFile(path.join(docsTree, 'custom', 'docs', 'doc-1-abcdef12.png'))).toEqual(Buffer.from('png-ish'))
  })

  it('statObject answers docs keys (size + extension-derived pdf mime)', async () => {
    const bytes = Buffer.alloc(512, 3)
    await docDriver.put('docs/doc-1712345678-abcd12.pdf', bytes, 'application/pdf')
    expect(await docDriver.statObject!('docs/doc-1712345678-abcd12.pdf')).toEqual({
      exists: true,
      sizeBytes: 512,
      contentType: 'application/pdf',
    })
  })

  it('fail-closed on unsafe docs keys — still never a general file writer', async () => {
    for (const bad of ['docs/a/b.pdf', 'docs/', 'docs/..', 'docs/../evil.pdf', 'docs/.hidden', 'docs/x y.pdf', 'other/x.pdf']) {
      await expect(docDriver.put(bad, Buffer.from('x'), 'application/pdf')).rejects.toThrow(/unsafe storage key/)
      expect(await docDriver.read!(bad)).toBeNull()
      expect((await docDriver.statObject!(bad))!.exists).toBe(false)
    }
    expect(await readdir(path.join(docsTree, 'docs'))).toEqual([]) // nothing landed anywhere
  })
})

describe('read — the byte-identical passthrough (issue #37)', () => {
  it('round-trips photo keys: exact bytes + extension content type + real size', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 1, 2, 3])
    await driver.put('upp-1712345678-abcd12.png', bytes, 'image/png')
    expect(await driver.read!('upp-1712345678-abcd12.png')).toEqual({
      bytes,
      contentType: 'image/png',
      sizeBytes: bytes.length,
    })
  })

  it('round-trips docs keys through the docs tree', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9])
    await docDriver.put('docs/doc-1-abcdef12.png', bytes, 'image/png')
    const stored = await docDriver.read!('docs/doc-1-abcdef12.png')
    expect(stored!.bytes).toEqual(bytes)
    expect(stored!.contentType).toBe('image/png')
    expect(stored!.sizeBytes).toBe(bytes.length)
  })

  it('missing key → null (a plain answer, not a throw)', async () => {
    expect(await driver.read!('upp-404-000000.png')).toBeNull()
    expect(await docDriver.read!('docs/doc-404-000000.pdf')).toBeNull()
  })

  it('unsafe keys never touch the disk', async () => {
    expect(await driver.read!('../../etc/passwd')).toBeNull()
    expect(await driver.read!('a/b.png')).toBeNull()
  })

  it('an empty file reads as 0 bytes (the caller decides what that means)', async () => {
    await writeFile(path.join(dir, 'upp-empty-000000.png'), Buffer.alloc(0))
    const stored = await driver.read!('upp-empty-000000.png')
    expect(stored!.bytes.length).toBe(0)
    expect(stored!.sizeBytes).toBe(0)
  })

  it('the process-wide default instance implements the seam too (no write attempted)', async () => {
    expect(typeof localDiskDriver.read).toBe('function')
    expect(await localDiskDriver.read!('upp-definitely-not-here-000000.png')).toBeNull()
  })
})

describe('keyFor — the publicUrl inverse (issues #37 + #38)', () => {
  it('/photos/<key> → <key>', () => {
    expect(driver.keyFor!('/photos/upp-1712345678-abcd12.png')).toBe('upp-1712345678-abcd12.png')
  })

  it('/docs/<name> → docs/<name> — legacy document rows resolve identically', () => {
    expect(driver.keyFor!('/docs/doc-1712345678-abcd12.pdf')).toBe('docs/doc-1712345678-abcd12.pdf')
  })

  it('foreign shapes → null (this driver cannot address them)', () => {
    for (const foreign of [
      '/uploads/x.pdf',
      '/documents/p1/x.pdf', // the land module's parcel-document shape — not ours
      'https://cdn.example.com/upp-1-abcdef.jpg',
      'upp-1-abcdef.jpg',
      '',
      '/photos/',
    ]) {
      expect(driver.keyFor!(foreign)).toBeNull()
    }
  })

  it('traversal-shaped values refuse (fail closed)', () => {
    expect(driver.keyFor!('/photos/../etc/passwd')).toBeNull()
    expect(driver.keyFor!('/docs/../evil.pdf')).toBeNull()
    expect(driver.keyFor!('/photos/a b.png')).toBeNull()
  })

  it('keyFor(publicUrl(k)) === k for both trees (the inverse property)', () => {
    for (const key of ['upp-1712345678-abcd12.jpg', 'docs/doc-1712345678-abcd12.pdf']) {
      expect(driver.keyFor!(driver.publicUrl(key))).toBe(key)
    }
  })
})
