-- 14_ledger_invariants (issue #124 — DB-3: "the ledger never lies")
--
-- DB-level enforcement of the two ledger invariants on the SQLite path,
-- porting the semantics of the target-state Supabase design
-- (supabase/migrations/0002_rls.sql):
--   · L309–340  guard_ledger_txn_update  → LedgerTransaction_update_guard
--               (reversal-only update whitelist) below, extended with the
--               posting transition this design needs (see DESIGN NOTE);
--   · L281–305  reject_mutation on ledger_entries + the
--               ledger_transactions delete guard → the append-only
--               BEFORE UPDATE/DELETE triggers below;
--   · L344–366  deferred balanced-legs constraint trigger →
--               LedgerTransaction_posting_gate below;
--   · 0001_schema.sql L984–985 ledger_entries CHECKs (side, amount > 0)
--               → real CHECK constraints via a data-preserving rebuild
--                 (the same sanctioned rebuild pattern as migration 12).
--
-- DESIGN NOTE — the enforcement point for Σdebits = Σcredits.
-- Postgres can defer the balance assertion to COMMIT; SQLite has NO
-- deferred triggers and NO commit-time hooks, so a per-entry AFTER INSERT
-- assertion cannot work here: Prisma writes a transaction's legs as
-- SEPARATE INSERT statements inside the posting db.$transaction (nested
-- create → one INSERT per row; the seed loop is per-row too), so a row-
-- level balance check would fire after the FIRST leg and abort every
-- legitimate multi-leg post mid-batch.
-- The honest SQLite equivalent is to gate the LAST write of the posting
-- flow: the service (and any other writer) now creates the transaction
-- with status 'pending', attaches its legs, and marks it 'posted' with a
-- final UPDATE — LedgerTransaction_posting_gate asserts Σdebits = Σcredits
-- (and ≥ 1 leg) at exactly that transition, inside the same SQLite
-- transaction, so an unbalanced transaction can never become visible as
-- posted and a failure rolls back the whole post. Direct writers cannot
-- skip the gate: LedgerTransaction_insert_gate rejects rows born with any
-- status other than 'pending', and LedgerEntry_insert_gate rejects legs
-- attached to a transaction that is not pending. The full legal lifecycle
-- is therefore: pending → posted (balance-asserted) → reversed (marking
-- only). This mirrors the Supabase state machine with the assertion moved
-- from COMMIT to the posting transition — the closest commit-equivalent
-- seam SQLite offers.
--
-- MAINTENANCE MODE — the SQLite twin of mjengo.allow_maintenance (design
-- §5.3/§9). One row in LedgerMaintenance (id=1, allow=true) disables the
-- append-only / birth-state / whitelist guards for archival operations
-- (seeds, supervised backfills). The flag is checked in each trigger's
-- WHEN clause, exactly like maintenance_allowed() in 0002_rls.sql.
-- Deliberately NOT maintenance-aware: the posting-gate balance assertion
-- (matches the Supabase constraint trigger, which maintenance cannot
-- bypass either) and the CHECK constraints.
--
-- KNOWN LIMITATIONS (documented honestly):
--   · A rogue writer can still INSERT a 'pending' transaction with
--     unbalanced legs and abandon it — SQLite cannot police rows that are
--     never marked posted. Such rows are visible as pending; they can
--     never become posted. The service never leaves pending rows behind
--     (it completes or rolls back atomically).
--   · Under maintenance, legs attached directly to a born-'posted' row
--     (backfill path) are not balance-checked per-statement — SQLite
--     row-triggers fire mid-batch on multi-row INSERTs, so a check there
--     would reject balanced backfills. Supabase is stricter here (its
--     constraint trigger fires at COMMIT regardless of maintenance).
--   · `prisma db push` does not replay migrations: triggers/CHECKs only
--     exist on migrate-deployed databases. Use `prisma migrate deploy`.
--
-- CASCADE NOTE (verified empirically on SQLite 3.53 / better-sqlite3 with
-- default pragmas): FK ON DELETE CASCADE actions DO fire these BEFORE
-- DELETE guards (the recursive_triggers pragma governs trigger→trigger
-- recursion, not FK-action→trigger). Deleting a row that cascades into
-- ledger history — e.g. a Project — therefore fails loudly unless
-- maintenance is enabled, which mirrors the Supabase design's documented
-- behavioral delta ("project DELETE cascades now fail against append-only
-- triggers unless mjengo.allow_maintenance is set", design §5.3/§9). The
-- demo seeds wrap their destructive wipes in maintenance mode.
--
-- NOT purely additive: LedgerEntry is rebuilt to carry the two CHECK
-- constraints (SQLite has no ALTER TABLE ADD CONSTRAINT). Data-preserving
-- copy, same pattern as migration 12. Verified additive-safe on the demo
-- dataset (all seeded legs are positive debit/credit cents).

-- ---------------------------------------------------------------------------
-- §1 LedgerEntry rebuild — CHECK constraints (0001_schema.sql L984–985)
-- ---------------------------------------------------------------------------
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "txnId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "memo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_txnId_fkey" FOREIGN KEY ("txnId") REFERENCES "LedgerTransaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LedgerEntry_side_check" CHECK ("side" IN ('debit', 'credit')),
    CONSTRAINT "LedgerEntry_amount_check" CHECK ("amount" > 0)
);
INSERT INTO "new_LedgerEntry" ("accountId", "amount", "createdAt", "id", "memo", "side", "txnId") SELECT "accountId", "amount", "createdAt", "id", "memo", "side", "txnId" FROM "LedgerEntry";
DROP TABLE "LedgerEntry";
ALTER TABLE "new_LedgerEntry" RENAME TO "LedgerEntry";
CREATE INDEX "LedgerEntry_accountId_idx" ON "LedgerEntry"("accountId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- §2 Maintenance flag — SQLite twin of mjengo.allow_maintenance (§5.3/§9).
-- Absent row / allow=false ⇒ every guard below is live. One row, id=1.
-- Kept in sync with the LedgerMaintenance model in schema.prisma so
-- `prisma migrate diff` stays clean and seeds can flip it via the client.
-- ---------------------------------------------------------------------------
CREATE TABLE "LedgerMaintenance" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "allow" BOOLEAN NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------
-- §3 Append-only guards — reject_mutation parity (0002_rls.sql L281–305)
-- ---------------------------------------------------------------------------
CREATE TRIGGER "LedgerEntry_update_guard"
BEFORE UPDATE ON "LedgerEntry"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): ledger_entries is append-only — UPDATE rejected (corrections are new reversal transactions)');
END;

CREATE TRIGGER "LedgerEntry_delete_guard"
BEFORE DELETE ON "LedgerEntry"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): ledger_entries is append-only — DELETE rejected (set LedgerMaintenance.allow for archival ops)');
END;

CREATE TRIGGER "LedgerTransaction_delete_guard"
BEFORE DELETE ON "LedgerTransaction"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): ledger_transactions is append-only — DELETE rejected (set LedgerMaintenance.allow for archival ops)');
END;

-- ---------------------------------------------------------------------------
-- §4 Birth-state gates — every posted transaction must pass the posting
--    transition, so the balance assertion cannot be skipped by direct DML.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "LedgerTransaction_insert_gate"
BEFORE INSERT ON "LedgerTransaction"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): ledger transactions are born pending — the pending→posted UPDATE is the balance gate (migration 14)')
  WHERE NEW."status" <> 'pending';
END;

CREATE TRIGGER "LedgerEntry_insert_gate"
BEFORE INSERT ON "LedgerEntry"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): ledger entries may only attach to a pending transaction (posting gate, migration 14)')
  WHERE (SELECT "status" FROM "LedgerTransaction" WHERE "id" = NEW."txnId") <> 'pending';
END;

-- ---------------------------------------------------------------------------
-- §5 Update whitelist — guard_ledger_txn_update parity (0002_rls.sql
--    L309–340): the ONLY legal mutations of a ledger transaction are
--    ① pending → posted (the posting transition; balance asserted by §6)
--    ② posted → reversed + reversalRef (reversal marking).
--    Everything else — ref/description/occurredAt/postedBy/postedRole/
--    projectId/idempotencyKey/reversalOfId/createdAt edits, status
--    regressions, edits of a reversed row — is rejected.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "LedgerTransaction_update_guard"
BEFORE UPDATE ON "LedgerTransaction"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): ledger_transactions is immutable except posting (pending→posted) and reversal marking (posted→reversed + reversalRef)')
  WHERE NEW."id" <> OLD."id"
     OR NEW."ref" IS NOT OLD."ref"
     OR NEW."description" IS NOT OLD."description"
     OR NEW."occurredAt" IS NOT OLD."occurredAt"
     OR NEW."projectId" IS NOT OLD."projectId"
     OR NEW."postedBy" IS NOT OLD."postedBy"
     OR NEW."postedRole" IS NOT OLD."postedRole"
     OR NEW."idempotencyKey" IS NOT OLD."idempotencyKey"
     OR NEW."reversalOfId" IS NOT OLD."reversalOfId"
     OR NEW."createdAt" IS NOT OLD."createdAt"
     OR (NEW."reversalRef" IS NOT OLD."reversalRef"
         AND NOT (OLD."status" = 'posted' AND NEW."status" = 'reversed'))
     OR NOT ((OLD."status" = 'pending' AND NEW."status" = 'posted')
          OR (OLD."status" = 'posted' AND NEW."status" = 'reversed'));
END;

-- ---------------------------------------------------------------------------
-- §6 The posting gate — assert_ledger_balanced parity (0002_rls.sql
--    L344–366). Fires at the pending→posted transition (see DESIGN NOTE):
--    the parent's legs already exist, the sums are exact integer cents,
--    and the whole posting transaction rolls back on violation. NOT
--    maintenance-aware — like the Supabase constraint trigger, the
--    balance invariant is absolute.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "LedgerTransaction_posting_gate"
AFTER UPDATE OF "status" ON "LedgerTransaction"
WHEN NEW."status" = 'posted' AND OLD."status" = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): unbalanced ledger transaction at the posting gate — Σdebits ≠ Σcredits (or no legs)')
  WHERE EXISTS (
    SELECT COUNT(*) FROM "LedgerEntry" WHERE "txnId" = NEW."id"
    HAVING COUNT(*) = 0
        OR COALESCE(SUM(CASE WHEN "side" = 'debit' THEN "amount" ELSE -"amount" END), 0) <> 0
  );
END;
