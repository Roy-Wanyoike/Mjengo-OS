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
 *
 * Migration 14 (DB-3, issue #124) — ledger invariants, pinned the same way
 * (direct SQL, no Prisma in the loop, so the TRIGGERS are what's under
 * test — exactly the writer the issue worried about):
 *  · the posting gate: pending→posted with unbalanced (or zero) legs is
 *    REJECTED; balanced legs post — the SQLite equivalent of the Supabase
 *    deferred balanced-legs constraint (0002_rls.sql L344-366);
 *  · ledger rows are append-only: LedgerEntry UPDATE/DELETE and
 *    LedgerTransaction DELETE are rejected;
 *  · the LedgerTransaction update whitelist: only pending→posted and
 *    posted→reversed (+reversalRef) are legal (0002_rls.sql L309-340);
 *  · legs may only attach to a pending transaction, and transactions are
 *    born pending — the gate cannot be skipped by direct DML;
 *  · CHECK constraints: side ∈ {debit, credit}, amount > 0;
 *  · the LedgerMaintenance flag is the documented maintenance exemption
 *    (SQLite twin of mjengo.allow_maintenance) — and the balance assertion
 *    stays ABSOLUTE even under maintenance.
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

  it('migration 14_ledger_invariants is part of the chain', () => {
    expect(migrationDirs()).toContain('14_ledger_invariants')
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

describe('migration 14 — ledger balance + append-only invariants (DB-3, issue #124)', () => {
  // Direct-SQL writers, deliberately bypassing the TypeScript service — the
  // exact threat model of the issue. Helpers mirror the service's write
  // sequence: born pending → attach legs → mark posted.
  const insertTxn = (id: string, status: string, ref = `LX-2026-${id}`) =>
    db
      .prepare(
        `INSERT INTO LedgerTransaction (id, ref, projectId, description, occurredAt, postedBy, postedRole, status, createdAt)
         VALUES (?, ?, 'p-1', 'test txn', '2026-09-16 10:00:00', 'tester', 'finance', ?, CURRENT_TIMESTAMP)`,
      )
      .run(id, ref, status)
  const insertLeg = (id: string, txnId: string, side: string, amount: number) =>
    db
      .prepare(
        `INSERT INTO LedgerEntry (id, txnId, accountId, side, amount, createdAt) VALUES (?, ?, 'acct-1', ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(id, txnId, side, amount)
  const markPosted = (id: string) =>
    db.prepare(`UPDATE LedgerTransaction SET status = 'posted' WHERE id = ?`).run(id)
  /** A fully posted balanced transaction (500 debit / 500 credit). */
  const postBalanced = (id: string) => {
    insertTxn(id, 'pending')
    insertLeg(`${id}-d`, id, 'debit', 500)
    insertLeg(`${id}-c`, id, 'credit', 500)
    markPosted(id)
  }

  beforeEach(() => {
    db.prepare(
      `INSERT INTO LedgerAccount (id, code, name, kind, normalSide, ownerType, active, createdAt)
       VALUES ('acct-1', 'TEST:CASH', 'Test cash', 'asset', 'debit', 'platform', 1, CURRENT_TIMESTAMP)`,
    ).run()
  })

  describe('posting gate — Σdebits = Σcredits (0002_rls.sql L344-366 parity)', () => {
    it('rejects marking an unbalanced transaction posted', () => {
      insertTxn('t-1', 'pending')
      insertLeg('e-1', 't-1', 'debit', 500)
      insertLeg('e-2', 't-1', 'credit', 300)
      expect(() => markPosted('t-1')).toThrow(/unbalanced ledger transaction/)
      // the failed transition leaves the row pending — never half-posted
      expect(db.prepare(`SELECT status FROM LedgerTransaction WHERE id = 't-1'`).get()).toEqual({ status: 'pending' })
    })

    it('rejects marking a leg-less transaction posted', () => {
      insertTxn('t-1', 'pending')
      expect(() => markPosted('t-1')).toThrow(/unbalanced ledger transaction/)
    })

    it('accepts a balanced transaction (the service flow, replayed in raw SQL)', () => {
      expect(() => postBalanced('t-1')).not.toThrow()
      expect(db.prepare(`SELECT status FROM LedgerTransaction WHERE id = 't-1'`).get()).toEqual({ status: 'posted' })
    })

    it('rejects a transaction born posted — the gate cannot be skipped by direct DML', () => {
      expect(() => insertTxn('t-1', 'posted')).toThrow(/born pending/)
    })

    it('rejects legs attached to a non-pending (posted) transaction', () => {
      postBalanced('t-1')
      expect(() => insertLeg('e-late', 't-1', 'debit', 100)).toThrow(/may only attach to a pending transaction/)
    })
  })

  describe('append-only rows (0002_rls.sql L281-305 parity)', () => {
    it('rejects LedgerEntry UPDATE', () => {
      postBalanced('t-1')
      expect(() => db.prepare(`UPDATE LedgerEntry SET amount = 1 WHERE id = 't-1-d'`).run()).toThrow(/append-only/)
    })

    it('rejects LedgerEntry DELETE', () => {
      postBalanced('t-1')
      expect(() => db.prepare(`DELETE FROM LedgerEntry WHERE id = 't-1-d'`).run()).toThrow(/append-only/)
    })

    it('rejects LedgerTransaction DELETE', () => {
      postBalanced('t-1')
      expect(() => db.prepare(`DELETE FROM LedgerTransaction WHERE id = 't-1'`).run()).toThrow(/append-only/)
    })

    it('rejects the Project cascade delete into ledger history (documented operational change)', () => {
      postBalanced('t-1')
      // FK-cascade deletes fire the guards (verified: SQLite runs BEFORE
      // DELETE triggers for ON DELETE CASCADE actions) — deleting a project
      // with financial history fails loudly instead of silently cascading
      // the ledger away, mirroring the Supabase design's §5.3/§9 delta.
      expect(() => db.prepare(`DELETE FROM Project WHERE id = 'p-1'`).run()).toThrow(/append-only/)
      expect(db.prepare(`SELECT COUNT(*) AS n FROM LedgerTransaction`).get()).toEqual({ n: 1 })
    })
  })

  describe('LedgerTransaction update whitelist (0002_rls.sql L309-340 parity)', () => {
    it('allows reversal marking: posted → reversed + reversalRef', () => {
      postBalanced('t-1')
      expect(() =>
        db
          .prepare(`UPDATE LedgerTransaction SET status = 'reversed', reversalRef = 'LX-2026-t-2' WHERE id = 't-1'`)
          .run(),
      ).not.toThrow()
      const row = db.prepare(`SELECT status, reversalRef FROM LedgerTransaction WHERE id = 't-1'`).get() as {
        status: string
        reversalRef: string
      }
      expect(row).toEqual({ status: 'reversed', reversalRef: 'LX-2026-t-2' })
    })

    it('rejects editing immutable columns (description, occurredAt, ref, postedBy)', () => {
      postBalanced('t-1')
      expect(() => db.prepare(`UPDATE LedgerTransaction SET description = 'hack' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      expect(() =>
        db.prepare(`UPDATE LedgerTransaction SET occurredAt = '2020-01-01 00:00:00' WHERE id = 't-1'`).run(),
      ).toThrow(/immutable/)
      expect(() => db.prepare(`UPDATE LedgerTransaction SET ref = 'LX-fake' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      expect(() => db.prepare(`UPDATE LedgerTransaction SET postedBy = 'attacker' WHERE id = 't-1'`).run()).toThrow(/immutable/)
    })

    it('rejects status edits outside the two legal transitions', () => {
      postBalanced('t-1')
      // posted → posted (no-op), posted → pending, and reversalRef without
      // the posted → reversed move are all outside the whitelist
      expect(() => db.prepare(`UPDATE LedgerTransaction SET status = 'posted' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      expect(() => db.prepare(`UPDATE LedgerTransaction SET status = 'pending' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      expect(() => db.prepare(`UPDATE LedgerTransaction SET reversalRef = 'X' WHERE id = 't-1'`).run()).toThrow(/immutable/)
      // pending → reversed skips the balance gate — rejected
      insertTxn('t-2', 'pending')
      expect(() => db.prepare(`UPDATE LedgerTransaction SET status = 'reversed' WHERE id = 't-2'`).run()).toThrow(/immutable/)
      // a reversed row is frozen
      postBalanced('t-3')
      db.prepare(`UPDATE LedgerTransaction SET status = 'reversed', reversalRef = 'LX-x' WHERE id = 't-3'`).run()
      expect(() => db.prepare(`UPDATE LedgerTransaction SET reversalRef = 'LX-y' WHERE id = 't-3'`).run()).toThrow(/immutable/)
    })
  })

  describe('CHECK constraints (0001_schema.sql L984-985 parity)', () => {
    it('rejects non-positive amounts', () => {
      insertTxn('t-1', 'pending')
      expect(() => insertLeg('e-1', 't-1', 'debit', 0)).toThrow(/LedgerEntry_amount_check/)
      expect(() => insertLeg('e-2', 't-1', 'debit', -5)).toThrow(/LedgerEntry_amount_check/)
    })

    it('rejects a side outside debit/credit', () => {
      insertTxn('t-1', 'pending')
      expect(() => insertLeg('e-1', 't-1', 'banana', 5)).toThrow(/LedgerEntry_side_check/)
    })

    it('carries both CHECKs in the table DDL (visible to introspection)', () => {
      const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'LedgerEntry'`).get() as {
        sql: string
      }
      expect(sql.sql).toContain('LedgerEntry_side_check')
      expect(sql.sql).toContain('LedgerEntry_amount_check')
    })
  })

  describe('maintenance mode — the LedgerMaintenance exemption (mjengo.allow_maintenance twin)', () => {
    const enable = () => db.prepare(`INSERT INTO LedgerMaintenance (id, allow) VALUES (1, 1)`).run()
    const disable = () => db.prepare(`UPDATE LedgerMaintenance SET allow = 0 WHERE id = 1`).run()

    it('pauses the append-only + birth-state guards while allow = 1', () => {
      postBalanced('t-1')
      enable()
      // archival ops the seeds legitimately need: wipe + born-posted backfill
      expect(() => db.prepare(`DELETE FROM LedgerEntry WHERE txnId = 't-1'`).run()).not.toThrow()
      expect(() => db.prepare(`DELETE FROM LedgerTransaction WHERE id = 't-1'`).run()).not.toThrow()
      expect(() => insertTxn('t-arch', 'posted')).not.toThrow()
      disable()
      // flag off ⇒ guards are live again
      expect(() => insertTxn('t-2', 'posted')).toThrow(/born pending/)
    })

    it('does NOT bypass the balance assertion — the invariant is absolute', () => {
      enable()
      insertTxn('t-1', 'pending')
      insertLeg('e-1', 't-1', 'debit', 500)
      insertLeg('e-2', 't-1', 'credit', 499)
      expect(() => markPosted('t-1')).toThrow(/unbalanced ledger transaction/)
      disable()
    })
  })
})
