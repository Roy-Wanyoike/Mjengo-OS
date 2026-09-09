# ADR 0002 — Supabase (managed PostgreSQL) as the production database platform

- **Status:** Accepted (design phase — no runtime cutover in this ADR)
- **Date:** 2026-09-09
- **Issue:** #95
- **Deciders:** Coordinator / Database Engineering
- **Related:** ADR 0001 (mobile scope), `prisma/schema.prisma` (68 models), `src/backend/lib/guard.ts` (server truth), `src/shared/permissions.ts` (client mirror), `src/backend/api/v1/scope.ts` (tenant pins)

## Context

Mjengo-OS v0.2.5 runs on **Prisma + SQLite** (single file, single node). The product
carries: a double-entry money core with escrow, append-only trust artifacts
(DrawPacks, MjengoScores, AI notes/insights, TrustDigests), offline sync with
entity versions, idempotency records, DB-backed jobs and feature flags — 61
models across 10 domain slices. Before onboarding paying users we must choose
the production database platform, because it shapes auth posture, tenancy
enforcement, storage, realtime fan-out and the migration plan.

Hard requirements that SQLite cannot meet in production:

1. **Managed backups + PITR** — money-grade data cannot live on one container volume.
2. **Row-level security** — a second, DB-enforced tenancy layer under the API guard
   (defense in depth; the audit waves repeatedly pinned "frontend auth is not a
   security control" — the same principle applies one layer down).
3. **Connection pooling** for serverless-style API concurrency and future Edge access.
4. **Object storage + signed URLs** for site photos and documents (the app already
   abstracts drivers: `lib/storage/{local-disk,s3-compat}`).
5. **Realtime** notification fan-out and **scheduled jobs** without bespoke systemd timers.

## Options considered

| Option | Verdict |
| --- | --- |
| **Keep SQLite + Litestream** | Streaming replication is solid, but no RLS, no PostgREST, no pooling story, no managed PITR-grade ops. Reject. |
| **Self-hosted Postgres (VPS/Compose)** | Full control, but we would rebuild backups, pooling, storage, auth hooks and observability ourselves — precisely what a 1–2 person ops story cannot carry. Reject for now. |
| **Supabase (managed Postgres + Auth + Storage + Realtime + pg_cron)** | Postgres-native (Prisma-compatible), RLS + JWT claims model, S3-compatible storage, CDC realtime, managed PITR. **Chosen.** |
| **Neon/PlanetScale-style serverless Postgres** | Good database layer, but we'd still assemble auth hooks, storage, realtime and cron from separate vendors. Reject (complexity budget). |

## Decision

**Adopt Supabase (managed PostgreSQL) as the target-state production database,
in two phases.** The full target-state design — schema DDL for all 68 models,
RLS policy matrix, profiles/auth mapping, storage buckets, realtime, jobs and
the migration/rollback plan — lives in
[`docs/SUPABASE-DATABASE-DESIGN.md`](../SUPABASE-DATABASE-DESIGN.md) with
runnable SQL in [`supabase/migrations/`](../../supabase/migrations/).

### Phase 1 — Supabase as managed Postgres behind the existing API (minimum change)

- `prisma/schema.prisma` switches `provider = "postgresql"` (with `@map`
  snake_case annotations) against the Supabase connection pooler.
- **NextAuth v4 + `guard.ts` remain the enforcement point** — exactly the
  audited posture. The app connects with the service-level Postgres role, which
  bypasses RLS; policies therefore act as *defense in depth* for any
  PostgREST/Analytics/direct-SQL access path.
- Storage moves to the Supabase S3-compatible endpoint (the existing
  `s3-compat` driver already speaks this protocol family).
- pg_cron replaces the systemd jobs timer (calls the existing
  `POST /api/jobs/run` bearer-token route).

### Phase 2 — Supabase Auth + RLS-first access (follow-up, separate ADR when scheduled)

- Identity moves from NextAuth credentials to **Supabase Auth** with
  `public.profiles` and a custom access-token hook injecting
  `app_role` / `app_project_id` / `app_supplier_id` claims.
- User-facing reads/writes can then flow through PostgREST/RLS with the API
  layer retaining action-level authorization. Phased per surface, not big-bang.

### Enforcement split (the honest statement)

- **RLS answers "which rows can this principal touch"** (tenancy: client project
  pin, supplier row pin, staff bands, append-only disciplines).
- **The API guard answers "which actions may this role perform"** (route
  allowlists, state ladders, business rules). RLS deliberately does not try to
  encode the full action matrix — that is not its strength, and duplicating it
  there would create a second, drift-prone source of truth.

## Key type-safety decisions (binding for the migration)

| Prisma/SQLite | Target PostgreSQL | Why |
| --- | --- | --- |
| `Float` money fields | `NUMERIC(18,2)` | Exact decimal money; Float is a defect class we fix at the boundary, documented in the migration plan. |
| `Float` quantities | `NUMERIC(18,3)` | Fractional site quantities (2.5 bags) without binary drift. |
| `Float` lat/lng | `double precision` | Geographic precision, not money. |
| `DateTime` | `timestamptz` | All timestamps zone-aware (user TZ Africa/Nairobi, diaspora users elsewhere). |
| JSON-in-string columns | `jsonb` | Queryable, validated at rest. |
| Status ladders (String) | `text` + `CHECK` | Additive wave evolution without `ALTER TYPE` ceremony. |
| cuid `String` ids | `text` PRIMARY KEY | Preserves the offline-sync, outbox and idempotency layers byte-for-byte; uuid migration documented as a non-goal. |
| `@updatedAt` | Trigger `touch_updated_at()` | DB-owned once Prisma is not the only writer. |

## Consequences

- **Positive:** managed PITR; DB-enforced append-only money/trust artifacts
  (triggers fire even for the service role); FK indexes that SQLite never had;
  NUMERIC money; storage/realtime/cron consolidation; Supabase Auth path opens
  without schema rework.
- **Negative / costs:** migration effort (ETL with Float→NUMERIC coercion and
  row-count/hash verification); two migration ledgers to keep honest
  (`prisma/migrations` = data model, `supabase/migrations` = platform/security
  layer — ownership boundary documented); Supabase vendor coupling (mitigated:
  it is plain Postgres underneath; `pg_dump` is an exit).
- **Risks accepted:** RLS ineffective on the Phase-1 Prisma connection by
  design (guard.ts owns enforcement, as today) — documented, not hidden.

## Rollback

Design-only change: reverting the PR removes `supabase/` and the docs; the app
never leaves SQLite in this ADR. Runtime rollback of the eventual Phase-1
cutover is specified in the design doc §12 (SQLite stays frozen read-only until
sign-off; DNS/env cutover is one variable).
