-- 16_stock_reconciliation (issue #194) — the count → variance → count-linked
-- adjustment loop for the Site Store.
--
-- ADDITIVE-ONLY (house rule): two CREATE TABLEs + their unique/index
-- statements. No existing table is touched — the append-only StockMovement
-- ledger is NOT altered; count-linked adjustments are plain `adjusted`
-- movements whose reference carries the lineage ('count:<countId>', the same
-- source-link convention the column already uses for PO/delivery ids).
--
--   · StockCount — one physical count session per project: countedBy,
--     countedAt, note, status ('open' → 'posted' is the posting gate),
--     postedAt/postedBy (the transition record). No updatedAt on purpose:
--     postedAt IS the one legal state transition's timestamp.
--   · StockCountItem — one counted line per InventoryItem (material ×
--     location): countedQty (ground truth), expectedQty (derived-closing
--     snapshot at count time — pinned so later movements never rewrite
--     history), postedQty (the adjustment appended from this line; null
--     until posted; zero-variance lines post 0 and no movement row).
--
-- Variance is NOT stored: it is always expectedQty − countedQty (one
-- definition in modules/inventory/repository.ts, exactly like
-- movementDelta/derivedClosingQty). Quantities stay Float/REAL per the #122
-- design (money went integer-cents; quantities did not).
--
-- Drift verified before/after with:
--   bunx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script   # → empty after

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "countedBy" TEXT NOT NULL,
    "countedAt" DATETIME NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "postedAt" DATETIME,
    "postedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockCount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockCountItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "countId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "countedQty" REAL NOT NULL,
    "expectedQty" REAL NOT NULL,
    "postedQty" REAL,
    CONSTRAINT "StockCountItem_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockCountItem_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "StockCountItem_countId_inventoryItemId_key" ON "StockCountItem"("countId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "StockCount_projectId_createdAt_idx" ON "StockCount"("projectId", "createdAt");
