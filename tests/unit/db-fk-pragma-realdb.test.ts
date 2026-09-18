/**
 * PRAGMA foreign_keys — the REAL-ENGINE half (issue #135 / audit DB-12),
 * on the issue-#184 harness (fresh migrated SQLite file per suite, real
 * PrismaClient + a better-sqlite3 handle on the same file).
 *
 * This is the verification the audit asked for (DB-12: "Prisma's SQLite
 * connector behavior should be verified once") plus the enforcement proof
 * the issue's testing requirements spell out:
 *
 *   · a fresh real PrismaClient connection reads `PRAGMA foreign_keys` = 1
 *     — the "believed on" posture, now pinned. If a future engine/driver
 *     flips that default, this fails AND the boot assert (via
 *     src/instrumentation.ts) refuses to start the server;
 *   · ensureForeignKeys() passes on the real engine (execute + read-back
 *     through the same raw-SQL surface boot uses), and REPAIRS a connection
 *     that was flipped OFF — the execute-then-verify step does real work;
 *   · FK Restrict end-to-end: an orphan Delivery (dangling materialId) is
 *     REJECTED with P2003 through the real client — enforcement, not
 *     convention;
 *   · the OFF world, both writers: the SAME insert silently succeeds when
 *     the Prisma connection's pragma is OFF, and a non-Prisma writer
 *     (better-sqlite3, per-connection posture) accepts the orphan under its
 *     own OFF — the exact corruption the boot assert rules out, and the
 *     reason every raw writer must set its own pragma.
 */
import { Prisma } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

import { ensureForeignKeys } from '@/backend/lib/db'
import { disposeRealDb, getRealTestDb, seedProject } from '../helpers/db'

const { prisma, sqlite, url } = getRealTestDb()
afterAll(disposeRealDb)

/** PRAGMA foreign_keys read through the real Prisma client (raw SQL). */
async function fkReadBack(): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe('PRAGMA foreign_keys')) as Array<{
    foreign_keys: bigint | number
  }>
  return Number(rows[0]?.foreign_keys)
}

describe('FK pragma posture on the real engine (#135 / DB-12)', () => {
  it('a fresh real PrismaClient connection has PRAGMA foreign_keys = ON — the DB-12 "believed", now pinned', async () => {
    expect(await fkReadBack()).toBe(1)
  })

  it('ensureForeignKeys() passes on the real engine — execute + read-back through the raw-SQL surface', async () => {
    await expect(ensureForeignKeys(prisma, url)).resolves.toBe('enabled')
    expect(await fkReadBack()).toBe(1)
  })

  it('a connection flipped OFF is repaired: ensureForeignKeys re-executes ON and verifies 1 — the guard does real work', async () => {
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    expect(await fkReadBack()).toBe(0) // the knob is real on this connection
    await expect(ensureForeignKeys(prisma, url)).resolves.toBe('enabled')
    expect(await fkReadBack()).toBe(1)
  })
})

describe('FK Restrict enforcement end-to-end — orphan Delivery (#135)', () => {
  const orphanDelivery = (projectId: string, materialId: string) =>
    prisma.delivery.create({
      data: {
        projectId,
        materialId, // Delivery.materialId — Restrict (schema L255-256)
        quantity: 2,
        unitCost: 10_000n, // cents (issue #122)
        totalCost: 20_000n,
        supplier: 'Nairobi Cement Works',
        date: new Date('2026-09-23T09:00:00Z'),
      },
    })

  it('an orphan Delivery (dangling materialId) is REJECTED with P2003 through the real client — zero rows land', async () => {
    const { id: projectId } = await seedProject(prisma)
    const attempt = orphanDelivery(projectId, 'material-that-does-not-exist')
    await expect(attempt).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    const err = (await attempt.catch(
      (e: unknown) => e as Prisma.PrismaClientKnownRequestError,
    )) as Prisma.PrismaClientKnownRequestError
    expect(err.code).toBe('P2003') // "Foreign key constraint failed" — the engine, not service code
    const n = sqlite.prepare(`SELECT COUNT(*) AS n FROM Delivery WHERE projectId = ?`).get(projectId) as {
      n: bigint
    }
    expect(Number(n.n)).toBe(0)
  })

  it('the SAME insert silently succeeds when the connection pragma is OFF — the exact corruption the boot assert rules out', async () => {
    const { id: projectId } = await seedProject(prisma)
    try {
      await prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
      const row = await orphanDelivery(projectId, 'dangling-under-off') // accepted: FK is a no-op
      const n = sqlite.prepare(`SELECT COUNT(*) AS n FROM Delivery WHERE id = ?`).get(row.id) as {
        n: bigint
      }
      expect(Number(n.n)).toBe(1)
      await prisma.delivery.delete({ where: { id: row.id } }) // clean up the orphan
    } finally {
      await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON')
    }
    // posture restored → the orphan shape is refused again
    await expect(orphanDelivery(projectId, 'dangling-after-restore')).rejects.toThrow()
  })

  it('a non-Prisma writer owns its pragma: better-sqlite3 defaults ON, and under OFF it accepts the orphan while the Prisma connection stays guarded', async () => {
    const { id: projectId } = await seedProject(prisma)
    // better-sqlite3 enables the pragma by default (unlike raw SQLite) —
    // pinned because the harness's direct-SQL toolkit (trigger probes,
    // sqlite_master reads) leans on real FK enforcement.
    expect(Number(sqlite.pragma('foreign_keys', { simple: true }))).toBe(1)
    sqlite.pragma('foreign_keys = OFF')
    try {
      sqlite
        .prepare(
          `INSERT INTO Delivery (id, projectId, materialId, quantity, unitCost, totalCost, supplier, date, source, createdAt)
           VALUES ('fk-raw-writer-probe', ?, 'raw-writer-dangling', 1, 5, 5, 'raw writer', '2026-09-23 09:00:00', 'manual', CURRENT_TIMESTAMP)`,
        )
        .run(projectId)
      const n = sqlite.prepare(`SELECT COUNT(*) AS n FROM Delivery WHERE id = ?`).get('fk-raw-writer-probe') as {
        n: bigint
      }
      expect(Number(n.n)).toBe(1) // a raw writer without the pragma corrupts silently
      sqlite.prepare(`DELETE FROM Delivery WHERE id = 'fk-raw-writer-probe'`).run()
    } finally {
      sqlite.pragma('foreign_keys = ON')
    }
    // Per-connection posture: the raw writer's OFF never touched the Prisma
    // connection — and both are back to enforcement.
    expect(Number(sqlite.pragma('foreign_keys', { simple: true }))).toBe(1)
    expect(await fkReadBack()).toBe(1)
  })
})
