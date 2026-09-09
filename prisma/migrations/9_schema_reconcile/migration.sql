-- 9_schema_reconcile (issue #73, audit BE-1) — additive reconciliation of
-- prisma/migrations 0–8 with prisma/schema.prisma.
--
-- The Wave 2–6 schema drifted ahead of the migration history: five pieces
-- landed via `prisma db push` during development and were never captured as
-- SQL. A fresh `prisma migrate deploy` (the Dockerfile boot path) therefore
-- produced a database that did NOT match the generated Prisma client:
--   · Task.version, Attendance.version — offline-sync entity versions
--     (/api/sync outbox conflict rejection); every existing row becomes
--     version 1, exactly what a fresh row would get.
--   · Transaction.phaseId — phase cost-code attribution (issue #39);
--     nullable, legacy rows legitimately stay NULL.
--   · Notification.deliveryDetail — delivery detail recorded by the notify
--     channels (webhook/AT provider refs, honest failure reasons); nullable.
--   · DeliveryPhoto table + unique key + index — W5-3 delivery photo
--     evidence (photo attachments linked to order deliveries/lines).
--
-- Everything here is additive-only (ALTER TABLE ADD COLUMN with safe
-- defaults / CREATE TABLE / CREATE INDEX): zero data migration, nothing
-- dropped or rewritten. Existing `db push`-based databases already contain
-- every piece (they were pushed from the same schema.prisma) — this
-- migration exists so migrate-managed databases reach the SAME shape.
--
-- Drift verified before/after with:
--   bunx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script   # → empty after

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Attendance" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Notification" ADD COLUMN "deliveryDetail" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "phaseId" TEXT REFERENCES "Phase" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "DeliveryPhoto" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deliveryId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "deliveryLineId" TEXT,
    "attachedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeliveryPhoto_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "OrderDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeliveryPhoto_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeliveryPhoto_deliveryLineId_fkey" FOREIGN KEY ("deliveryLineId") REFERENCES "OrderDeliveryLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DeliveryPhoto_deliveryLineId_idx" ON "DeliveryPhoto"("deliveryLineId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPhoto_deliveryId_attachmentId_key" ON "DeliveryPhoto"("deliveryId", "attachmentId");
