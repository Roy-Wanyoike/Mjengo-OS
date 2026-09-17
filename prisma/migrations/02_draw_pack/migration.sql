-- DrawPack (issue W4-1) — immutable, hash-stamped evidence bundles frozen at
-- milestone release. Additive-only: ONE CREATE TABLE + its unique index, no
-- existing table is touched (no ALTER/DROP/UPDATE/DELETE/INSERT anywhere in
-- this file). Written ONCE per release — milestoneId is UNIQUE, so there is
-- exactly one pack per milestone, ever, and no row is ever updated. The pack
-- is a projection of money already moved — the ledger stays the source of
-- truth.
CREATE TABLE "DrawPack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "milestoneId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "milestoneName" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "ledgerRef" TEXT NOT NULL,
    "ledgerTxnId" TEXT NOT NULL,
    "evidencePhotoIds" TEXT NOT NULL DEFAULT '[]',
    "variationsOpen" TEXT NOT NULL DEFAULT '[]',
    "attendanceSummary" TEXT NOT NULL,
    "mjengoScore" TEXT,
    "contentHash" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DrawPack_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "Milestone" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DrawPack_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DrawPack_milestoneId_key" ON "DrawPack"("milestoneId");
