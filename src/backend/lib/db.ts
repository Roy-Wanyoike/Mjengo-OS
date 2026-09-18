import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// BE-8 (issue #77): query logging is DEV-ONLY. 'error' and 'warn' stay on in
// every environment (failures must always be visible); the 'query' level
// logged every SQL statement to stdout unconditionally — log volume/perf cost
// in production, and statements carrying user data landing in container logs.
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['query', 'error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// --------------------------------------------------------------- issue #135
// Audit DB-12 — PRAGMA foreign_keys boot assert. SQLite only enforces
// foreign keys when the CONNECTION carries `PRAGMA foreign_keys = ON`: it is
// per-connection, defaults to OFF in raw SQLite, and every Cascade/Restrict/
// SetNull in prisma/schema.prisma (Delivery.materialId Restrict,
// LedgerEntry.accountId Restrict, …) silently becomes a no-op without it.
// Prisma's SQLite connector enables the pragma on its connections (verified:
// pinned on the real engine by tests/unit/db-fk-pragma-realdb.test.ts), but
// that posture was never asserted at runtime — "believed on" is not a
// production posture. This guard turns it into "known on, or the process
// refuses to start":
//
//   · src/instrumentation.ts (the Next.js server-boot hook) awaits
//     ensureForeignKeys() once per server instance — a rejection there is
//     FATAL (Next rethrows it as "An error occurred while loading
//     instrumentation hook: …" and the server never comes up);
//   · every DB-touching script entrypoint (prisma/seed.ts, prisma/seed-all.ts,
//     prisma/q2.ts, prisma/seed-extras/*) runs the same assert before its
//     first query;
//   · the datasource is guarded to SQLite (file:/sqlite:/:memory: URLs) so a
//     future Postgres/Supabase swap skips the pragma — Postgres enforces FKs
//     natively, no per-connection switch exists to assert.
//
// Deliberately NOT wired into the health route or per-query: the assert is a
// BOOT property (run once, fail the boot), and the probe contract
// ({ ok, db: 'up' } / 503) is pinned by tests + docker-compose/CI.

/**
 * The raw-SQL surface the FK assert needs — satisfied by every PrismaClient
 * (the app singleton, the #184 test-harness clients, the seed-script
 * clients); in-memory fakes implement the same two methods so the failure
 * ladder is unit-testable without an engine.
 */
export interface RawSqlClient {
  $executeRawUnsafe(sql: string): Promise<unknown>
  $queryRawUnsafe(sql: string): Promise<unknown>
}

/** What a boot assert run established. */
export type ForeignKeysAssertResult =
  | 'enabled' // pragma executed + read-back verified 1
  | 'skipped-non-sqlite' // non-SQLite datasource — nothing to assert

/**
 * Fatal boot error: SQLite FK enforcement could not be turned on (or could
 * not be proven on). Thrown by ensureForeignKeys() so the server/script
 * refuses to start — never logged-and-ignored.
 */
export class ForeignKeysPragmaError extends Error {
  constructor(readBack: string) {
    super(
      `PRAGMA foreign_keys is OFF (read-back: ${readBack}) — SQLite foreign-key ` +
        `enforcement is disabled on this connection: every Cascade/Restrict/` +
        `SetNull in prisma/schema.prisma is a silent no-op and rows with ` +
        `dangling hard FKs can be written (issue #135 / audit DB-12). ` +
        `Refusing to start. Remediation: the Prisma SQLite connector enables ` +
        `this pragma on its connections by default, so an OFF read-back means ` +
        `a driver/engine path disabled it — check connection-level pragma ` +
        `overrides; any non-Prisma writer must run ` +
        `'PRAGMA foreign_keys = ON' on EVERY connection (raw SQLite defaults ` +
        `to OFF, and the pragma does not persist across connections).`,
    )
    this.name = 'ForeignKeysPragmaError'
  }
}

/** The datasource URL prefixes that mean "SQLite" for the assert's guard. */
function urlIsSqlite(url: string): boolean {
  return /^(file|sqlite):/i.test(url) || url === ':memory:'
}

/**
 * Assert `PRAGMA foreign_keys = ON` on the given client (issue #135 / audit
 * DB-12): execute the pragma, then read it back and REQUIRE a verified 1.
 * Any other read-back — 0, missing rows, an unexpected shape — throws
 * ForeignKeysPragmaError (the caller's boot dies loudly). The execute is
 * idempotent, so an already-ON connection (Prisma's default) is untouched in
 * behavior: ON stays ON, the read-back stays 1.
 *
 * `client` defaults to the app singleton; tests and scripts pass their own
 * (the #184 harness overrides the datasource URL per client, so the URL is a
 * parameter too — it defaults to the production source, DATABASE_URL).
 * Non-SQLite URLs resolve 'skipped-non-sqlite' having issued NO queries
 * (the Postgres/Supabase path has no such pragma). An unset URL also skips:
 * Prisma itself fails the first real query with "Environment variable not
 * found: DATABASE_URL" — a boot failure either way.
 */
export async function ensureForeignKeys(
  client: RawSqlClient = db,
  datasourceUrl: string = process.env.DATABASE_URL ?? '',
): Promise<ForeignKeysAssertResult> {
  if (!urlIsSqlite(datasourceUrl)) return 'skipped-non-sqlite'
  await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
  const rows = await client.$queryRawUnsafe('PRAGMA foreign_keys')
  // The engine maps SQLite integers to BigInt, but the assert accepts either
  // representation — what matters is that the posture is VERIFIABLY on.
  const row = Array.isArray(rows) ? (rows[0] as { foreign_keys?: unknown } | undefined) : undefined
  const readBack = row ? Number(row.foreign_keys) : NaN
  if (readBack !== 1) throw new ForeignKeysPragmaError(String(readBack))
  return 'enabled'
}