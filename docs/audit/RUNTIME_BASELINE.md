# MjengoOS — Runtime Baseline (Phase 0.3 / 0.4)

## 1. Build & install baseline (re-run 2026-09-16, fresh clone)

| Step | Command | Result |
|---|---|---|
| Install | `bun install --frozen-lockfile` | ✅ 955 packages (root); website app installs separately |
| Unit/integration tests | `bunx vitest run` | ✅ **71 files / 1,811 tests, 0 failures** (25 s) |
| Lint | `bun run lint` | ✅ exit 0 |
| Strict typecheck | `bunx tsc --noEmit` | ✅ exit 0 |
| Migration drift | `prisma migrate diff` (migrations ↔ schema) | ✅ zero DDL |
| Container build | not executed in this sandbox | definitions reviewed (infra baseline); CI execution blocked by #98 |

## 2. Runtime posture (from code + prior live evidence, re-checked)

- Boot: `lib/mjengo.ts` boot guard fails closed on missing/short
  `NEXTAUTH_SECRET` in production (#74); dev quickstart works without it
  (fallback secret, now restricted to development/test runtimes — SEC-2 fix).
- Health: `/api/health` performs a real DB roundtrip + queue counts, 503 on
  down (verified in code by infra auditor).
- Jobs: systemd timer (5 min, `Persistent=true`, fail-closed curl) →
  `/api/jobs/run` (bearer `JOBS_RUN_TOKEN`, constant-time compare) drains
  ≤10 jobs/call with 2→8→30 min backoff and 30 s handler caps.
- Offline: SW v3 never caches `/api/**`; prod-only `/` shell; photo LRU cap
  100; auth-timeout (3.5 s) offline boot fails closed to Overview.
- Golden-path browser verification (2026-09-10 report §4) claims were
  re-verified **in code** this wave (share binding, dev-secret guard, supplier
  scoping, Kiswahili surfaces); a fresh interactive browser pass is scheduled
  as part of PR review for this wave's branches (sandbox has no GitHub
  preview; local `next dev` smoke was covered by gates + unit suites).

## 3. This wave's branch gates (post-fix)

| Branch | vitest | lint | tsc | drift |
|---|---|---|---|---|
| `fix/audit2-security` (5 commits) | **73 files / 1,852 tests** ✅ | 0 ✅ | 0 ✅ | n/a (no schema change) |
| `fix/audit2-data` (3 commits) | **74 files / 1,847 tests** ✅ | 0 ✅ | 0 ✅ | ✅ zero DDL |

Both: `git status` clean, no db files/artifacts committed, seeds re-validated
against the new unique constraints (`bun run seed` on a throwaway DB).

## 4. Known runtime limitations (documented, tracked)

- Single-process ledger ref counter (documented in code) — fine at current
  scale; Supabase design removes it (sequence-backed refs).
- In-process rate-limit store by default (`rate-limit-sqlite` opt-in) — API-7.
- Tests are not DB-backed (in-memory Prisma stubs) except the new
  `db-integrity-constraints.test.ts` (real better-sqlite3) and
  `rate-limit-store.test.ts` — TEST-2 register item.
  2026-09-19 update (issue #184): the real-SQLite harness landed —
  `tests/helpers/db.ts` (fresh temp-file SQLite per test file, migrations
  00→15 applied by the REAL `prisma migrate deploy`, real PrismaClient +
  better-sqlite3 handle) with five critical-path suites on it:
  ledger-realdb / wallet-realdb / supply-chain-realdb (the TEST-6 walk) /
  inventory-realdb / attendance-realdb. The stub suites still run unchanged
  for fast pure-logic coverage — the register item is now about CI wiring
  (#98), not about the harness existing.
- No automated E2E (Playwright) — TEST-1 register item; prior
  "browser-verified" evidence was manual.
