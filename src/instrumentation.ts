/**
 * Next.js server-boot hook — issue #135 (audit DB-12): the SQLite
 * `PRAGMA foreign_keys` assert.
 *
 * SQLite FK enforcement is a per-connection pragma (OFF by default in raw
 * SQLite); every Cascade/Restrict/SetNull in prisma/schema.prisma is a silent
 * no-op on a connection without it. Prisma's connector enables it on the
 * connections it opens — but that posture was "believed", never asserted.
 * This hook turns boot into the assertion point: once per server instance
 * (dev server and the standalone production server alike; `next build` skips
 * register by design), BEFORE any request is served:
 *
 *   · ensureForeignKeys() executes `PRAGMA foreign_keys = ON` and verifies
 *     the read-back is 1 (src/backend/lib/db.ts);
 *   · a failure is FATAL, not a warning: Next rethrows a register() rejection
 *     as "An error occurred while loading instrumentation hook: …" and the
 *     server never comes up — a misconfigured engine/driver cannot silently
 *     serve with FK enforcement off;
 *   · the guard is datasource-aware: a non-SQLite DATABASE_URL (the future
 *     Postgres/Supabase path) skips the pragma — there is nothing to assert
 *     there, Postgres enforces FKs natively.
 *
 * The `NEXT_RUNTIME === 'nodejs'`-style guard is deliberately written as an
 * edge-ONLY exemption (`!== 'edge'`): register() also runs in the edge
 * runtime context (src/proxy.ts), which cannot load Prisma — but an UNSET
 * NEXT_RUNTIME still runs the assert. Only the one known Prisma-less runtime
 * is exempt; the default is fail-closed, matching the issue's "fails loudly"
 * contract.
 *
 * DB-touching script entrypoints (prisma/seed.ts, prisma/seed-all.ts,
 * prisma/q2.ts, prisma/seed-extras/*) call the same ensureForeignKeys()
 * directly — scripts don't boot through Next.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return // edge (src/proxy.ts) never loads Prisma
  // Dynamic import: keeps the Prisma-laden module out of any edge bundle and
  // out of this module's top-level evaluation.
  const { ensureForeignKeys } = await import('./backend/lib/db')
  await ensureForeignKeys() // fatal on failure — the server refuses to start
}
