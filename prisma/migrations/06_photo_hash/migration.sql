-- PhotoHash (issue W6-3 — Evidence Authenticity Screen) — the 64-bit dHash of
-- a SitePhoto's stored bytes, computed at draw-pack freeze or on the on-demand
-- backfill run. Additive-only: ONE CREATE TABLE + its unique index, no
-- existing table is touched (no ALTER/DROP/UPDATE/DELETE/INSERT anywhere in
-- this file). Append-only: no Wave-6 code path updates or deletes a PhotoHash
-- row — a photo's perceptual fingerprint is immutable history, and the
-- photoId UNIQUE constraint makes the backfill idempotent (second screen run
-- → cache hit, nothing recomputed). photoId/packId are deliberately PLAIN
-- columns, not FK constraints: the parallel-wave schema rule is
-- append-at-end model blocks (the existing SitePhoto/DrawPack blocks stay
-- untouched), and packs are themselves never deleted so nothing dangles.
CREATE TABLE "PhotoHash" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "photoId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "hashHex" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "packId" TEXT,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PhotoHash_photoId_key" ON "PhotoHash"("photoId");
