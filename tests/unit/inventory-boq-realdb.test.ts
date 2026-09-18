/**
 * BOQ lifecycle + supplier shortlist against a REAL SQLite database (issue
 * #195) — the critical-path companion of inventory-boq.test.ts (stub suite,
 * unchanged and still green).
 *
 * The stub suite pins the service LOGIC; this suite pins what only the real
 * engine can prove about the BOQ surface:
 *
 *  · the full lifecycle walk on real tables — createBoq (versioning) →
 *    upsertBoqLine (add + in-place update) → approveBoq → boqToRequest
 *    (selected lines) — with loadBoqSlice agreeing at the end: newest-first
 *    ordering, cents→KSh line fields, the integer-cents total;
 *  · the MaterialRequest rows the conversion writes are real and carry the
 *    notes-only lineage + material/unit/qty-only lines (raw-SQL oracle);
 *  · the MR- code sequence comes from the project's REAL request count;
 *  · createBoq versioning is per project on the real engine, and another
 *    project counts independently;
 *  · approveBoq's approve-once refusal holds on real tables;
 *  · saveSupplier's upsert targets the REAL unique (projectId, supplierId)
 *    on SavedSupplier — the constraint the stub can only pretend to have:
 *    duplicate inserts are refused through Prisma (P2002) AND the raw
 *    handle, and the unsave → re-save round-trip works;
 *  · KNOWN UNIT DRIFT #285 (twin of #282), pinned as-is with fail-on-purpose
 *    notes: createBoq/upsertBoqLine store the KSh number raw into the
 *    BigInt cents column, so loadBoqSlice's centsToKes divides by 100
 *    again. If the units get normalized, the estUnitPrice/total assertions
 *    fail on purpose — update them with the fix.
 *
 * Deliberately NOT pinned here (documented in the PR coverage map): the
 * (projectId, version) pair has no unique constraint, so two concurrent
 * createBoq calls can mint the same version — a demo-scale accepted
 * limitation, same family as the DB-8 requestCode two-generator note; and
 * MaterialRequest.requestCode is deliberately NOT unique (DB-8), so no
 * uniqueness is asserted for MR- codes.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb, seedProject } from '../helpers/db'
import {
  approveBoq,
  boqToRequest,
  createBoq,
  saveSupplier,
  unsaveSupplier,
  upsertBoqLine,
} from '@/backend/modules/inventory/service'
import { loadBoqSlice } from '@/backend/modules/inventory/repository'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

const count = (table: string, where = ''): number =>
  Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: bigint }).n)

/** Backdate a Boq row's createdAt (Prisma stores SQLite DateTime as INTEGER ms). */
function backdateBoq(boqId: string, iso: string): void {
  sqlite.prepare(`UPDATE Boq SET createdAt = ? WHERE id = ?`).run(new Date(iso).getTime(), boqId)
}

describe('BOQ lifecycle — create → lines → approve → material request (real tables)', () => {
  it('walks the lifecycle and serves it back through loadBoqSlice', async () => {
    const project = await seedProject(prisma, { name: 'BOQ Bungalow' })

    // v1 with two lines; backdated so v2's newest-first slot is deterministic.
    const v1 = await createBoq(project.id, {
      name: 'Original plan',
      lines: [
        { materialName: 'Cement', unit: 'bag', qty: 100, estUnitPrice: 700 },
        { materialName: 'Ballast', unit: 'tonne', qty: 10, estUnitPrice: 1800 },
      ],
    })
    expect(v1.version).toBe(1)
    expect(v1.name).toBe('Original plan')
    expect(v1.lines).toBe(2)
    backdateBoq(v1.id, '2026-09-01T08:00:00.000Z')

    // v2 — the version advanced within the project.
    const v2 = await createBoq(project.id, {
      name: 'Revised plan',
      lines: [{ materialName: 'Cement', unit: 'bag', qty: 120, estUnitPrice: 650, category: 'structural' }],
    })
    expect(v2.version).toBe(2)

    // upsertBoqLine: add a line, then update it IN PLACE (same id).
    const added = await upsertBoqLine(project.id, { boqId: v2.id, materialName: 'Nails', unit: 'kg', qty: 2, estUnitPrice: 90 })
    const updated = await upsertBoqLine(project.id, { boqId: v2.id, id: added.id, materialName: 'Nails', unit: 'kg', qty: 3, estUnitPrice: 95 })
    expect(updated.id).toBe(added.id)
    const nailRow = sqlite
      .prepare('SELECT qty, estUnitPrice, boqId FROM BoqLine WHERE id = ?')
      .get(added.id) as { qty: number; estUnitPrice: bigint; boqId: string }
    expect(nailRow.qty).toBe(3)
    expect(nailRow.estUnitPrice).toBe(95n) // stored raw — the #285 drift, see below
    expect(nailRow.boqId).toBe(v2.id)
    expect(count('BoqLine', `WHERE boqId = '${v2.id}'`)).toBe(2)

    // approveBoq: draft → approved on the real row.
    const approved = await approveBoq(project.id, { id: v2.id })
    expect(approved.status).toBe('approved')
    expect(
      (sqlite.prepare('SELECT status FROM Boq WHERE id = ?').get(v2.id) as { status: string }).status,
    ).toBe('approved')

    // boqToRequest with a SELECTED line: only Cement crosses over.
    const lines = await prisma.boqLine.findMany({ where: { boqId: v2.id } })
    const cement = lines.find((l) => l.materialName === 'Cement')!
    const req = await boqToRequest(project.id, { id: v2.id, lineIds: [cement.id] })
    expect(req.requestCode).toBe('MR-1001') // 1000 + real count(0) + 1
    expect(req.lines).toBe(1)

    // The MaterialRequest rows are real and carry the lineage contract.
    const mrRow = sqlite
      .prepare('SELECT requestCode, status, notes, requestedByRole, requestedByName, projectId FROM MaterialRequest WHERE id = ?')
      .get(req.id) as { requestCode: string; status: string; notes: string; requestedByRole: string; requestedByName: string; projectId: string }
    expect(mrRow.requestCode).toBe('MR-1001')
    expect(mrRow.status).toBe('draft')
    expect(mrRow.notes).toBe('From BOQ "Revised plan" v2')
    expect(mrRow.requestedByRole).toBe('contractor')
    expect(mrRow.requestedByName).toBe('Site Manager')
    expect(mrRow.projectId).toBe(project.id)
    const mrLines = sqlite
      .prepare('SELECT materialName, unit, qty FROM MaterialRequestLine WHERE requestId = ?')
      .all(req.id) as Array<{ materialName: string; unit: string; qty: number }>
    expect(mrLines).toEqual([{ materialName: 'Cement', unit: 'bag', qty: 120 }])

    // loadBoqSlice over the real rows: newest-first, cents→KSh fields, the
    // integer-cents total.
    const slice = await loadBoqSlice(project.id)
    expect(slice.boqs.map((b) => b.name)).toEqual(['Revised plan', 'Original plan'])
    const revised = slice.boqs[0]
    expect(revised.version).toBe(2)
    expect(revised.status).toBe('approved')
    // #285 drift (twin of #282), pinned as-is — fails on purpose when fixed:
    // writers store the KSh number raw into the cents column, so 650 reads
    // back as 6.5 and the total is (120×650 + 3×95)/100 = 782.85, not
    // 78,285. The arithmetic being pinned is mulQtyCents + centsToKes over
    // the column exactly as written.
    expect(revised.lines.find((l) => l.materialName === 'Cement')!.estUnitPrice).toBe(6.5)
    expect(revised.total).toBe(782.85)
    // v1 is untouched by everything above.
    const original = slice.boqs[1]
    expect(original.status).toBe('draft')
    expect(original.total).toBe((100 * 700 + 10 * 1800) / 100) // same #285 arithmetic

    // The MR- sequence advances with the project's real request count.
    const second = await boqToRequest(project.id, { id: v2.id })
    expect(second.requestCode).toBe('MR-1002')
    expect(count('MaterialRequest', `WHERE projectId = '${project.id}'`)).toBe(2)
  })

  it('createBoq versions increment per project; another project counts independently', async () => {
    const mine = await seedProject(prisma, { name: 'Version House A' })
    const theirs = await seedProject(prisma, { name: 'Version House B' })

    const a1 = await createBoq(mine.id, {})
    const a2 = await createBoq(mine.id, {})
    const a3 = await createBoq(mine.id, { name: 'Named v3' })
    expect([a1.version, a2.version, a3.version]).toEqual([1, 2, 3])
    expect(a3.name).toBe('Named v3')

    const b1 = await createBoq(theirs.id, {})
    expect(b1.version).toBe(1) // their count starts at zero
    expect(b1.name).toBe('BOQ v1')

    // The real rows carry the versions the service reported.
    const versions = sqlite
      .prepare(`SELECT version FROM Boq WHERE projectId = ? ORDER BY version`)
      .all(mine.id) as Array<{ version: bigint }>
    expect(versions.map((v) => Number(v.version))).toEqual([1, 2, 3])
  })

  it('approveBoq refuses a second approval on real tables (approve-once)', async () => {
    const project = await seedProject(prisma, { name: 'Approve Once House' })
    const boq = await createBoq(project.id, { name: 'Single approval' })
    await approveBoq(project.id, { id: boq.id })
    await expect(approveBoq(project.id, { id: boq.id })).rejects.toThrow('BOQ already approved')
    // The refusal changed nothing.
    expect(
      (sqlite.prepare('SELECT status FROM Boq WHERE id = ?').get(boq.id) as { status: string }).status,
    ).toBe('approved')
  })

  it('saveSupplier upserts against the REAL unique (projectId, supplierId); unsave round-trips', async () => {
    const project = await seedProject(prisma, { name: 'Shortlist House' })
    const other = await seedProject(prisma, { name: 'Shortlist Other' })
    const supplier = await prisma.supplier.create({ data: { businessName: 'VIP Hardware', county: 'Nairobi' } })

    // Save → a real row with the exact shortlist fields.
    const saved = await saveSupplier(project.id, { supplierId: supplier.id, savedBy: 'Akinyi', note: 'reliable' })
    const row = sqlite
      .prepare('SELECT projectId, supplierId, savedBy, note FROM SavedSupplier WHERE id = ?')
      .get(saved.id) as { projectId: string; supplierId: string; savedBy: string; note: string }
    expect(row).toEqual({ projectId: project.id, supplierId: supplier.id, savedBy: 'Akinyi', note: 'reliable' })

    // Re-save UPDATES (the upsert's target is the real unique key)…
    await saveSupplier(project.id, { supplierId: supplier.id, note: 'faster delivery' })
    expect(count('SavedSupplier', `WHERE projectId = '${project.id}'`)).toBe(1)
    expect(
      (sqlite.prepare('SELECT note FROM SavedSupplier WHERE id = ?').get(saved.id) as { note: string }).note,
    ).toBe('faster delivery')

    // …and the shortlist is per project: another project saves its own row.
    await saveSupplier(other.id, { supplierId: supplier.id })
    expect(count('SavedSupplier')).toBe(2)

    // The unique constraint is real — a duplicate pair is refused through
    // Prisma (P2002) and through the raw handle.
    await expect(
      prisma.savedSupplier.create({ data: { projectId: project.id, supplierId: supplier.id, savedBy: 'Dupe' } }),
    ).rejects.toThrow(/Unique constraint failed/)
    expect(() =>
      sqlite
        .prepare(`INSERT INTO SavedSupplier (id, projectId, supplierId, savedBy) VALUES ('ss-dupe', ?, ?, 'Dupe')`)
        .run(project.id, supplier.id),
    ).toThrow(/UNIQUE constraint failed/)
    expect(count('SavedSupplier')).toBe(2) // both probes wrote nothing

    // unsave removes only the caller's row and is idempotent.
    expect((await unsaveSupplier(project.id, { supplierId: supplier.id })).removed).toBe(true)
    expect(count('SavedSupplier', `WHERE projectId = '${project.id}'`)).toBe(0)
    expect(count('SavedSupplier', `WHERE projectId = '${other.id}'`)).toBe(1)
    expect((await unsaveSupplier(project.id, { supplierId: supplier.id })).removed).toBe(true)

    // Re-saving after an unsave re-creates the row (the toggle round-trip).
    await saveSupplier(project.id, { supplierId: supplier.id, savedBy: 'Akinyi' })
    expect(count('SavedSupplier', `WHERE projectId = '${project.id}'`)).toBe(1)
  })
})
