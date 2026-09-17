-- ═══════════════════════════════════════════════════════════════════════════════
-- MjengoOS · Supabase Row Level Security posture
-- Run AFTER supabase/schema.sql.
--
-- Architecture: MjengoOS talks to Postgres through its Next.js backend
-- (Prisma) — NOT from the browser via the anon key. The correct posture is:
--   1. RLS ENABLED on every table (locked by default — no policies = no access
--      for anon/authenticated roles).
--   2. The backend connects with the `postgres`/service-role connection
--      (table owner / bypasses RLS) and enforces auth itself via
--      NextAuth sessions + src/lib/guard.ts (401/403 at the API layer).
--   3. REVOKE direct grants from `anon` and `authenticated` so Supabase
--      client keys can never touch the data even by accident.
--
-- If you later move auth to Supabase (supabase.auth), uncomment the example
-- policies at the bottom and adapt them to your JWT claims.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1 · Enable RLS everywhere (no policies yet ⇒ deny-by-default for client keys)
ALTER TABLE "User"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Phase"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Worker"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Attendance"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Material"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Delivery"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Consumption"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SitePhoto"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Alert"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Transaction"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Recap"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EscrowWallet"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Milestone"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VariationOrder"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PhotoComment"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SiteZone"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Warehouse"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplyOffer"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PricePoint"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BidRequest"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BidQuote"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BoqItem"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WeatherDay"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UssdSession"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LandParcel"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LandCheck"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LandDoc"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Surveyor"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SurveyAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SurveyQuote"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BeaconCheck"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SurveyEvidence"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Professional"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ParcelEvent"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegalReview"      ENABLE ROW LEVEL SECURITY;

-- 2 · Strip direct client-key access (defense in depth)
--    The Next.js backend uses the pooler/service connection, which is unaffected.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3 · OPTIONAL · Future Supabase-Auth policies (sketch — uncomment & adapt)
-- ─────────────────────────────────────────────────────────────────────────────
-- When the frontend connects directly with supabase-js + supabase.auth, give
-- signed-in users access to projects they belong to. Suggested model: an
-- auxiliary table "ProjectMember"("projectId", "userId") drives membership.
--
-- CREATE TABLE "ProjectMember" (
--   "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
--   "userId"    TEXT NOT NULL REFERENCES "User"("id")    ON DELETE CASCADE,
--   "role"      TEXT NOT NULL DEFAULT 'viewer',          -- owner, editor, viewer
--   PRIMARY KEY ("projectId", "userId")
-- );
-- ALTER TABLE "ProjectMember" ENABLE ROW LEVEL SECURITY;
--
-- -- helper: can this auth user see this project?
-- CREATE OR REPLACE FUNCTION public.mjengo_member_of(target_project TEXT)
-- RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER STABLE AS $$
--   SELECT EXISTS (
--     SELECT 1 FROM "ProjectMember" m
--     WHERE m."projectId" = target_project
--       AND m."userId"    = auth.uid()::text
--   );
-- $$;
--
-- -- example: read access to everything scoped to a member project
-- CREATE POLICY "members_read_project" ON "Project"
--   FOR SELECT USING (public.mjengo_member_of("id"));
-- CREATE POLICY "members_read_site_data" ON "Delivery"
--   FOR SELECT USING (public.mjengo_member_of("projectId"));
-- -- ...repeat per table (projectId columns make this mechanical),
-- -- then add role-aware write policies (owner/editor only) per action.
-- ═══════════════════════════════════════════════════════════════════════════════
