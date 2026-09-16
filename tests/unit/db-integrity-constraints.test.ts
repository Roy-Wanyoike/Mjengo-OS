/**
 * DB integrity constraints (DB-6/DB-7/DB-8) — prisma/migrations/*.
 *
 * The shipped SQLite path enforced almost nothing at the database level:
 * attendance day-rows were unique only by convention (findFirst-then-create
 * in the appliers), supply/invoice business codes not at all, and the
 * hot-path lookups (ledger balance by account, closing stock by item,
 * attendance by project+day) were full table scans.
 *
 * This suite replays the REAL migration SQL — every migration.sql under
 * prisma/migrations, in numeric folder order — against a
 * real better-sqlite3 :memory: database (same runtime the rate-limit store
 * uses in production) and pins migration 10:
 *  · a duplicate Attendance (workerId, date) row is REJECTED by the DB;
 *  · duplicate (projectId, orderCode) PurchaseOrder and (projectId,
 *    invoiceCode) Invoice rows are rejected — while the same code in a
 *    DIFFERENT project stays legal (the generators are per-project);
 *  · every hot-path index exists in sqlite_master.
 */
import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations')

/** Migration folders in numeric prefix order (0_init, 1_…, …, 10_…). */
function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d+_/.test(d))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
}

/** A real SQLite database with the full migration history applied. */
function freshDb() {
  const db = new Database(':memory:')
  for (const dir of migrationDirs()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'))
  }
  return db
}

let db: ReturnType<typeof freshDb>
beforeEach(() => {
  db = freshDb()
  // Parent rows for the FK graph (better-sqlite3 enforces foreign_keys=ON,
  // which also incidentally pins audit DB-12's pragma posture question).
  db.exec(`
    INSERT INTO Project (id, shareToken, name, client, location, budget, startDate, targetDate, createdAt, updatedAt) VALUES
      ('p-1', 'tok-1', 'Bungalow', 'Client One', 'Nairobi', 2800000, '2026-01-06 08:00:00', '2026-12-18 17:00:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('p-2', 'tok-2', 'Duplex', 'Client Two', 'Kiambu', 5200000, '2026-02-02 08:00:00', '2027-03-19 17:00:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO Worker (id, projectId, name, role, phone, dailyRate, active) VALUES
      ('w-1', 'p-1', 'Wanjala Otieno', 'fundi', '0700000001', 800, 1),
      ('w-2', 'p-1', 'Achieng Milka', 'fundi', '0700000002', 750, 1);
    INSERT INTO Supplier (id, businessName, county, createdAt, updatedAt) VALUES
      ('sup-1', 'Nairobi Cement Works', 'Nairobi', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `)
})

describe('migration replay', () => {
  it('every migration folder parses and applies in folder order', () => {
    expect(() => freshDb()).not.toThrow()
    expect(migrationDirs().length).toBeGreaterThanOrEqual(11)
  })

  it('migration 10_integrity_constraints is part of the chain', () => {
    expect(migrationDirs()).toContain('10_integrity_constraints')
  })
})

describe('Attendance day-row uniqueness (DB-7)', () => {
  const insert = () =>
    db.prepare(
      `INSERT INTO Attendance (id, workerId, projectId, date, wage) VALUES (?, ?, ?, ?, 100)`,
    )

  it('rejects a second (workerId, date) row', () => {
    insert().run('att-1', 'w-1', 'p-1', '2026-09-16')
    expect(() => insert().run('att-2', 'w-1', 'p-1', '2026-09-16')).toThrow(/UNIQUE constraint failed/)
  })

  it('still allows the same worker on a different day, and a different worker the same day', () => {
    insert().run('att-1', 'w-1', 'p-1', '2026-09-16')
    expect(() => insert().run('att-2', 'w-1', 'p-1', '2026-09-15')).not.toThrow()
    expect(() => insert().run('att-3', 'w-2', 'p-1', '2026-09-16')).not.toThrow()
  })
})

describe('business-code uniqueness (DB-8)', () => {
  const insertOrder = () =>
    db.prepare(
      `INSERT INTO PurchaseOrder (id, orderCode, projectId, supplierId, subtotal, total, createdByRole, createdAt, updatedAt)
       VALUES (?, ?, ?, 'sup-1', 100, 100, 'contractor', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
  const insertInvoice = () =>
    db.prepare(
      `INSERT INTO Invoice (id, invoiceCode, projectId, createdAt, updatedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )

  it('rejects a duplicate (projectId, orderCode) PurchaseOrder', () => {
    insertOrder().run('po-1', 'PO-2026-000010', 'p-1')
    expect(() => insertOrder().run('po-2', 'PO-2026-000010', 'p-1')).toThrow(/UNIQUE constraint failed/)
  })

  it('allows the same orderCode in a different project (per-project generator)', () => {
    insertOrder().run('po-1', 'PO-2026-000010', 'p-1')
    expect(() => insertOrder().run('po-2', 'PO-2026-000010', 'p-2')).not.toThrow()
  })

  it('rejects a duplicate (projectId, invoiceCode) Invoice', () => {
    insertInvoice().run('inv-1', 'INV-2026-000031', 'p-1')
    expect(() => insertInvoice().run('inv-2', 'INV-2026-000031', 'p-1')).toThrow(/UNIQUE constraint failed/)
  })

  it('allows the same invoiceCode in a different project (per-project generator)', () => {
    insertInvoice().run('inv-1', 'INV-2026-000031', 'p-1')
    expect(() => insertInvoice().run('inv-2', 'INV-2026-000031', 'p-2')).not.toThrow()
  })
})

describe('hot-path indexes exist (DB-6)', () => {
  const EXPECTED_INDEXES = [
    'Attendance_workerId_date_key',
    'Attendance_projectId_date_idx',
    'PurchaseOrder_projectId_orderCode_key',
    'Invoice_projectId_invoiceCode_key',
    'LedgerEntry_accountId_idx',
    'StockMovement_inventoryItemId_idx',
  ]

  it.each(EXPECTED_INDEXES)('%s exists in sqlite_master', (name) => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name)
    expect(row).toEqual({ name })
  })
})
