/**
 * Local-disk driver (task 9-b): byte-identical to the historical /api/upload
 * photo write. Round-trips through a tmp directory (the photosDir test seam)
 * and pins: exact bytes on disk, the /photos/<key> public URL, mkdir-on-
 * demand, flat-key fail-closed behavior, statObject, and the honest
 * canPresign=false / asPresignCapable=null capability reporting.
 */
import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createLocalDiskDriver, localDiskDriver } from '@/backend/lib/storage/local-disk'
import { asPresignCapable } from '@/backend/lib/storage/types'
import type { StorageAdapter } from '@/backend/lib/storage/types'

let dir: string
let driver: StorageAdapter

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mj-storage-'))
  driver = createLocalDiskDriver({ photosDir: dir })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
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
