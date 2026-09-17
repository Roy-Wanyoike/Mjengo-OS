-- ═══════════════════════════════════════════════════════════════════════════════
-- MjengoOS — Construction Site OS · Supabase / PostgreSQL schema
-- 37 tables · full relationship graph · mirrors prisma/schema.prisma 1:1
--
-- Apply: Supabase Dashboard → SQL Editor → paste → Run
--   (or: psql "$DATABASE_URL" -f supabase/schema.sql)
--   (or: place in supabase/migrations/0001_init.sql → supabase db push)
--
-- Conventions:
--   · Identifiers are quoted to preserve camelCase — matches Prisma naming exactly,
--     so `prisma db pull` (introspection) maps back to the schema with zero drift.
--   · IDs are TEXT primary keys holding app-generated cuids (Prisma default).
--     To use Postgres UUIDs instead: swap to `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
--     and update the Prisma schema (`@default(uuid())`).
--   · TIMESTAMP(3) matches Prisma's Postgres DateTime mapping.
--   · Prisma doesn't model CHECK constraints, so enum-like TEXT columns carry their
--     valid values as comments (adding CHECKs would make `prisma db push` drift).
--   · updatedAt columns carry DEFAULT now() as a backstop; Prisma maintains them.
--   · ON DELETE actions mirror schema.prisma exactly (CASCADE / SET NULL / RESTRICT).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- SECTION 1 · CORE — identity, projects, plan, workforce
-- ─────────────────────────────────────────────────────────────

-- NextAuth credentials users (contractor / client / admin)
CREATE TABLE IF NOT EXISTS "User" (
  "id"           TEXT PRIMARY KEY,
  "email"        TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "role"         TEXT NOT NULL DEFAULT 'contractor',  -- contractor, client, admin
  "projectId"    TEXT,                                -- client-role user's pinned project (no FK — soft link)
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Project" (
  "id"           TEXT PRIMARY KEY,
  "shareToken"   TEXT NOT NULL UNIQUE,                -- zero-login client view token
  "name"         TEXT NOT NULL,
  "client"       TEXT NOT NULL,
  "clientType"   TEXT NOT NULL DEFAULT 'diaspora',    -- diaspora, local, company
  "location"     TEXT NOT NULL,
  "budget"       DOUBLE PRECISION NOT NULL,
  "startDate"    TIMESTAMP(3) NOT NULL,
  "targetDate"   TIMESTAMP(3) NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'active',      -- active, completed, on_hold
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Phase" (
  "id"             TEXT PRIMARY KEY,
  "projectId"      TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "name"           TEXT NOT NULL,
  "order"          INTEGER NOT NULL,
  "budget"         DOUBLE PRECISION NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'pending',   -- pending, in_progress, done
  "progressManual" INTEGER,                           -- manual override; falls back to tasks average
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Phase_projectId_idx" ON "Phase"("projectId");

CREATE TABLE IF NOT EXISTS "Task" (
  "id"        TEXT PRIMARY KEY,
  "phaseId"   TEXT NOT NULL REFERENCES "Phase"("id") ON DELETE CASCADE,
  "title"     TEXT NOT NULL,
  "status"    TEXT NOT NULL DEFAULT 'pending',        -- pending, in_progress, done, blocked
  "progress"  INTEGER NOT NULL DEFAULT 0,
  "dueDate"   TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Task_phaseId_idx" ON "Task"("phaseId");

CREATE TABLE IF NOT EXISTS "Worker" (
  "id"        TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "name"      TEXT NOT NULL,
  "role"      TEXT NOT NULL,                          -- Fundi wa Mawe (Mason), Foreman, Mtumishi (Labourer)...
  "phone"     TEXT NOT NULL,
  "pin"       TEXT,                                   -- 4-digit kiosk PIN (shared site device identity)
  "dailyRate" DOUBLE PRECISION NOT NULL,
  "active"    BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS "Worker_projectId_idx" ON "Worker"("projectId");

-- Workforce Trust attendance: reported vs verified presence
CREATE TABLE IF NOT EXISTS "Attendance" (
  "id"              TEXT PRIMARY KEY,
  "workerId"        TEXT NOT NULL REFERENCES "Worker"("id") ON DELETE CASCADE,
  "projectId"       TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "date"            TEXT NOT NULL,                    -- YYYY-MM-DD
  "checkIn"         TIMESTAMP(3),
  "checkOut"        TIMESTAMP(3),
  "status"          TEXT NOT NULL DEFAULT 'present',  -- present, absent, half_day, excused
  "method"          TEXT NOT NULL DEFAULT 'geofence', -- geofence, ussd, app, kiosk_pin, qr_card, manager
  "wage"            DOUBLE PRECISION NOT NULL,
  "paid"            BOOLEAN NOT NULL DEFAULT false,
  "synced"          BOOLEAN NOT NULL DEFAULT true,
  "verification"    TEXT NOT NULL DEFAULT 'reported', -- verified, reported, exception
  "evidence"        TEXT,                             -- JSON array of evidence signals (gps, pin, qr, photo, supervisor, ussd)
  "exceptionReason" TEXT,                             -- phone_damaged, battery_dead, network, forgot, new_worker, emergency, other
  "exceptionNote"   TEXT,
  "overrideLog"     TEXT,                             -- JSON array of {at, by, from, to, reason} — append-only
  "recordedBy"      TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Attendance_workerId_idx"  ON "Attendance"("workerId");
CREATE INDEX IF NOT EXISTS "Attendance_projectId_idx" ON "Attendance"("projectId");
CREATE INDEX IF NOT EXISTS "Attendance_date_idx"      ON "Attendance"("date");

-- ─────────────────────────────────────────────────────────────
-- SECTION 2 · OPERATIONS — materials, evidence, money basics
-- ─────────────────────────────────────────────────────────────

-- Global material catalog (shared across projects — no projectId by design)
CREATE TABLE IF NOT EXISTS "Material" (
  "id"        TEXT PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "unit"      TEXT NOT NULL,                          -- bag, tonne, piece, roll, kg, metre
  "unitPrice" DOUBLE PRECISION NOT NULL               -- indicative KES price
);

CREATE TABLE IF NOT EXISTS "Delivery" (
  "id"            TEXT PRIMARY KEY,
  "projectId"     TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "materialId"    TEXT NOT NULL REFERENCES "Material"("id") ON DELETE RESTRICT,
  "quantity"      DOUBLE PRECISION NOT NULL,
  "unitCost"      DOUBLE PRECISION NOT NULL,
  "totalCost"     DOUBLE PRECISION NOT NULL,
  "supplier"      TEXT NOT NULL,
  "date"          TIMESTAMP(3) NOT NULL,
  "source"        TEXT NOT NULL DEFAULT 'manual',     -- manual, voice, photo, mpesa
  "rawTranscript" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Delivery_projectId_idx"  ON "Delivery"("projectId");
CREATE INDEX IF NOT EXISTS "Delivery_materialId_idx" ON "Delivery"("materialId");

CREATE TABLE IF NOT EXISTS "Consumption" (
  "id"         TEXT PRIMARY KEY,
  "projectId"  TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "materialId" TEXT NOT NULL REFERENCES "Material"("id") ON DELETE RESTRICT,
  "quantity"   DOUBLE PRECISION NOT NULL,
  "phaseName"  TEXT,
  "date"       TIMESTAMP(3) NOT NULL,
  "note"       TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Consumption_projectId_idx"  ON "Consumption"("projectId");
CREATE INDEX IF NOT EXISTS "Consumption_materialId_idx" ON "Consumption"("materialId");

CREATE TABLE IF NOT EXISTS "SitePhoto" (
  "id"          TEXT PRIMARY KEY,
  "projectId"   TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "phaseId"     TEXT REFERENCES "Phase"("id") ON DELETE SET NULL,
  "zoneId"      TEXT,                                 -- soft link to SiteZone (no FK — photos survive zone drift)
  "url"         TEXT NOT NULL,
  "caption"     TEXT,
  "analysis"    TEXT,                                 -- JSON string with VLM analysis
  "progressPct" INTEGER,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "SitePhoto_projectId_idx" ON "SitePhoto"("projectId");
CREATE INDEX IF NOT EXISTS "SitePhoto_phaseId_idx"   ON "SitePhoto"("phaseId");
CREATE INDEX IF NOT EXISTS "SitePhoto_zoneId_idx"    ON "SitePhoto"("zoneId");

CREATE TABLE IF NOT EXISTS "Alert" (
  "id"           TEXT PRIMARY KEY,
  "projectId"    TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "type"         TEXT NOT NULL,                       -- anomaly, budget, safety, attendance, progress, info
  "severity"     TEXT NOT NULL DEFAULT 'info',        -- info, warning, critical
  "title"        TEXT NOT NULL,
  "message"      TEXT NOT NULL,
  "acknowledged" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Alert_projectId_idx" ON "Alert"("projectId");

CREATE TABLE IF NOT EXISTS "Transaction" (
  "id"        TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "type"      TEXT NOT NULL,                          -- wage, material, transport, other, escrow...
  "amount"    DOUBLE PRECISION NOT NULL,
  "method"    TEXT NOT NULL DEFAULT 'mpesa',          -- mpesa, cash
  "reference" TEXT,
  "note"      TEXT,
  "date"      TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Transaction_projectId_idx" ON "Transaction"("projectId");

CREATE TABLE IF NOT EXISTS "Recap" (
  "id"        TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "day"       INTEGER NOT NULL,
  "content"   TEXT NOT NULL,                          -- WhatsApp-style recap message
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Recap_projectId_idx" ON "Recap"("projectId");

-- ─────────────────────────────────────────────────────────────
-- SECTION 3 · TRUST & MONEY — audit, escrow, milestones, variations
-- ─────────────────────────────────────────────────────────────

-- Bias-Free Ledger: chronological append-only record of everything
CREATE TABLE IF NOT EXISTS "AuditEvent" (
  "id"        TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "kind"      TEXT NOT NULL,                          -- delivery, wage, attendance, milestone, variation, escrow, photo, comment, export, project, expense, share, auth, supply, land...
  "actor"     TEXT NOT NULL,
  "role"      TEXT NOT NULL,                          -- contractor, foreman, client, system, ai
  "summary"   TEXT NOT NULL,
  "meta"      TEXT,                                   -- JSON extra detail
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "AuditEvent_projectId_idx" ON "AuditEvent"("projectId");
CREATE INDEX IF NOT EXISTS "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- MjengoPay escrow (simulated money, real workflow)
CREATE TABLE IF NOT EXISTS "EscrowWallet" (
  "id"        TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL UNIQUE REFERENCES "Project"("id") ON DELETE RESTRICT,
  "balance"   DOUBLE PRECISION NOT NULL DEFAULT 0,    -- KES held
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Milestone" (
  "id"               TEXT PRIMARY KEY,
  "projectId"        TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "phaseId"          TEXT,                            -- soft link (no FK)
  "name"             TEXT NOT NULL,
  "amount"           DOUBLE PRECISION NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'locked',  -- locked, evidence_submitted, release_requested, approved, released, rejected
  "evidencePhotoIds" TEXT NOT NULL DEFAULT '[]',      -- JSON array of SitePhoto ids (proof-of-work gate)
  "requestedAt"      TIMESTAMP(3),
  "decidedAt"        TIMESTAMP(3),
  "decidedBy"        TEXT,                            -- client name who approved/rejected
  "decisionNote"     TEXT,
  "releasedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Milestone_projectId_idx" ON "Milestone"("projectId");
CREATE INDEX IF NOT EXISTS "Milestone_status_idx"    ON "Milestone"("status");

CREATE TABLE IF NOT EXISTS "VariationOrder" (
  "id"           TEXT PRIMARY KEY,
  "projectId"    TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "phaseId"      TEXT,                                -- soft link (no FK)
  "title"        TEXT NOT NULL,
  "description"  TEXT NOT NULL,
  "budgetImpact" DOUBLE PRECISION NOT NULL,           -- + increase, - saving (KES)
  "status"       TEXT NOT NULL DEFAULT 'submitted',   -- submitted, approved, rejected
  "submittedBy"  TEXT,
  "decidedBy"    TEXT,
  "decisionNote" TEXT,
  "decidedAt"    TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "VariationOrder_projectId_idx" ON "VariationOrder"("projectId");

-- Contextual photo commenting — client pins a question on a site photo
CREATE TABLE IF NOT EXISTS "PhotoComment" (
  "id"        TEXT PRIMARY KEY,
  "photoId"   TEXT NOT NULL REFERENCES "SitePhoto"("id") ON DELETE CASCADE,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "author"    TEXT NOT NULL,
  "role"      TEXT NOT NULL,                          -- client, contractor, foreman
  "message"   TEXT NOT NULL,
  "resolved"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "PhotoComment_photoId_idx"   ON "PhotoComment"("photoId");
CREATE INDEX IF NOT EXISTS "PhotoComment_projectId_idx" ON "PhotoComment"("projectId");

-- Interactive site map zones (schematic coords over a plan image, 0-100 %)
CREATE TABLE IF NOT EXISTS "SiteZone" (
  "id"        TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "name"      TEXT NOT NULL,                          -- Master Bedroom, Kitchen, Foundation zone...
  "x"         DOUBLE PRECISION NOT NULL,              -- percent from left
  "y"         DOUBLE PRECISION NOT NULL,              -- percent from top
  "w"         DOUBLE PRECISION NOT NULL,              -- percent width
  "h"         DOUBLE PRECISION NOT NULL,              -- percent height
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "SiteZone_projectId_idx" ON "SiteZone"("projectId");

-- Notification center (in-app) + WhatsApp/SMS delivery log stubs
CREATE TABLE IF NOT EXISTS "Notification" (
  "id"        TEXT PRIMARY KEY,
  "projectId" TEXT REFERENCES "Project"("id") ON DELETE CASCADE,
  "kind"      TEXT NOT NULL,                          -- recap, milestone, variation, anomaly, comment, attendance, share, system
  "title"     TEXT NOT NULL,
  "body"      TEXT NOT NULL,
  "channel"   TEXT NOT NULL DEFAULT 'in_app',         -- in_app, whatsapp, sms, push
  "recipient" TEXT,
  "read"      BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Notification_projectId_idx" ON "Notification"("projectId");
CREATE INDEX IF NOT EXISTS "Notification_read_idx"      ON "Notification"("read");

-- ─────────────────────────────────────────────────────────────
-- SECTION 4 · SUPPLY NETWORK — marketplace, prices, bids
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Supplier" (
  "id"                 TEXT PRIMARY KEY,
  "name"               TEXT NOT NULL,
  "county"             TEXT NOT NULL,
  "town"               TEXT NOT NULL,
  "phone"              TEXT,
  "whatsapp"           TEXT,
  "managerName"        TEXT,
  "openingHours"       TEXT,
  "businessVerified"   BOOLEAN NOT NULL DEFAULT false,
  "locationVerified"   BOOLEAN NOT NULL DEFAULT false,
  "phoneVerified"      BOOLEAN NOT NULL DEFAULT false,
  "taxVerified"        BOOLEAN NOT NULL DEFAULT false,
  "warehouseVerified"  BOOLEAN NOT NULL DEFAULT false,
  "priceScore"         INTEGER NOT NULL DEFAULT 80,
  "qualityScore"       INTEGER NOT NULL DEFAULT 85,
  "deliveryScore"      INTEGER NOT NULL DEFAULT 85,
  "reliabilityScore"   INTEGER NOT NULL DEFAULT 84,
  "communicationScore" INTEGER NOT NULL DEFAULT 82,
  "rating"             DOUBLE PRECISION NOT NULL DEFAULT 4.5,   -- out of 5
  "ordersCompleted"    INTEGER NOT NULL DEFAULT 0,
  "onTimeRate"         DOUBLE PRECISION NOT NULL DEFAULT 0.95,  -- 0-1
  "disputes"           INTEGER NOT NULL DEFAULT 0,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "Warehouse" (
  "id"         TEXT PRIMARY KEY,
  "supplierId" TEXT NOT NULL REFERENCES "Supplier"("id") ON DELETE CASCADE,
  "name"       TEXT NOT NULL,
  "town"       TEXT NOT NULL,
  "county"     TEXT NOT NULL,
  "distanceKm" DOUBLE PRECISION NOT NULL,
  "lat"        DOUBLE PRECISION,
  "lng"        DOUBLE PRECISION,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Warehouse_supplierId_idx" ON "Warehouse"("supplierId");

-- A supplier's listing: one material from one warehouse
CREATE TABLE IF NOT EXISTS "SupplyOffer" (
  "id"               TEXT PRIMARY KEY,
  "supplierId"       TEXT NOT NULL REFERENCES "Supplier"("id") ON DELETE CASCADE,
  "warehouseId"      TEXT NOT NULL REFERENCES "Warehouse"("id") ON DELETE CASCADE,
  "materialKey"      TEXT NOT NULL,                   -- 'cement-32.5', 'steel-y12', 'river-sand'...
  "materialName"     TEXT NOT NULL,
  "unit"             TEXT NOT NULL,                   -- bag, tonne, piece, lorry, metre, kg
  "unitPrice"        DOUBLE PRECISION NOT NULL,       -- KES
  "stockQty"         DOUBLE PRECISION NOT NULL,
  "stockConfidence"  TEXT NOT NULL DEFAULT 'reported',-- verified, reported, stale, unknown
  "stockVerifiedAt"  TIMESTAMP(3),
  "deliveryFee"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "freeDeliveryOver" DOUBLE PRECISION,                -- order total above which delivery is free
  "minLeadDays"      INTEGER NOT NULL DEFAULT 1,
  "bulkThreshold"    DOUBLE PRECISION,                -- qty above which bulkUnitPrice applies
  "bulkUnitPrice"    DOUBLE PRECISION,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "SupplyOffer_supplierId_idx"  ON "SupplyOffer"("supplierId");
CREATE INDEX IF NOT EXISTS "SupplyOffer_warehouseId_idx" ON "SupplyOffer"("warehouseId");
CREATE INDEX IF NOT EXISTS "SupplyOffer_materialKey_idx" ON "SupplyOffer"("materialKey");

-- Regional price intelligence (materialKey × region × daysAgo → price)
CREATE TABLE IF NOT EXISTS "PricePoint" (
  "id"          TEXT PRIMARY KEY,
  "materialKey" TEXT NOT NULL,
  "region"      TEXT NOT NULL,                        -- Nairobi, Mombasa, Kisumu, Nakuru, Eldoret...
  "daysAgo"     INTEGER NOT NULL,                     -- 0 = today
  "price"       DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS "PricePoint_materialKey_region_idx" ON "PricePoint"("materialKey", "region");

-- Reverse marketplace: project broadcasts a material need, suppliers bid
CREATE TABLE IF NOT EXISTS "BidRequest" (
  "id"            TEXT PRIMARY KEY,
  "projectId"     TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "items"         TEXT NOT NULL,                      -- JSON [{materialName, qty, unit}]
  "location"      TEXT NOT NULL,
  "requiredBy"    TEXT NOT NULL,                      -- YYYY-MM-DD
  "note"          TEXT,
  "status"        TEXT NOT NULL DEFAULT 'open',       -- open, awarded, cancelled
  "notifiedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "BidRequest_projectId_idx" ON "BidRequest"("projectId");

CREATE TABLE IF NOT EXISTS "BidQuote" (
  "id"           TEXT PRIMARY KEY,
  "bidRequestId" TEXT NOT NULL REFERENCES "BidRequest"("id") ON DELETE CASCADE,
  "supplierId"   TEXT NOT NULL REFERENCES "Supplier"("id") ON DELETE RESTRICT,
  "total"        DOUBLE PRECISION NOT NULL,           -- KES delivered
  "deliveryDays" INTEGER NOT NULL,
  "note"         TEXT,
  "status"       TEXT NOT NULL DEFAULT 'submitted',   -- submitted, selected, declined
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "BidQuote_bidRequestId_idx" ON "BidQuote"("bidRequestId");
CREATE INDEX IF NOT EXISTS "BidQuote_supplierId_idx"   ON "BidQuote"("supplierId");

-- ─────────────────────────────────────────────────────────────
-- SECTION 5 · INTELLIGENCE — BOQ, weather
-- ─────────────────────────────────────────────────────────────

-- Digital BOQ — plan quantities; actuals derive from deliveries/consumptions/transactions
CREATE TABLE IF NOT EXISTS "BoqItem" (
  "id"        TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "phaseName" TEXT,
  "category"  TEXT NOT NULL,                          -- material, labour, subcontract, equipment
  "name"      TEXT NOT NULL,
  "unit"      TEXT NOT NULL,
  "qty"       DOUBLE PRECISION NOT NULL,
  "rate"      DOUBLE PRECISION NOT NULL,              -- KES planned rate
  "sortOrder" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "BoqItem_projectId_idx" ON "BoqItem"("projectId");

-- 7-day weather strip (seeded demo; production feeds a weather API)
CREATE TABLE IF NOT EXISTS "WeatherDay" (
  "id"           TEXT PRIMARY KEY,
  "projectId"    TEXT REFERENCES "Project"("id") ON DELETE CASCADE,
  "date"         TEXT NOT NULL,                       -- YYYY-MM-DD
  "condition"    TEXT NOT NULL,                       -- sunny, cloudy, rain, storm
  "precipChance" INTEGER NOT NULL,
  "maxTempC"     INTEGER NOT NULL,
  "windKph"      INTEGER NOT NULL,
  "advice"       TEXT
);
CREATE INDEX IF NOT EXISTS "WeatherDay_projectId_idx" ON "WeatherDay"("projectId");
CREATE INDEX IF NOT EXISTS "WeatherDay_date_idx"      ON "WeatherDay"("date");

-- ─────────────────────────────────────────────────────────────
-- SECTION 6 · USSD CHECK-IN LAB
-- USSD exposes NO IP/GPS: confidence derives from MSISDN match, network
-- code, time-of-day vs shift, PIN + repeat-SIM patterns — with an optional
-- SMS-link bridge where the web hit carries the client IP + consented GPS.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "UssdSession" (
  "id"                 TEXT PRIMARY KEY,
  "projectId"          TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
  "msisdn"             TEXT NOT NULL,
  "workerId"           TEXT,                          -- soft link to Worker (no FK)
  "networkCode"        TEXT NOT NULL,                 -- SAFARICOM, AIRTEL, TELKOM
  "serviceCode"        TEXT NOT NULL DEFAULT '*384*88#',
  "menuPath"           TEXT NOT NULL,                 -- JSON [{step, text, input}]
  "checkin"            BOOLEAN NOT NULL DEFAULT false,
  "locationConfidence" INTEGER NOT NULL DEFAULT 0,    -- 0-100 composite
  "signals"            TEXT,                          -- JSON array {label, weight, hit}
  "smsLinkSent"        BOOLEAN NOT NULL DEFAULT false,
  "gpsConfirmed"       BOOLEAN NOT NULL DEFAULT false,
  "gpsLat"             DOUBLE PRECISION,
  "gpsLng"             DOUBLE PRECISION,
  "ipNote"             TEXT,                          -- demonstrative IP observation from the web link
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "UssdSession_projectId_idx" ON "UssdSession"("projectId");
CREATE INDEX IF NOT EXISTS "UssdSession_msisdn_idx"    ON "UssdSession"("msisdn");

-- ─────────────────────────────────────────────────────────────
-- SECTION 7 · LANDVERIFY — property due diligence
-- Philosophy: MjengoOS organizes evidence; advocates, licensed surveyors
-- and government offices make legal determinations. Registry checks are
-- simulated Ardhisasa lookups in the demo — production connects officially.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "LandParcel" (
  "id"            TEXT PRIMARY KEY,
  "projectId"     TEXT REFERENCES "Project"("id") ON DELETE SET NULL,  -- optional: project built on it
  "parcelNumber"  TEXT NOT NULL,
  "county"        TEXT NOT NULL,
  "section"       TEXT NOT NULL,                      -- registration section / location
  "location"      TEXT NOT NULL,
  "areaHa"        DOUBLE PRECISION,
  "titleType"     TEXT,                               -- freehold title, certificate of lease, allotment letter...
  "registryOwner" TEXT,                               -- registered owner per (simulated) official search
  "landUse"       TEXT,                               -- residential, agricultural, commercial...
  "sellerName"    TEXT NOT NULL,
  "sellerPhone"   TEXT,
  "notes"         TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "LandParcel_projectId_idx"    ON "LandParcel"("projectId");
CREATE INDEX IF NOT EXISTS "LandParcel_parcelNumber_idx" ON "LandParcel"("parcelNumber");

-- One verification check: pass / warn / fail / pending
CREATE TABLE IF NOT EXISTS "LandCheck" (
  "id"        TEXT PRIMARY KEY,
  "parcelId"  TEXT NOT NULL REFERENCES "LandParcel"("id") ON DELETE CASCADE,
  "key"       TEXT NOT NULL,                          -- registry_search, ownership_match, encumbrance_charge, caution, restriction, survey, land_rates, land_rent, land_use, planning, physical_site, seller_identity, multiple_owners, succession, road_access, utilities, flood_risk
  "label"     TEXT NOT NULL,
  "status"    TEXT NOT NULL DEFAULT 'pending',        -- pass, warn, fail, pending
  "detail"    TEXT,
  "source"    TEXT,                                   -- 'Simulated Ardhisasa search', 'Uploaded document', 'Surveyor report'...
  "checkedAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "LandCheck_parcelId_idx" ON "LandCheck"("parcelId");

-- Uploaded property documents with (simulated) OCR extraction
CREATE TABLE IF NOT EXISTS "LandDoc" (
  "id"         TEXT PRIMARY KEY,
  "parcelId"   TEXT NOT NULL REFERENCES "LandParcel"("id") ON DELETE CASCADE,
  "docType"    TEXT NOT NULL,                         -- title_deed, official_search, survey_plan, transfer, rates_clearance
  "fileName"   TEXT NOT NULL,
  "extracted"  TEXT,                                  -- JSON of OCR fields {owner, parcel, area, docNo...}
  "ocrSummary" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "LandDoc_parcelId_idx" ON "LandDoc"("parcelId");

-- Verified professionals (surveyors first; extensible to advocates, engineers, QS...)
CREATE TABLE IF NOT EXISTS "Surveyor" (
  "id"                    TEXT PRIMARY KEY,
  "name"                  TEXT NOT NULL,
  "profession"            TEXT NOT NULL DEFAULT 'Land Surveyor',
  "county"                TEXT NOT NULL,
  "firm"                  TEXT,
  "registrationNo"        TEXT NOT NULL,
  "registrationAuthority" TEXT NOT NULL DEFAULT 'Licensed Surveyors register (simulated)',
  "practisingStatus"      TEXT NOT NULL DEFAULT 'current',  -- current, expired, suspended
  "credentialExpiresAt"   TIMESTAMP(3),
  "identityVerified"      BOOLEAN NOT NULL DEFAULT false,
  "registrationVerified"  BOOLEAN NOT NULL DEFAULT false,
  "practisingVerified"    BOOLEAN NOT NULL DEFAULT false,
  "firmVerified"          BOOLEAN NOT NULL DEFAULT false,
  "officeVerified"        BOOLEAN NOT NULL DEFAULT false,
  "rating"                DOUBLE PRECISION NOT NULL DEFAULT 4.7,
  "assignmentsCompleted"  INTEGER NOT NULL DEFAULT 0,
  "mjengoAssignments"     INTEGER NOT NULL DEFAULT 0,
  "onTimeRate"            DOUBLE PRECISION NOT NULL DEFAULT 0.96,
  "responseMins"          INTEGER NOT NULL DEFAULT 45,
  "availableFrom"         TEXT,                       -- 'today', 'tomorrow', '2026-09-02'
  "services"              TEXT NOT NULL,              -- JSON array of service keys
  "priceFrom"             DOUBLE PRECISION,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- Physical verification engagement: request → quotes → scheduled → field work → report
CREATE TABLE IF NOT EXISTS "SurveyAssignment" (
  "id"               TEXT PRIMARY KEY,
  "parcelId"         TEXT NOT NULL REFERENCES "LandParcel"("id") ON DELETE CASCADE,
  "surveyorId"       TEXT REFERENCES "Surveyor"("id") ON DELETE SET NULL,
  "service"          TEXT NOT NULL,                   -- boundary_verification, beacon_identification, topo_survey, subdivision, setout, general
  "status"           TEXT NOT NULL DEFAULT 'requested', -- requested, quoted, scheduled, in_progress, completed, reported
  "amount"           DOUBLE PRECISION,
  "scheduledDate"    TEXT,                            -- YYYY-MM-DD
  "notes"            TEXT,
  "reportSummary"    TEXT,
  "reportApprovedAt" TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "SurveyAssignment_parcelId_idx"   ON "SurveyAssignment"("parcelId");
CREATE INDEX IF NOT EXISTS "SurveyAssignment_surveyorId_idx" ON "SurveyAssignment"("surveyorId");
CREATE INDEX IF NOT EXISTS "SurveyAssignment_status_idx"     ON "SurveyAssignment"("status");

CREATE TABLE IF NOT EXISTS "SurveyQuote" (
  "id"           TEXT PRIMARY KEY,
  "assignmentId" TEXT NOT NULL REFERENCES "SurveyAssignment"("id") ON DELETE CASCADE,
  "surveyorId"   TEXT NOT NULL REFERENCES "Surveyor"("id") ON DELETE RESTRICT,
  "amount"       DOUBLE PRECISION NOT NULL,
  "days"         INTEGER NOT NULL,
  "note"         TEXT,
  "status"       TEXT NOT NULL DEFAULT 'submitted',   -- submitted, selected, declined
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "SurveyQuote_assignmentId_idx" ON "SurveyQuote"("assignmentId");
CREATE INDEX IF NOT EXISTS "SurveyQuote_surveyorId_idx"   ON "SurveyQuote"("surveyorId");

-- Beacon-level findings from the field survey
CREATE TABLE IF NOT EXISTS "BeaconCheck" (
  "id"           TEXT PRIMARY KEY,
  "assignmentId" TEXT NOT NULL REFERENCES "SurveyAssignment"("id") ON DELETE CASCADE,
  "label"        TEXT NOT NULL,                       -- Beacon 1 / A...
  "status"       TEXT NOT NULL,                       -- found, not_found
  "note"         TEXT
);
CREATE INDEX IF NOT EXISTS "BeaconCheck_assignmentId_idx" ON "BeaconCheck"("assignmentId");

-- Field evidence: photo refs, GPS observations, measurements, notes
CREATE TABLE IF NOT EXISTS "SurveyEvidence" (
  "id"           TEXT PRIMARY KEY,
  "assignmentId" TEXT NOT NULL REFERENCES "SurveyAssignment"("id") ON DELETE CASCADE,
  "kind"         TEXT NOT NULL,                       -- photo, gps, doc, note, measurement
  "label"        TEXT NOT NULL,
  "value"        TEXT,                                -- coords, measurement, text
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "SurveyEvidence_assignmentId_idx" ON "SurveyEvidence"("assignmentId");

-- ═══════════════════════════════════════════════════════════════════════════════
-- Done — 40 tables. Apply supabase/rls.sql afterwards to lock them down.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- Wave 10 — LandVerify extension (Professional / ParcelEvent / LegalReview)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "Professional" (
  "id"                    TEXT PRIMARY KEY,
  "name"                  TEXT NOT NULL,
  "professionKey"         TEXT NOT NULL,              -- advocate, architect, engineer, quantity_surveyor, land_surveyor, planner, valuer, contractor, environmental_expert
  "professionLabel"       TEXT NOT NULL,
  "county"                TEXT NOT NULL,
  "firm"                  TEXT,
  "registrationNo"        TEXT NOT NULL,
  "registrationAuthority" TEXT NOT NULL,              -- Law Society of Kenya, BORAQS, EBK, Land Surveyors Board, VRB, NCA, NEMA...
  "practisingStatus"      TEXT NOT NULL DEFAULT 'current', -- current, expired, suspended
  "credentialExpiresAt"   TIMESTAMP(3),
  "identityVerified"      BOOLEAN NOT NULL DEFAULT false,
  "registrationVerified"  BOOLEAN NOT NULL DEFAULT false,
  "practisingVerified"    BOOLEAN NOT NULL DEFAULT false,
  "firmVerified"          BOOLEAN NOT NULL DEFAULT false,
  "officeVerified"        BOOLEAN NOT NULL DEFAULT false,
  "speciality"            TEXT,
  "rating"                DOUBLE PRECISION NOT NULL DEFAULT 4.7,
  "assignmentsCompleted"  INTEGER NOT NULL DEFAULT 0,
  "mjengoAssignments"     INTEGER NOT NULL DEFAULT 0,
  "onTimeRate"            DOUBLE PRECISION NOT NULL DEFAULT 0.96,
  "responseMins"          INTEGER NOT NULL DEFAULT 45,
  "availableFrom"         TEXT,
  "priceFrom"             DOUBLE PRECISION,
  "notes"                 TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Professional_professionKey_idx" ON "Professional"("professionKey");
CREATE INDEX IF NOT EXISTS "Professional_registrationNo_idx" ON "Professional"("registrationNo");

CREATE TABLE IF NOT EXISTS "ParcelEvent" (
  "id"             TEXT PRIMARY KEY,
  "parcelId"       TEXT NOT NULL REFERENCES "LandParcel"("id") ON DELETE CASCADE,
  "eventDate"      TEXT NOT NULL,                     -- ISO date string for stable display
  "eventType"      TEXT NOT NULL,                     -- first_registration, transfer, charge, charge_discharge, caution, caution_removal, restriction, succession_filed, succession_granted, court_case, subdivision, correction
  "title"          TEXT NOT NULL,
  "detail"         TEXT NOT NULL,                     -- plain-language explanation
  "needsAttention" BOOLEAN NOT NULL DEFAULT false,
  "source"         TEXT NOT NULL DEFAULT 'Simulated Ardhisasa registry abstract',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ParcelEvent_parcelId_idx" ON "ParcelEvent"("parcelId");

CREATE TABLE IF NOT EXISTS "LegalReview" (
  "id"             TEXT PRIMARY KEY,
  "parcelId"       TEXT NOT NULL REFERENCES "LandParcel"("id") ON DELETE CASCADE,
  "professionalId" TEXT NOT NULL REFERENCES "Professional"("id") ON DELETE CASCADE,
  "status"         TEXT NOT NULL DEFAULT 'requested', -- requested, accepted, delivered
  "scope"          TEXT NOT NULL,                     -- full_due_diligence, title_opinion, encumbrance_review, succession_review
  "fee"            DOUBLE PRECISION,
  "questions"      TEXT,                              -- JSON array of the client's concerns
  "opinion"        TEXT,                              -- JSON { verdict, summary, findings, nextSteps }
  "deliveredAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "LegalReview_parcelId_idx" ON "LegalReview"("parcelId");
CREATE INDEX IF NOT EXISTS "LegalReview_professionalId_idx" ON "LegalReview"("professionalId");
