-- 17_idempotency_principal_scope (issue #177 / audit SEC-10) — the
-- Idempotency-Key replay keyspace is scoped PER PRINCIPAL.
--
-- BEFORE: `key` was GLOBALLY unique — one actor's caller-chosen key could
-- collide with / claim another actor's replay record (cross-wallet /
-- cross-actor confusion: a foreign actor presenting someone else's key got
-- that actor's stored result, and owner-role sessions additionally received
-- the full current project payload of whatever project the key belonged to).
--
-- AFTER: the composite UNIQUE (principal, scope, key). The principal is
-- derived at the one seam (src/backend/lib/idempotency.ts):
--   · `user:<email>[|<resource>]` — session callers; the resource suffix is
--     the wallet / payment request / project the route acts on, so replay
--     protection is per wallet/actor on the v1 money routes and per
--     project/actor on /api/actions;
--   · `share:<sha256(token)>` — share-link callers (hash, never the raw
--     secret; a rotated link is a fresh principal by construction);
--   · `sync:<projectId|global>` — the offline-outbox dedupe markers
--     (`sync:`/`syncfp:` keys, which already embed the project — the
--     derivation below matches the key's own segment so replays survive);
--   · `system` — server-generated Daraja markers (`daraja.*:` keys).
--
-- BACKFILL (executed below, before the index swap):
--   · `sync:%` / `syncfp:%` rows → principal 'sync:<projectId|global>',
--     derived from the key's own project segment (both prefixes are 7
--     bytes, so one substr() serves both) — post-migration re-flushes of
--     already-applied outbox items still dedupe, no double-apply window;
--   · `daraja.%` rows → principal 'system' — provider-ref keyed, semantics
--     unchanged;
--   · everything else (caller-chosen header keys written by /api/actions
--     and /api/v1 before #177) → principal 'legacy'. These rows are
--     UNREACHABLE by the new namespaced lookups — deliberately fail-closed
--     (the issue offers "backfill the namespace, or keep global lookup for
--     legacy rows behind a flag"; a global fallback would reopen the exact
--     cross-actor oracle #177 closes, so the sentinel wins). An in-flight
--     retry that spans the deploy re-executes as a fresh request; money
--     re-execution is prevented by the service-level natural keys
--     (LedgerTransaction.idempotencyKey — #75/BE-3, #122/#124 — payment
--     status guards, escrow reference keys), which are independent of this
--     table. No production DB exists (dev/demo reseed — the #282/#285
--     precedent).
--
-- The column is added NOT NULL DEFAULT '' (SQLite cannot add NOT NULL
-- without a default); the '' bucket is empty post-backfill and means
-- "unscoped write" — the new lookups never read it (fail-closed).
--
-- Drift verified before/after with:
--   bunx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script   # → empty after

-- AlterTable
ALTER TABLE "IdempotencyRecord" ADD COLUMN "principal" TEXT NOT NULL DEFAULT '';

-- Backfill BEFORE the index swap (see header). SQLite substr() is 1-BASED:
-- the project segment of a `sync:` key starts at char 6 ('sync:' = 5 chars)
-- and of a `syncfp:` key at char 8 ('syncfp:' = 7 chars) — two statements,
-- each slicing from the segment start to the next ':' (`sync:p-1:item` →
-- 'p-1', `sync:global:item` → 'global', `syncfp:p-2:type:hash` → 'p-2').
UPDATE "IdempotencyRecord"
SET "principal" = 'sync:' || substr("key", 6, instr(substr("key", 6), ':') - 1)
WHERE "key" LIKE 'sync:%';

UPDATE "IdempotencyRecord"
SET "principal" = 'sync:' || substr("key", 8, instr(substr("key", 8), ':') - 1)
WHERE "key" LIKE 'syncfp:%';

UPDATE "IdempotencyRecord" SET "principal" = 'system' WHERE "key" LIKE 'daraja.%';

UPDATE "IdempotencyRecord" SET "principal" = 'legacy' WHERE "principal" = '';

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_principal_scope_key_key" ON "IdempotencyRecord"("principal", "scope", "key");

-- DropIndex
DROP INDEX "IdempotencyRecord_key_key";
