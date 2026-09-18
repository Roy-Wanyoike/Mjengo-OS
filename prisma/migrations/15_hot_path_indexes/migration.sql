-- 15_hot_path_indexes (issue #144 — DB-6 residual: hot-path indexes) — the
-- index half of the SQL-SUM-balances change. Column pairs were picked from
-- the ACTUAL query shapes, not the audit's first guess:
--
--   · JobRecord (status, runAt) — runDueJobs drains
--     `status IN ('queued','retrying') AND runAt <= now ORDER BY runAt ASC`
--     on EVERY drain call (the pg_cron 5-min drainer + every on-demand
--     POST /api/jobs/run). Previously a full-table scan per drain.
--   · Notification (projectId, createdAt) — the notifications API list
--     (`WHERE projectId [AND createdAt < before] ORDER BY createdAt DESC
--     LIMIT n`, where createdAt also carries the `before` keyset cursor),
--     the project timeline slice and the mjengo payload's take-60 read all
--     filter projectId and order createdAt DESC.
--   · Notification (projectId, read) — the unread filter of the same list
--     (`AND read = false`) plus the markRead / notification.readAll
--     updateMany (`WHERE projectId AND read = false`). Two indexes because
--     the read paths genuinely split: ordered scans want (projectId,
--     createdAt), the unread seek/update wants (projectId, read).
--   · AuditEvent (projectId, createdAt) — project timeline (take 60), the
--     mjengo payload's take-120 audit read, and the audit API's keyset
--     pagination (createdAt DESC, id DESC after a projectId equality).
--
-- Additive-only per house rule (CREATE INDEX only — zero data migration,
-- nothing dropped or rewritten; the same posture as migration 10).
--
-- The aggregation half of #144 (SQL SUM balances via ledgerEntry.groupBy)
-- needs no new index: migration 10's LedgerEntry(accountId) already backs
-- the per-account grouped SUM.
--
-- Drift verified before/after with:
--   bunx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script   # → empty after

-- CreateIndex
CREATE INDEX "AuditEvent_projectId_createdAt_idx" ON "AuditEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "JobRecord_status_runAt_idx" ON "JobRecord"("status", "runAt");

-- CreateIndex
CREATE INDEX "Notification_projectId_createdAt_idx" ON "Notification"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_projectId_read_idx" ON "Notification"("projectId", "read");
