# MjengoOS on Supabase (PostgreSQL)

The demo app runs on SQLite (`db/custom.db`) for zero-setup local use. This folder
is the **production path to Supabase**: the complete PostgreSQL schema — all **40
tables and their relationships** — mirroring `prisma/schema.prisma` 1:1.

```
supabase/
├── schema.sql   # All 40 tables + FKs + indexes (apply first)
├── rls.sql      # Row Level Security lockdown (apply second)
└── README.md    # This guide
```

## 1 · Apply the schema

**Option A — Supabase Dashboard (fastest)**
1. Create a project at [supabase.com](https://supabase.com) (region: `eu-west-2` London or `af-south-1` if available).
2. SQL Editor → New query → paste the full contents of `schema.sql` → **Run**.
3. New query → paste `rls.sql` → **Run**.

**Option B — psql**
```bash
psql "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
  -f supabase/schema.sql -f supabase/rls.sql
```

**Option C — Supabase CLI (versioned migrations)**
```bash
cp supabase/schema.sql supabase/migrations/0001_init.sql
cp supabase/rls.sql    supabase/migrations/0002_rls.sql
supabase db push
```

## 2 · Point the app at Supabase

Edit `.env` (connection strings come from Supabase → Project Settings → Database):

```env
# Prisma direct connection (migrations/seeds use this)
DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?pgbouncer=true&connection_limit=1"

NEXTAUTH_SECRET="<same secret as before>"
```

Then switch the Prisma datasource in `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"        // was "sqlite"
  url      = env("DATABASE_URL")
}
```

```bash
bun run db:generate          # regenerate the client for Postgres
# EITHER apply our SQL files (already done in step 1) and introspect:
bunx prisma db pull          # confirms zero drift — schema matches 1:1
# OR let Prisma create the tables itself (skip step 1 entirely):
bun run db:push
```

**Seeding Supabase** — the seed chain works unchanged (it's plain PrismaClient):
```bash
bun prisma/seed.ts && bun prisma/seed-extras/trust.ts && bun prisma/seed-extras/money.ts \
  && bun prisma/seed-extras/evidence.ts && bun prisma/seed-extras/users.ts \
  && bun prisma/seed-extras/supply.ts && bun prisma/seed-extras/intelligence.ts \
  && bun prisma/seed-extras/land.ts && bun prisma/seed-extras/ussd.ts
```

## 3 · Security posture (why rls.sql looks like this)

MjengoOS talks to Postgres **through its Next.js backend** (Prisma + NextAuth JWT
+ `src/lib/guard.ts`), never from the browser with the anon key. So:

- RLS is **enabled on every table with zero policies** — deny-by-default for any
  client key.
- `anon` / `authenticated` roles are fully revoked — Supabase client keys can't
  touch data even by accident.
- The backend's Postgres connection (table owner) is unaffected; authorization
  stays where the business logic lives (API layer, 401/403 verified by audit).
- Moving auth to `supabase.auth` later? `rls.sql` ends with a commented policy
  sketch (`ProjectMember` helper) to start from.

## 4 · Table inventory (40)

| Domain | Tables |
|---|---|
| **Core** | `User` · `Project` · `Phase` · `Task` · `Worker` · `Attendance` |
| **Operations** | `Material` · `Delivery` · `Consumption` · `SitePhoto` · `Alert` · `Transaction` · `Recap` |
| **Trust & Money** | `AuditEvent` · `EscrowWallet` · `Milestone` · `VariationOrder` · `PhotoComment` · `SiteZone` · `Notification` |
| **Supply Network** | `Supplier` · `Warehouse` · `SupplyOffer` · `PricePoint` · `BidRequest` · `BidQuote` |
| **Intelligence** | `BoqItem` · `WeatherDay` |
| **USSD Lab** | `UssdSession` |
| **LandVerify** | `LandParcel` · `LandCheck` · `LandDoc` · `Surveyor` · `SurveyAssignment` · `SurveyQuote` · `BeaconCheck` · `SurveyEvidence` |

## 5 · Relationship map

**Core chain** (deleting a Project cascades through almost everything):
```
User (client-role rows carry soft projectId links)
Project ─┬─ Phase ──── Task
         ├─ Worker ─── Attendance
         ├─ Delivery ──────┐ (materialId RESTRICT — catalog rows are shared,
         ├─ Consumption ───┤  deleting a Material is blocked while referenced)
         │                 └──────→ Material (global catalog)
         ├─ SitePhoto ──→ Phase (SET NULL: photos survive phase deletion)
         │      └─ PhotoComment (cascades with the photo)
         ├─ Alert · Transaction · Recap · AuditEvent · SiteZone
         ├─ EscrowWallet (1:1, RESTRICT — must clear escrow before deleting project)
         ├─ Milestone · VariationOrder · Notification
         ├─ BidRequest ─── BidQuote ───→ Supplier (RESTRICT)
         ├─ BoqItem · WeatherDay · UssdSession
         └─ LandParcel (SET NULL: parcels survive their project)
                ├─ LandCheck · LandDoc
                └─ SurveyAssignment ─┬─ SurveyQuote ───→ Surveyor (RESTRICT)
                                      ├─ BeaconCheck
                                      └─ SurveyEvidence
                                      └─→ Surveyor (SET NULL — history kept)
```

**Marketplace chain** (independent of projects):
```
Supplier ─┬─ Warehouse ─── SupplyOffer (one listing = supplier × warehouse × material)
          ├─ SupplyOffer · BidQuote · SurveyQuote (RESTRICT where required)
          └─ PricePoint (global price intelligence — no FKs)
```

**Soft links (deliberate, no FK):** `User.projectId`, `SitePhoto.zoneId`,
`Milestone.phaseId`, `VariationOrder.phaseId`, `UssdSession.workerId` —
documented in column comments. They keep historical rows stable when the
referenced entity changes shape.

### ON DELETE actions at a glance
| Action | Used for |
|---|---|
| `CASCADE` | Project-owned data (phases, tasks, workers, attendance, photos, ledger…) — a project delete wipes its whole footprint |
| `SET NULL` | Optional references where history must survive (`SitePhoto→Phase`, `SurveyAssignment→Surveyor`, `LandParcel→Project`) |
| `RESTRICT` | Shared/global references (`Delivery→Material`, `EscrowWallet→Project`, quotes→Supplier/Surveyor) — blocks deletes that would orphan records |

## 6 · Conventions & gotchas

- **Quoted camelCase identifiers** (`"shareToken"`) match Prisma exactly —
  `prisma db pull` introspects back with zero drift. Don't rename columns to
  snake_case without also changing the Prisma schema (or adopt
  `@map`/`@@map` — then regenerate this SQL from `prisma db push` instead).
- **IDs are TEXT (app-generated cuids)** — the seed chain and existing code work
  unchanged. Prefer native UUIDs instead? Change PKs to
  `UUID DEFAULT gen_random_uuid()` and add `@default(uuid())` in Prisma.
- **TIMESTAMP(3)** matches Prisma's Postgres mapping; `updatedAt` has a
  `DEFAULT now()` backstop but Prisma maintains the real value.
- **No CHECK constraints** — Prisma can't model them, so enum values live in
  column comments (adding them would cause `prisma db push` drift).
- **JSON-in-TEXT columns** (`evidence`, `menuPath`, `items`, `signals`,
  `extracted`, `services`, `evidencePhotoIds`, `overrideLog`) — kept as TEXT for
  Prisma parity. On Postgres you may later migrate them to `JSONB` +
  `@db.JsonB` for indexed queries.
- Reserved-word columns are quoted: `Phase."order"`, `Notification."read"`.

| Wave 10 — LandVerify extension | `Professional`, `ParcelEvent`, `LegalReview` |
