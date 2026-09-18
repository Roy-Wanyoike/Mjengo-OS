-- 19_status_ladder_checks (issue #129 — DB-10: "zero enums/CHECKs on the
-- SQLite path")
--
-- The Prisma schema carries 68 models and ZERO enum blocks: every status /
-- role / ladder column is a free-text String whose legal values live only
-- in a schema comment and in scattered TS unions / Zod schemas. A typo like
-- "recieved" or "on-hold" persisted silently and every downstream
-- === 'received' comparison quietly failed. This migration constrains the
-- ladder vocabularies at the DB level with real CHECK constraints, so a
-- wrong value dies at INSERT/UPDATE time — the same boundary the target-
-- state Supabase design already enforces.
--
-- REFERENCE SET (issue AC: "the set of constrained ladders at minimum
-- matches the Supabase design's CHECK list"): the vocabulary CHECKs of
-- supabase/migrations/0001_schema.sql (L43–L1339), ported 1:1 except for
-- the DOCUMENTED DIVERGENCES below, every one of which is a place where the
-- LIVE SQLite code writes a value the Supabase draft does not know (the
-- draft predates the waves that added them). Both paths converge when the
-- Supabase design absorbs these values — the drift points are recorded here
-- so that update is a checklist, not an archaeology dig:
--
--   1. LedgerTransaction.status = pending|posted|reversed — NOT the draft's
--      posted|reversed. Migration 14's posting gate moved the balance
--      assertion to the pending→posted transition (SQLite has no deferred
--      constraint triggers), so rows are BORN pending here; the draft's
--      two-value list would reject every legal birth.
--   2. MaterialRequest.status += cancelled and Approval.decision +=
--      withdrawn (#206): request.cancel withdraws a request pre-conversion
--      and settles its PENDING approval rows honestly as 'withdrawn'.
--   3. OrderDelivery.status += cancelled (#206): order.cancel voids an
--      in-flight dispatch.
--   4. Approval.entityType = material_request|purchase_order|invoice|
--      request — the live supply engine writes 'request' for new rows and
--      matches {request, material_request} on read (seeded legacy rows use
--      the long form); both are legal.
--   5. Transaction.method += escrow: the milestone-release spend row
--      records the escrow source (wallet/service.ts).
--   6. ParcelAssignment.status = invited|active|done|completed|withdrawn —
--      the professionals module ladder (invited/done) plus the legacy
--      seeded states; the draft lists only active/completed/withdrawn.
--   7. AuditEvent.role += admin|procurement|qs|supplier|ussd: the Bias-Free
--      Ledger records the SESSION role of the actor (all eight known roles
--      — guard.ts KNOWN_ROLES) plus the 'ussd' and 'ai' stamps and the
--      seeded 'foreman'; the draft's seven-value list predates the role
--      expansion. logAudit never throws, so this CHECK had to be exact —
--      a violation would silently drop audit rows.
--   8. LedgerTransaction.postedRole += admin: the finance surface allows
--      admin (FINANCE_ROLES) and wallet routes stamp the session role.
--
-- SCOPED OUT (documented, not silent):
--   · Attachment.entityType — a caller-supplied FREE-TEXT provenance
--     pointer, not a state machine: /api/upload accepts any non-empty
--     string ≤ 60 chars (OpenAPI documents it as a plain string; live
--     writers stamp 'photo', 'order_delivery', 'document', …). The draft's
--     seven-value CHECK does not match that API contract; constraining it
--     here would break the public upload route. The draft should adopt the
--     open list (or the API should adopt an enum) before Supabase goes
--     live — recorded for that update.
--   · LedgerEntry CHECKs already exist — migration 14 added side ∈
--     {debit, credit} and amount > 0; this migration does not rebuild that
--     table. Its LedgerEntry_insert_gate trigger references
--     LedgerTransaction, so THAT trigger is dropped before the
--     LedgerTransaction rebuild and recreated verbatim after (a dropped
--     table leaves cross-referencing triggers dangling — SQLite fails the
--     schema re-parse).
--   · AuditEvent.kind, Notification.kind, JobRecord.type, Material.unit,
--     CatalogItem.category/unit, BoqLine.category — open vocabularies by
--     design (the Supabase draft deliberately leaves them unchecked too).
--
-- SEED-DATA AUDIT (issue AC: "existing data passes"): every prisma/seed* +
-- seed-extras writer was swept against these vocabularies. ONE violation
-- found and fixed in the same change: LandParcel.tenureType carried the
-- descriptive 'leasehold 99 years from 1988' in seed-extras/land.ts — now
-- the ladder value 'leasehold' (the term detail already lives in the
-- parcel's extractedText/resultSummary demo rows).
--
-- PATTERN: the sanctioned data-preserving rebuild (migrations 12 and 14) —
-- SQLite has no ALTER TABLE ADD CHECK. Each affected table is recreated
-- byte-identical (columns, types, defaults, FKs — DDL taken verbatim from
-- the post-migration-18 schema) plus its CHECK constraints, data copied,
-- old table dropped, new one renamed, its indexes recreated. NOT additive-
-- only by necessity — same as 12/14; the copy is lossless (SELECT of every
-- column), and an existing row holding an off-ladder value aborts the
-- deploy loudly (the honest failure — no silent coercion).
--
-- SINGLE SOURCE OF TRUTH: the per-column ladder comments in
-- prisma/schema.prisma (e.g. // pending, approved, rejected, withdrawn).
-- The CHECK vocabularies here mirror those comments; adding a ladder value
-- is now a three-step contract — schema comment, this-style migration, and
-- the TS unions that validate at the API boundary. The DB is the backstop,
-- not the only gate.
--
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- AiInsight: confidence, kind, severity, source, targetType
CREATE TABLE "new_AiInsight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "packId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "detail" TEXT NOT NULL,
    "confidence" TEXT,
    "decidedBy" TEXT,
    "decision" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiInsight_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiInsight_confidence_check" CHECK ("confidence" IS NULL OR "confidence" IN ('low', 'medium', 'high')),
    CONSTRAINT "AiInsight_kind_check" CHECK ("kind" IN ('duplicate', 'phase_mismatch', 'render_suspect')),
    CONSTRAINT "AiInsight_severity_check" CHECK ("severity" IN ('info', 'warning', 'critical')),
    CONSTRAINT "AiInsight_source_check" CHECK ("source" IN ('dhash', 'vision')),
    CONSTRAINT "AiInsight_targetType_check" CHECK ("targetType" IN ('site_photo', 'draw_pack'))
);
INSERT INTO "new_AiInsight" ("id", "projectId", "targetType", "targetId", "packId", "kind", "source", "severity", "detail", "confidence", "decidedBy", "decision", "decidedAt", "createdAt") SELECT "id", "projectId", "targetType", "targetId", "packId", "kind", "source", "severity", "detail", "confidence", "decidedBy", "decision", "decidedAt", "createdAt" FROM "AiInsight";
DROP TABLE "AiInsight";
ALTER TABLE "new_AiInsight" RENAME TO "AiInsight";

-- AiReviewNote: confidence, verdict
CREATE TABLE "new_AiReviewNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawPackId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelLabel" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "verdict" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "findings" TEXT NOT NULL DEFAULT '[]',
    "inputsHash" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "decisionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiReviewNote_drawPackId_fkey" FOREIGN KEY ("drawPackId") REFERENCES "DrawPack" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiReviewNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiReviewNote_confidence_check" CHECK ("confidence" IN ('low', 'medium', 'high')),
    CONSTRAINT "AiReviewNote_verdict_check" CHECK ("verdict" IN ('consistent', 'advisory', 'escalate'))
);
INSERT INTO "new_AiReviewNote" ("id", "drawPackId", "projectId", "providerId", "modelLabel", "ruleVersion", "verdict", "summary", "confidence", "findings", "inputsHash", "reviewedBy", "reviewedAt", "decisionNote", "createdAt") SELECT "id", "drawPackId", "projectId", "providerId", "modelLabel", "ruleVersion", "verdict", "summary", "confidence", "findings", "inputsHash", "reviewedBy", "reviewedAt", "decisionNote", "createdAt" FROM "AiReviewNote";
DROP TABLE "AiReviewNote";
ALTER TABLE "new_AiReviewNote" RENAME TO "AiReviewNote";

-- Alert: severity, type
CREATE TABLE "new_Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Alert_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Alert_severity_check" CHECK ("severity" IN ('info', 'warning', 'critical')),
    CONSTRAINT "Alert_type_check" CHECK ("type" IN ('anomaly', 'budget', 'safety', 'attendance', 'progress', 'info'))
);
INSERT INTO "new_Alert" ("id", "projectId", "type", "severity", "title", "message", "acknowledged", "createdAt") SELECT "id", "projectId", "type", "severity", "title", "message", "acknowledged", "createdAt" FROM "Alert";
DROP TABLE "Alert";
ALTER TABLE "new_Alert" RENAME TO "Alert";

-- Approval: approverRole, decision, entityType
CREATE TABLE "new_Approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "approverRole" TEXT NOT NULL,
    "approverName" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Approval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Approval_approverRole_check" CHECK ("approverRole" IN ('supervisor', 'contractor', 'client', 'finance')),
    CONSTRAINT "Approval_decision_check" CHECK ("decision" IN ('pending', 'approved', 'rejected', 'withdrawn')),
    CONSTRAINT "Approval_entityType_check" CHECK ("entityType" IN ('material_request', 'purchase_order', 'invoice', 'request'))
);
INSERT INTO "new_Approval" ("id", "projectId", "entityType", "entityId", "approverRole", "approverName", "decision", "note", "decidedAt", "createdAt") SELECT "id", "projectId", "entityType", "entityId", "approverRole", "approverName", "decision", "note", "decidedAt", "createdAt" FROM "Approval";
DROP TABLE "Approval";
ALTER TABLE "new_Approval" RENAME TO "Approval";

-- ApprovalRule: approverRole
CREATE TABLE "new_ApprovalRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "minAmount" BIGINT NOT NULL DEFAULT 0,
    "maxAmount" BIGINT,
    "approverRole" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApprovalRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApprovalRule_approverRole_check" CHECK ("approverRole" IN ('supervisor', 'contractor', 'client', 'finance'))
);
INSERT INTO "new_ApprovalRule" ("id", "projectId", "minAmount", "maxAmount", "approverRole", "priority", "active", "createdAt", "updatedAt") SELECT "id", "projectId", "minAmount", "maxAmount", "approverRole", "priority", "active", "createdAt", "updatedAt" FROM "ApprovalRule";
DROP TABLE "ApprovalRule";
ALTER TABLE "new_ApprovalRule" RENAME TO "ApprovalRule";

-- Attachment: category, reviewStatus
CREATE TABLE "new_Attachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "kind" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "title" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" DATETIME,
    "ocrText" TEXT,
    "extractedJson" TEXT,
    "extractionConfidence" REAL,
    "extractionModel" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME, "objectKey" TEXT,
    CONSTRAINT "Attachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Attachment_category_check" CHECK ("category" IS NULL OR "category" IN ('contract', 'drawing', 'permit', 'receipt', 'boq', 'invoice', 'quote', 'other')),
    CONSTRAINT "Attachment_reviewStatus_check" CHECK ("reviewStatus" IN ('pending', 'approved', 'rejected'))
);
INSERT INTO "new_Attachment" ("id", "entityType", "entityId", "fileName", "storageKey", "kind", "uploadedBy", "projectId", "createdAt", "category", "mimeType", "sizeBytes", "title", "version", "expiresAt", "ocrText", "extractedJson", "extractionConfidence", "extractionModel", "reviewStatus", "reviewedBy", "reviewedAt") SELECT "id", "entityType", "entityId", "fileName", "storageKey", "kind", "uploadedBy", "projectId", "createdAt", "category", "mimeType", "sizeBytes", "title", "version", "expiresAt", "ocrText", "extractedJson", "extractionConfidence", "extractionModel", "reviewStatus", "reviewedBy", "reviewedAt" FROM "Attachment";
DROP TABLE "Attachment";
ALTER TABLE "new_Attachment" RENAME TO "Attachment";
CREATE UNIQUE INDEX "Attachment_objectKey_key" ON "Attachment"("objectKey");

-- Attendance: exceptionReason, method, status, verification
CREATE TABLE "new_Attendance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workerId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "checkIn" DATETIME,
    "checkOut" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'present',
    "method" TEXT NOT NULL DEFAULT 'geofence',
    "wage" BIGINT NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "synced" BOOLEAN NOT NULL DEFAULT true,
    "verification" TEXT NOT NULL DEFAULT 'reported',
    "evidence" TEXT,
    "exceptionReason" TEXT,
    "exceptionNote" TEXT,
    "overrideLog" TEXT,
    "recordedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "Attendance_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Attendance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Attendance_exceptionReason_check" CHECK ("exceptionReason" IS NULL OR "exceptionReason" IN ('phone_damaged', 'battery_dead', 'network', 'forgot', 'new_worker', 'emergency', 'other')),
    CONSTRAINT "Attendance_method_check" CHECK ("method" IN ('geofence', 'ussd', 'app', 'kiosk_pin', 'qr_card', 'manager')),
    CONSTRAINT "Attendance_status_check" CHECK ("status" IN ('present', 'absent', 'half_day', 'excused')),
    CONSTRAINT "Attendance_verification_check" CHECK ("verification" IN ('verified', 'reported', 'exception'))
);
INSERT INTO "new_Attendance" ("id", "workerId", "projectId", "date", "checkIn", "checkOut", "status", "method", "wage", "paid", "synced", "verification", "evidence", "exceptionReason", "exceptionNote", "overrideLog", "recordedBy", "createdAt", "version") SELECT "id", "workerId", "projectId", "date", "checkIn", "checkOut", "status", "method", "wage", "paid", "synced", "verification", "evidence", "exceptionReason", "exceptionNote", "overrideLog", "recordedBy", "createdAt", "version" FROM "Attendance";
DROP TABLE "Attendance";
ALTER TABLE "new_Attendance" RENAME TO "Attendance";
CREATE INDEX "Attendance_projectId_date_idx" ON "Attendance"("projectId", "date");
CREATE UNIQUE INDEX "Attendance_workerId_date_key" ON "Attendance"("workerId", "date");

-- AuditEvent: role
CREATE TABLE "new_AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "meta" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "before" TEXT,
    "after" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_role_check" CHECK ("role" IN ('contractor', 'foreman', 'client', 'system', 'ai', 'finance', 'supervisor', 'admin', 'procurement', 'qs', 'supplier', 'ussd'))
);
INSERT INTO "new_AuditEvent" ("id", "projectId", "kind", "actor", "role", "summary", "meta", "entity", "entityId", "before", "after", "ip", "userAgent", "requestId", "createdAt") SELECT "id", "projectId", "kind", "actor", "role", "summary", "meta", "entity", "entityId", "before", "after", "ip", "userAgent", "requestId", "createdAt" FROM "AuditEvent";
DROP TABLE "AuditEvent";
ALTER TABLE "new_AuditEvent" RENAME TO "AuditEvent";
CREATE INDEX "AuditEvent_projectId_createdAt_idx" ON "AuditEvent"("projectId", "createdAt");

-- Boq: status
CREATE TABLE "new_Boq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Boq_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Boq_status_check" CHECK ("status" IN ('draft', 'approved', 'superseded'))
);
INSERT INTO "new_Boq" ("id", "projectId", "name", "version", "status", "createdAt", "updatedAt") SELECT "id", "projectId", "name", "version", "status", "createdAt", "updatedAt" FROM "Boq";
DROP TABLE "Boq";
ALTER TABLE "new_Boq" RENAME TO "Boq";

-- CredentialCheck: method
CREATE TABLE "new_CredentialCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "professionalId" TEXT NOT NULL,
    "checkedBy" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "finding" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CredentialCheck_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "Professional" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CredentialCheck_method_check" CHECK ("method" IN ('document_review', 'reference_call', 'registry_lookup'))
);
INSERT INTO "new_CredentialCheck" ("id", "professionalId", "checkedBy", "method", "finding", "recordedAt") SELECT "id", "professionalId", "checkedBy", "method", "finding", "recordedAt" FROM "CredentialCheck";
DROP TABLE "CredentialCheck";
ALTER TABLE "new_CredentialCheck" RENAME TO "CredentialCheck";

-- Delivery: source
CREATE TABLE "new_Delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "totalCost" BIGINT NOT NULL,
    "supplier" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "rawTranscript" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Delivery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Delivery_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Delivery_source_check" CHECK ("source" IN ('manual', 'voice', 'photo', 'mpesa'))
);
INSERT INTO "new_Delivery" ("id", "projectId", "materialId", "quantity", "unitCost", "totalCost", "supplier", "date", "source", "rawTranscript", "createdAt") SELECT "id", "projectId", "materialId", "quantity", "unitCost", "totalCost", "supplier", "date", "source", "rawTranscript", "createdAt" FROM "Delivery";
DROP TABLE "Delivery";
ALTER TABLE "new_Delivery" RENAME TO "Delivery";

-- Invoice: paidByRole, paymentMethod, status
CREATE TABLE "new_Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceCode" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "orderId" TEXT,
    "supplierId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "tax" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "dueDate" DATETIME,
    "issuedAt" DATETIME,
    "submittedAt" DATETIME,
    "decidedAt" DATETIME,
    "decidedBy" TEXT,
    "paidAt" DATETIME,
    "paidByRole" TEXT,
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "createdBy" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_paidByRole_check" CHECK ("paidByRole" IS NULL OR "paidByRole" IN ('client', 'contractor', 'finance')),
    CONSTRAINT "Invoice_paymentMethod_check" CHECK ("paymentMethod" IS NULL OR "paymentMethod" IN ('mpesa', 'bank', 'card', 'wallet', 'cash')),
    CONSTRAINT "Invoice_status_check" CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected', 'paid', 'disputed'))
);
INSERT INTO "new_Invoice" ("id", "invoiceCode", "projectId", "orderId", "supplierId", "status", "subtotal", "tax", "total", "dueDate", "issuedAt", "submittedAt", "decidedAt", "decidedBy", "paidAt", "paidByRole", "paymentMethod", "paymentReference", "createdBy", "note", "createdAt", "updatedAt") SELECT "id", "invoiceCode", "projectId", "orderId", "supplierId", "status", "subtotal", "tax", "total", "dueDate", "issuedAt", "submittedAt", "decidedAt", "decidedBy", "paidAt", "paidByRole", "paymentMethod", "paymentReference", "createdBy", "note", "createdAt", "updatedAt" FROM "Invoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";
CREATE UNIQUE INDEX "Invoice_projectId_invoiceCode_key" ON "Invoice"("projectId", "invoiceCode");

-- JobRecord: status
CREATE TABLE "new_JobRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "projectId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastAttemptAt" DATETIME,
    CONSTRAINT "JobRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JobRecord_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'failed', 'retrying'))
);
INSERT INTO "new_JobRecord" ("id", "type", "projectId", "status", "payload", "result", "attempts", "lastError", "runAt", "startedAt", "finishedAt", "createdAt", "maxAttempts", "lastAttemptAt") SELECT "id", "type", "projectId", "status", "payload", "result", "attempts", "lastError", "runAt", "startedAt", "finishedAt", "createdAt", "maxAttempts", "lastAttemptAt" FROM "JobRecord";
DROP TABLE "JobRecord";
ALTER TABLE "new_JobRecord" RENAME TO "JobRecord";
CREATE INDEX "JobRecord_status_runAt_idx" ON "JobRecord"("status", "runAt");

-- LandParcel: status, tenureType
CREATE TABLE "new_LandParcel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "plotNumber" TEXT NOT NULL,
    "county" TEXT NOT NULL,
    "town" TEXT,
    "lat" REAL,
    "lng" REAL,
    "approxArea" TEXT,
    "tenureType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'searching',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LandParcel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LandParcel_status_check" CHECK ("status" IN ('searching', 'verified', 'flagged')),
    CONSTRAINT "LandParcel_tenureType_check" CHECK ("tenureType" IS NULL OR "tenureType" IN ('freehold', 'leasehold'))
);
INSERT INTO "new_LandParcel" ("id", "projectId", "plotNumber", "county", "town", "lat", "lng", "approxArea", "tenureType", "status", "createdAt", "updatedAt") SELECT "id", "projectId", "plotNumber", "county", "town", "lat", "lng", "approxArea", "tenureType", "status", "createdAt", "updatedAt" FROM "LandParcel";
DROP TABLE "LandParcel";
ALTER TABLE "new_LandParcel" RENAME TO "LandParcel";

-- LedgerAccount: kind, normalSide, ownerType
CREATE TABLE "new_LedgerAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "normalSide" TEXT NOT NULL DEFAULT 'debit',
    "projectId" TEXT,
    "ownerType" TEXT,
    "ownerId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerAccount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LedgerAccount_kind_check" CHECK ("kind" IN ('asset', 'liability', 'revenue', 'expense', 'equity')),
    CONSTRAINT "LedgerAccount_normalSide_check" CHECK ("normalSide" IN ('debit', 'credit')),
    CONSTRAINT "LedgerAccount_ownerType_check" CHECK ("ownerType" IS NULL OR "ownerType" IN ('wallet', 'escrow', 'project', 'platform'))
);
INSERT INTO "new_LedgerAccount" ("id", "code", "name", "kind", "normalSide", "projectId", "ownerType", "ownerId", "active", "createdAt") SELECT "id", "code", "name", "kind", "normalSide", "projectId", "ownerType", "ownerId", "active", "createdAt" FROM "LedgerAccount";
DROP TABLE "LedgerAccount";
ALTER TABLE "new_LedgerAccount" RENAME TO "LedgerAccount";
CREATE UNIQUE INDEX "LedgerAccount_code_key" ON "LedgerAccount"("code");

-- LedgerTransaction: postedRole, status
-- LedgerEntry_insert_gate lives on LedgerEntry but references "LedgerTransaction" — it dangles while
-- the rebuild runs, so it is dropped first and recreated verbatim below.
DROP TRIGGER IF EXISTS "LedgerEntry_insert_gate";
CREATE TABLE "new_LedgerTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ref" TEXT NOT NULL,
    "projectId" TEXT,
    "description" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedBy" TEXT NOT NULL,
    "postedRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "reversalOfId" TEXT,
    "reversalRef" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerTransaction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LedgerTransaction_postedRole_check" CHECK ("postedRole" IN ('contractor', 'client', 'finance', 'system', 'admin')),
    CONSTRAINT "LedgerTransaction_status_check" CHECK ("status" IN ('pending', 'posted', 'reversed'))
);
INSERT INTO "new_LedgerTransaction" ("id", "ref", "projectId", "description", "occurredAt", "postedBy", "postedRole", "status", "reversalOfId", "reversalRef", "idempotencyKey", "createdAt") SELECT "id", "ref", "projectId", "description", "occurredAt", "postedBy", "postedRole", "status", "reversalOfId", "reversalRef", "idempotencyKey", "createdAt" FROM "LedgerTransaction";
DROP TABLE "LedgerTransaction";
ALTER TABLE "new_LedgerTransaction" RENAME TO "LedgerTransaction";
CREATE UNIQUE INDEX "LedgerTransaction_idempotencyKey_key" ON "LedgerTransaction"("idempotencyKey");
CREATE UNIQUE INDEX "LedgerTransaction_ref_key" ON "LedgerTransaction"("ref");
-- migration 14 trigger set — recreated verbatim (DROP TABLE drops triggers)
CREATE TRIGGER "LedgerTransaction_delete_guard"
BEFORE DELETE ON "LedgerTransaction"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): ledger_transactions is append-only — DELETE rejected (set LedgerMaintenance.allow for archival ops)');
END;
CREATE TRIGGER "LedgerTransaction_insert_gate"
BEFORE INSERT ON "LedgerTransaction"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): ledger transactions are born pending — the pending→posted UPDATE is the balance gate (migration 14)')
  WHERE NEW."status" <> 'pending';
END;
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
-- cross-reference restored verbatim (migration 14 definition)
CREATE TRIGGER "LedgerEntry_insert_gate"
BEFORE INSERT ON "LedgerEntry"
WHEN NOT EXISTS (SELECT 1 FROM "LedgerMaintenance" WHERE "id" = 1 AND "allow" = 1)
BEGIN
  SELECT RAISE(ABORT, 'DB-3 (#124): ledger entries may only attach to a pending transaction (posting gate, migration 14)')
  WHERE (SELECT "status" FROM "LedgerTransaction" WHERE "id" = NEW."txnId") <> 'pending';
END;

-- MaterialRequest: requestedByRole, status
CREATE TABLE "new_MaterialRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "requestCode" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MaterialRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MaterialRequest_requestedByRole_check" CHECK ("requestedByRole" IN ('supervisor', 'contractor', 'client', 'procurement', 'finance')),
    CONSTRAINT "MaterialRequest_status_check" CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected', 'converted', 'cancelled'))
);
INSERT INTO "new_MaterialRequest" ("id", "projectId", "requestCode", "requestedByRole", "requestedByName", "notes", "status", "createdAt", "updatedAt") SELECT "id", "projectId", "requestCode", "requestedByRole", "requestedByName", "notes", "status", "createdAt", "updatedAt" FROM "MaterialRequest";
DROP TABLE "MaterialRequest";
ALTER TABLE "new_MaterialRequest" RENAME TO "MaterialRequest";

-- Milestone: status
CREATE TABLE "new_Milestone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "phaseId" TEXT,
    "name" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'locked',
    "evidencePhotoIds" TEXT NOT NULL DEFAULT '[]',
    "requestedAt" DATETIME,
    "decidedAt" DATETIME,
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "releasedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Milestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Milestone_status_check" CHECK ("status" IN ('locked', 'evidence_submitted', 'release_requested', 'approved', 'released', 'rejected'))
);
INSERT INTO "new_Milestone" ("id", "projectId", "phaseId", "name", "amount", "status", "evidencePhotoIds", "requestedAt", "decidedAt", "decidedBy", "decisionNote", "releasedAt", "createdAt") SELECT "id", "projectId", "phaseId", "name", "amount", "status", "evidencePhotoIds", "requestedAt", "decidedAt", "decidedBy", "decisionNote", "releasedAt", "createdAt" FROM "Milestone";
DROP TABLE "Milestone";
ALTER TABLE "new_Milestone" RENAME TO "Milestone";

-- MjengoScore: confidence
CREATE TABLE "new_MjengoScore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" INTEGER,
    "confidence" TEXT NOT NULL DEFAULT 'low',
    "components" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "ruleVersion" TEXT NOT NULL DEFAULT 'v1',
    CONSTRAINT "MjengoScore_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MjengoScore_confidence_check" CHECK ("confidence" IN ('low', 'medium', 'high'))
);
INSERT INTO "new_MjengoScore" ("id", "projectId", "computedAt", "score", "confidence", "components", "notes", "ruleVersion") SELECT "id", "projectId", "computedAt", "score", "confidence", "components", "notes", "ruleVersion" FROM "MjengoScore";
DROP TABLE "MjengoScore";
ALTER TABLE "new_MjengoScore" RENAME TO "MjengoScore";

-- Notification: channel, deliveryStatus
CREATE TABLE "new_Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "deliveryStatus" TEXT NOT NULL DEFAULT 'logged',
    "deliveredAt" DATETIME,
    "recipient" TEXT,
    "audienceRole" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "deliveryDetail" TEXT,
    CONSTRAINT "Notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_channel_check" CHECK ("channel" IN ('in_app', 'whatsapp', 'sms', 'push', 'email')),
    CONSTRAINT "Notification_deliveryStatus_check" CHECK ("deliveryStatus" IN ('logged', 'sent', 'failed'))
);
INSERT INTO "new_Notification" ("id", "projectId", "kind", "title", "body", "channel", "deliveryStatus", "deliveredAt", "recipient", "audienceRole", "read", "readAt", "createdAt") SELECT "id", "projectId", "kind", "title", "body", "channel", "deliveryStatus", "deliveredAt", "recipient", "audienceRole", "read", "readAt", "createdAt" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_projectId_createdAt_idx" ON "Notification"("projectId", "createdAt");
CREATE INDEX "Notification_projectId_read_idx" ON "Notification"("projectId", "read");

-- OrderDelivery: status
CREATE TABLE "new_OrderDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'dispatched',
    "dispatchedAt" DATETIME,
    "receivedAt" DATETIME,
    "receivedBy" TEXT,
    "note" TEXT,
    "photoUrls" TEXT NOT NULL DEFAULT '[]',
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "gpsLat" REAL,
    "gpsLng" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "vehicleReg" TEXT,
    "etaAt" DATETIME,
    "departedAt" DATETIME,
    "arrivedAt" DATETIME,
    CONSTRAINT "OrderDelivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderDelivery_status_check" CHECK ("status" IN ('dispatched', 'in_transit', 'arrived', 'received', 'discrepancy', 'cancelled'))
);
INSERT INTO "new_OrderDelivery" ("id", "orderId", "status", "dispatchedAt", "receivedAt", "receivedBy", "note", "photoUrls", "photoCount", "gpsLat", "gpsLng", "createdAt", "driverName", "driverPhone", "vehicleReg", "etaAt", "departedAt", "arrivedAt") SELECT "id", "orderId", "status", "dispatchedAt", "receivedAt", "receivedBy", "note", "photoUrls", "photoCount", "gpsLat", "gpsLng", "createdAt", "driverName", "driverPhone", "vehicleReg", "etaAt", "departedAt", "arrivedAt" FROM "OrderDelivery";
DROP TABLE "OrderDelivery";
ALTER TABLE "new_OrderDelivery" RENAME TO "OrderDelivery";

-- OrderDeliveryLine: condition
CREATE TABLE "new_OrderDeliveryLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deliveryId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "qtyOrdered" REAL NOT NULL,
    "qtyReceived" REAL NOT NULL,
    "qtyRejected" REAL NOT NULL DEFAULT 0,
    "damageNote" TEXT,
    "condition" TEXT NOT NULL DEFAULT 'ok',
    CONSTRAINT "OrderDeliveryLine_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "OrderDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderDeliveryLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "PurchaseOrderLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderDeliveryLine_condition_check" CHECK ("condition" IN ('ok', 'damaged', 'partial'))
);
INSERT INTO "new_OrderDeliveryLine" ("id", "deliveryId", "orderLineId", "qtyOrdered", "qtyReceived", "qtyRejected", "damageNote", "condition") SELECT "id", "deliveryId", "orderLineId", "qtyOrdered", "qtyReceived", "qtyRejected", "damageNote", "condition" FROM "OrderDeliveryLine";
DROP TABLE "OrderDeliveryLine";
ALTER TABLE "new_OrderDeliveryLine" RENAME TO "OrderDeliveryLine";

-- ParcelAssignment: role, status
CREATE TABLE "new_ParcelAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parcelId" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ParcelAssignment_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "LandParcel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ParcelAssignment_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "Professional" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ParcelAssignment_role_check" CHECK ("role" IN ('surveyor', 'advocate', 'engineer', 'qty_surveyor')),
    CONSTRAINT "ParcelAssignment_status_check" CHECK ("status" IN ('invited', 'active', 'done', 'completed', 'withdrawn'))
);
INSERT INTO "new_ParcelAssignment" ("id", "parcelId", "professionalId", "role", "status", "note", "createdAt") SELECT "id", "parcelId", "professionalId", "role", "status", "note", "createdAt" FROM "ParcelAssignment";
DROP TABLE "ParcelAssignment";
ALTER TABLE "new_ParcelAssignment" RENAME TO "ParcelAssignment";

-- ParcelDocument: kind
CREATE TABLE "new_ParcelDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parcelId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "extractedText" TEXT,
    "issuedOn" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ParcelDocument_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "LandParcel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ParcelDocument_kind_check" CHECK ("kind" IN ('title_deed', 'search_cert', 'survey_map', 'other'))
);
INSERT INTO "new_ParcelDocument" ("id", "parcelId", "kind", "fileName", "storageKey", "extractedText", "issuedOn", "createdAt") SELECT "id", "parcelId", "kind", "fileName", "storageKey", "extractedText", "issuedOn", "createdAt" FROM "ParcelDocument";
DROP TABLE "ParcelDocument";
ALTER TABLE "new_ParcelDocument" RENAME TO "ParcelDocument";

-- PaymentRequest: method, relatedEntityType, requestedByRole, status
CREATE TABLE "new_PaymentRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestCode" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "payee" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'mpesa',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "paidAt" DATETIME,
    "paidTxnId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaymentRequest_method_check" CHECK ("method" IN ('mpesa', 'bank', 'card', 'wallet', 'cash')),
    CONSTRAINT "PaymentRequest_relatedEntityType_check" CHECK ("relatedEntityType" IS NULL OR "relatedEntityType" IN ('milestone', 'invoice', 'purchase_order', 'wages', 'none')),
    CONSTRAINT "PaymentRequest_requestedByRole_check" CHECK ("requestedByRole" IN ('contractor', 'supervisor', 'finance', 'client')),
    CONSTRAINT "PaymentRequest_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'paid'))
);
INSERT INTO "new_PaymentRequest" ("id", "requestCode", "projectId", "requestedByRole", "requestedByName", "description", "amount", "payee", "method", "status", "relatedEntityType", "relatedEntityId", "decidedBy", "decidedAt", "decisionNote", "paidAt", "paidTxnId", "createdAt", "updatedAt") SELECT "id", "requestCode", "projectId", "requestedByRole", "requestedByName", "description", "amount", "payee", "method", "status", "relatedEntityType", "relatedEntityId", "decidedBy", "decidedAt", "decisionNote", "paidAt", "paidTxnId", "createdAt", "updatedAt" FROM "PaymentRequest";
DROP TABLE "PaymentRequest";
ALTER TABLE "new_PaymentRequest" RENAME TO "PaymentRequest";

-- Phase: status
CREATE TABLE "new_Phase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "budget" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progressManual" INTEGER,
    CONSTRAINT "Phase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Phase_status_check" CHECK ("status" IN ('pending', 'in_progress', 'done'))
);
INSERT INTO "new_Phase" ("id", "projectId", "name", "order", "budget", "status", "progressManual") SELECT "id", "projectId", "name", "order", "budget", "status", "progressManual" FROM "Phase";
DROP TABLE "Phase";
ALTER TABLE "new_Phase" RENAME TO "Phase";

-- PhotoComment: role
CREATE TABLE "new_PhotoComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "photoId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PhotoComment_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "SitePhoto" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PhotoComment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PhotoComment_role_check" CHECK ("role" IN ('client', 'contractor', 'foreman'))
);
INSERT INTO "new_PhotoComment" ("id", "photoId", "projectId", "author", "role", "message", "resolved", "createdAt") SELECT "id", "photoId", "projectId", "author", "role", "message", "resolved", "createdAt" FROM "PhotoComment";
DROP TABLE "PhotoComment";
ALTER TABLE "new_PhotoComment" RENAME TO "PhotoComment";

-- PricePoint: source
CREATE TABLE "new_PricePoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialName" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'seed',
    CONSTRAINT "PricePoint_source_check" CHECK ("source" IN ('order', 'manual', 'seed'))
);
INSERT INTO "new_PricePoint" ("id", "materialName", "region", "unitPrice", "recordedAt", "source") SELECT "id", "materialName", "region", "unitPrice", "recordedAt", "source" FROM "PricePoint";
DROP TABLE "PricePoint";
ALTER TABLE "new_PricePoint" RENAME TO "PricePoint";

-- Professional: category, licenceBody
CREATE TABLE "new_Professional" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "organisation" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "county" TEXT,
    "licenceNumber" TEXT,
    "licenceBody" TEXT,
    "verificationState" INTEGER NOT NULL DEFAULT 0,
    "reliabilityScore" INTEGER NOT NULL DEFAULT 50,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Professional_category_check" CHECK ("category" IN ('surveyor', 'advocate', 'engineer', 'qty_surveyor', 'architect')),
    CONSTRAINT "Professional_licenceBody_check" CHECK ("licenceBody" IS NULL OR "licenceBody" IN ('LSK', 'EBK', 'BORAQS', 'other'))
);
INSERT INTO "new_Professional" ("id", "name", "category", "organisation", "phone", "email", "county", "licenceNumber", "licenceBody", "verificationState", "reliabilityScore", "notes", "createdAt", "updatedAt") SELECT "id", "name", "category", "organisation", "phone", "email", "county", "licenceNumber", "licenceBody", "verificationState", "reliabilityScore", "notes", "createdAt", "updatedAt" FROM "Professional";
DROP TABLE "Professional";
ALTER TABLE "new_Professional" RENAME TO "Professional";

-- Project: clientType, status
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shareToken" TEXT NOT NULL,
    "shareTokenExpiresAt" DATETIME,
    "name" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "clientType" TEXT NOT NULL DEFAULT 'diaspora',
    "location" TEXT NOT NULL,
    "budget" BIGINT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "targetDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_clientType_check" CHECK ("clientType" IN ('diaspora', 'local', 'company')),
    CONSTRAINT "Project_status_check" CHECK ("status" IN ('active', 'completed', 'on_hold'))
);
INSERT INTO "new_Project" ("id", "shareToken", "shareTokenExpiresAt", "name", "client", "clientType", "location", "budget", "startDate", "targetDate", "status", "createdAt", "updatedAt") SELECT "id", "shareToken", "shareTokenExpiresAt", "name", "client", "clientType", "location", "budget", "startDate", "targetDate", "status", "createdAt", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_shareToken_key" ON "Project"("shareToken");

-- ProjectTeam: role
CREATE TABLE "new_ProjectTeam" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "note" TEXT,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectTeam_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectTeam_role_check" CHECK ("role" IN ('contractor', 'supervisor', 'qs', 'architect', 'engineer', 'surveyor', 'client_rep'))
);
INSERT INTO "new_ProjectTeam" ("id", "projectId", "name", "role", "phone", "email", "note", "joinedAt") SELECT "id", "projectId", "name", "role", "phone", "email", "note", "joinedAt" FROM "ProjectTeam";
DROP TABLE "ProjectTeam";
ALTER TABLE "new_ProjectTeam" RENAME TO "ProjectTeam";

-- PurchaseOrder: paymentSource, status
CREATE TABLE "new_PurchaseOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderCode" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requestId" TEXT,
    "supplierId" TEXT NOT NULL,
    "subtotal" BIGINT NOT NULL,
    "deliveryFee" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "paymentSource" TEXT NOT NULL DEFAULT 'client',
    "createdByRole" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MaterialRequest" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseOrder_paymentSource_check" CHECK ("paymentSource" IN ('client', 'contractor', 'project_wallet', 'finance')),
    CONSTRAINT "PurchaseOrder_status_check" CHECK ("status" IN ('draft', 'pending_approval', 'approved', 'sent', 'confirmed', 'delivering', 'delivered', 'closed', 'cancelled'))
);
INSERT INTO "new_PurchaseOrder" ("id", "orderCode", "projectId", "requestId", "supplierId", "subtotal", "deliveryFee", "total", "status", "paymentSource", "createdByRole", "note", "createdAt", "updatedAt") SELECT "id", "orderCode", "projectId", "requestId", "supplierId", "subtotal", "deliveryFee", "total", "status", "paymentSource", "createdByRole", "note", "createdAt", "updatedAt" FROM "PurchaseOrder";
DROP TABLE "PurchaseOrder";
ALTER TABLE "new_PurchaseOrder" RENAME TO "PurchaseOrder";
CREATE UNIQUE INDEX "PurchaseOrder_projectId_orderCode_key" ON "PurchaseOrder"("projectId", "orderCode");

-- Quote: status
CREATE TABLE "new_Quote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "deliveryFee" BIGINT NOT NULL DEFAULT 0,
    "transportFee" BIGINT NOT NULL DEFAULT 0,
    "fees" BIGINT NOT NULL DEFAULT 0,
    "totalLanded" BIGINT NOT NULL,
    "deliveryEta" TEXT,
    "validUntil" DATETIME,
    "terms" TEXT,
    "stockOk" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Quote_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MaterialRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Quote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Quote_status_check" CHECK ("status" IN ('requested', 'received', 'declined', 'expired'))
);
INSERT INTO "new_Quote" ("id", "requestId", "supplierId", "unitPrice", "deliveryFee", "transportFee", "fees", "totalLanded", "deliveryEta", "validUntil", "terms", "stockOk", "status", "createdAt", "updatedAt") SELECT "id", "requestId", "supplierId", "unitPrice", "deliveryFee", "transportFee", "fees", "totalLanded", "deliveryEta", "validUntil", "terms", "stockOk", "status", "createdAt", "updatedAt" FROM "Quote";
DROP TABLE "Quote";
ALTER TABLE "new_Quote" RENAME TO "Quote";

-- StockCount: status
CREATE TABLE "new_StockCount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "countedBy" TEXT NOT NULL,
    "countedAt" DATETIME NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "postedAt" DATETIME,
    "postedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockCount_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockCount_status_check" CHECK ("status" IN ('open', 'posted'))
);
INSERT INTO "new_StockCount" ("id", "projectId", "countedBy", "countedAt", "note", "status", "postedAt", "postedBy", "createdAt") SELECT "id", "projectId", "countedBy", "countedAt", "note", "status", "postedAt", "postedBy", "createdAt" FROM "StockCount";
DROP TABLE "StockCount";
ALTER TABLE "new_StockCount" RENAME TO "StockCount";
CREATE INDEX "StockCount_projectId_createdAt_idx" ON "StockCount"("projectId", "createdAt");

-- StockMovement: type
CREATE TABLE "new_StockMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unitCost" BIGINT,
    "reference" TEXT,
    "note" TEXT,
    "recordedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockMovement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_type_check" CHECK ("type" IN ('opening', 'received', 'consumed', 'transferred_in', 'transferred_out', 'returned', 'damaged', 'adjusted'))
);
INSERT INTO "new_StockMovement" ("id", "projectId", "inventoryItemId", "type", "quantity", "unitCost", "reference", "note", "recordedBy", "createdAt") SELECT "id", "projectId", "inventoryItemId", "type", "quantity", "unitCost", "reference", "note", "recordedBy", "createdAt" FROM "StockMovement";
DROP TABLE "StockMovement";
ALTER TABLE "new_StockMovement" RENAME TO "StockMovement";
CREATE INDEX "StockMovement_inventoryItemId_idx" ON "StockMovement"("inventoryItemId");

-- Task: priority, status
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phaseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "dueDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assignedToId" TEXT,
    "blockedById" TEXT,
    "blockedReason" TEXT,
    "verifiedAt" DATETIME,
    "verifiedByName" TEXT, "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "Task_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "Phase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "Worker" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_blockedById_fkey" FOREIGN KEY ("blockedById") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
    CONSTRAINT "Task_status_check" CHECK ("status" IN ('pending', 'in_progress', 'done', 'blocked'))
);
INSERT INTO "new_Task" ("id", "phaseId", "title", "status", "progress", "dueDate", "createdAt", "updatedAt", "priority", "assignedToId", "blockedById", "blockedReason", "verifiedAt", "verifiedByName") SELECT "id", "phaseId", "title", "status", "progress", "dueDate", "createdAt", "updatedAt", "priority", "assignedToId", "blockedById", "blockedReason", "verifiedAt", "verifiedByName" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";

-- TitleSearch: status, transcriptionMatch
CREATE TABLE "new_TitleSearch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parcelId" TEXT NOT NULL,
    "searchRef" TEXT NOT NULL,
    "resultSummary" TEXT,
    "transcriptionMatch" TEXT NOT NULL DEFAULT 'pending',
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" DATETIME,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TitleSearch_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "LandParcel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TitleSearch_status_check" CHECK ("status" IN ('requested', 'received', 'reviewed')),
    CONSTRAINT "TitleSearch_transcriptionMatch_check" CHECK ("transcriptionMatch" IN ('pending', 'consistent', 'mismatch'))
);
INSERT INTO "new_TitleSearch" ("id", "parcelId", "searchRef", "resultSummary", "transcriptionMatch", "status", "requestedAt", "receivedAt", "reviewedAt", "createdAt") SELECT "id", "parcelId", "searchRef", "resultSummary", "transcriptionMatch", "status", "requestedAt", "receivedAt", "reviewedAt", "createdAt" FROM "TitleSearch";
DROP TABLE "TitleSearch";
ALTER TABLE "new_TitleSearch" RENAME TO "TitleSearch";

-- Transaction: method, type
CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'mpesa',
    "reference" TEXT,
    "costCode" TEXT,
    "phaseId" TEXT,
    "ledgerTxnId" TEXT,
    "note" TEXT,
    "date" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "Phase" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_method_check" CHECK ("method" IN ('mpesa', 'cash', 'bank', 'card', 'wallet', 'escrow')),
    CONSTRAINT "Transaction_type_check" CHECK ("type" IN ('wage', 'material', 'transport', 'other', 'invoice', 'milestone', 'payment_request', 'reversal'))
);
INSERT INTO "new_Transaction" ("id", "projectId", "type", "amount", "method", "reference", "costCode", "phaseId", "ledgerTxnId", "note", "date", "createdAt") SELECT "id", "projectId", "type", "amount", "method", "reference", "costCode", "phaseId", "ledgerTxnId", "note", "date", "createdAt" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";

-- TrustDigest: audioStatus, lang
CREATE TABLE "new_TrustDigest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "windowStart" DATETIME NOT NULL,
    "windowEnd" DATETIME NOT NULL,
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "audioBase64" TEXT,
    "audioMime" TEXT,
    "audioStatus" TEXT NOT NULL DEFAULT 'unavailable',
    "audioError" TEXT,
    "providerId" TEXT,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrustDigest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrustDigest_audioStatus_check" CHECK ("audioStatus" IN ('unavailable', 'failed', 'ready')),
    CONSTRAINT "TrustDigest_lang_check" CHECK ("lang" IN ('en', 'sw'))
);
INSERT INTO "new_TrustDigest" ("id", "projectId", "lang", "windowStart", "windowEnd", "text", "textHash", "audioBase64", "audioMime", "audioStatus", "audioError", "providerId", "ruleVersion", "createdAt") SELECT "id", "projectId", "lang", "windowStart", "windowEnd", "text", "textHash", "audioBase64", "audioMime", "audioStatus", "audioError", "providerId", "ruleVersion", "createdAt" FROM "TrustDigest";
DROP TABLE "TrustDigest";
ALTER TABLE "new_TrustDigest" RENAME TO "TrustDigest";

-- User: role
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'contractor',
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notificationPrefs" TEXT
, "supplierId" TEXT,
    CONSTRAINT "User_role_check" CHECK ("role" IN ('contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs', 'supplier'))
);
INSERT INTO "new_User" ("id", "email", "passwordHash", "name", "role", "projectId", "createdAt", "notificationPrefs") SELECT "id", "email", "passwordHash", "name", "role", "projectId", "createdAt", "notificationPrefs" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- VariationOrder: status
CREATE TABLE "new_VariationOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "phaseId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "budgetImpact" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "submittedBy" TEXT,
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VariationOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VariationOrder_status_check" CHECK ("status" IN ('submitted', 'approved', 'rejected'))
);
INSERT INTO "new_VariationOrder" ("id", "projectId", "phaseId", "title", "description", "budgetImpact", "status", "submittedBy", "decidedBy", "decisionNote", "decidedAt", "createdAt") SELECT "id", "projectId", "phaseId", "title", "description", "budgetImpact", "status", "submittedBy", "decidedBy", "decisionNote", "decidedAt", "createdAt" FROM "VariationOrder";
DROP TABLE "VariationOrder";
ALTER TABLE "new_VariationOrder" RENAME TO "VariationOrder";

-- WalletAccount: ownerType, status
CREATE TABLE "new_WalletAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "status" TEXT NOT NULL DEFAULT 'active',
    "ledgerAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WalletAccount_ownerType_check" CHECK ("ownerType" IN ('project', 'organization', 'supplier', 'user')),
    CONSTRAINT "WalletAccount_status_check" CHECK ("status" IN ('active', 'frozen', 'closed'))
);
INSERT INTO "new_WalletAccount" ("id", "code", "label", "ownerType", "ownerId", "currency", "status", "ledgerAccountId", "createdAt", "updatedAt") SELECT "id", "code", "label", "ownerType", "ownerId", "currency", "status", "ledgerAccountId", "createdAt", "updatedAt" FROM "WalletAccount";
DROP TABLE "WalletAccount";
ALTER TABLE "new_WalletAccount" RENAME TO "WalletAccount";
CREATE UNIQUE INDEX "WalletAccount_code_key" ON "WalletAccount"("code");

-- Worker: employmentType
CREATE TABLE "new_Worker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "pin" TEXT,
    "dailyRate" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "idNumber" TEXT,
    "employmentType" TEXT,
    "skills" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    CONSTRAINT "Worker_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Worker_employmentType_check" CHECK ("employmentType" IS NULL OR "employmentType" IN ('casual', 'contract', 'full_time'))
);
INSERT INTO "new_Worker" ("id", "projectId", "name", "role", "phone", "pin", "dailyRate", "active", "idNumber", "employmentType", "skills", "emergencyContactName", "emergencyContactPhone") SELECT "id", "projectId", "name", "role", "phone", "pin", "dailyRate", "active", "idNumber", "employmentType", "skills", "emergencyContactName", "emergencyContactPhone" FROM "Worker";
DROP TABLE "Worker";
ALTER TABLE "new_Worker" RENAME TO "Worker";

-- ---------------------------------------------------------------------------
-- Re-enforce FKs (rebuild section ran with them off — the migration-12
-- pattern; every table name is restored, so all references resolve again).
-- ---------------------------------------------------------------------------
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
