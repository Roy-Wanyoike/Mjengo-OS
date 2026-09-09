-- PushSubscription (issue W5-1) — the web push channel's address book. Additive
-- only: ONE CREATE TABLE + its unique index, no existing table is touched (no
-- ALTER/DROP/UPDATE/DELETE/INSERT anywhere in this file — the W4-1 discipline).
-- The virtual back-relation on User needs NO schema change: the FK lives here.
--
-- Semantics (see prisma/schema.prisma for the full honesty notes):
--   · endpoint is UNIQUE — POST /api/push/subscribe upserts on it, so there is
--     exactly one row per browser push subscription; a second user subscribing
--     from the same browser re-owns the row (that browser now belongs to that
--     session's account).
--   · rows are written even when no VAPID env is configured — the SUBSCRIPTION
--     is stored, the SENDS honestly stay 'logged' (fail-closed, like the SMS
--     providers). POST /api/push/unsubscribe (and a 404/410 from the push
--     service) deletes the row.
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "expirationTime" DATETIME,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
