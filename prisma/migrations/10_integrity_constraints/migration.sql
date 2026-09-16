-- 10_integrity_constraints (audit DB-6/DB-7/DB-8) — integrity constraints
-- and hot-path indexes for the SQLite path.
--
--   · Attendance (DB-7): UNIQUE (workerId, date) — one day-row per worker per
--     day. Until now this was convention-only (findFirst-then-create in the
--     appliers); a concurrent check-in / USSD / offline-sync pair could create
--     duplicate day rows and double-count wages. Seeds verified duplicate-free
--     (per-project workers, distinct days; seed-extras/trust.ts wipes the
--     seeded projects' attendance before recreating it).
--   · PurchaseOrder / Invoice (DB-8): UNIQUE (projectId, orderCode) and
--     UNIQUE (projectId, invoiceCode) — codes are per-project sequential
--     (supply/service.ts nextOrderCode, invoices/service.ts
--     nextInvoiceCode = max+1 on THIS project), so uniqueness is scoped to the
--     pair. MaterialRequest.requestCode is deliberately NOT constrained: it
--     has two generators (supply max+1 vs inventory count-based) whose ranges
--     can overlap.
--   · Hot-path indexes (DB-6): Attendance (projectId, date) for payload
--     slices / payroll; LedgerEntry (accountId) for derived balances (the
--     ledger + wallet services load an account's entries); StockMovement
--     (inventoryItemId) for derived closing stock.
--
-- Additive-only per house rule (CREATE INDEX only — zero data migration,
-- nothing dropped or rewritten). Applying to a database that ALREADY contains
-- duplicate day-rows or colliding codes will fail loudly — that is the point.
--
-- NOTE on ordering: Prisma applies migrations in lexicographic folder order,
-- so on a FRESH database this runs right after 0_init/1_mjengo_score rather
-- than after 9_schema_reconcile. Harmless by construction: every statement
-- below only needs tables created in 0_init, and no later migration touches
-- these indexes. Verified end-to-end: migrate deploy from scratch, drift
-- check (empty), and the full seed chain all pass.
--
-- Drift verified before/after with:
--   bunx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script   # → empty after

-- CreateIndex
CREATE INDEX "Attendance_projectId_date_idx" ON "Attendance"("projectId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_workerId_date_key" ON "Attendance"("workerId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_projectId_invoiceCode_key" ON "Invoice"("projectId", "invoiceCode");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_idx" ON "LedgerEntry"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_projectId_orderCode_key" ON "PurchaseOrder"("projectId", "orderCode");

-- CreateIndex
CREATE INDEX "StockMovement_inventoryItemId_idx" ON "StockMovement"("inventoryItemId");
