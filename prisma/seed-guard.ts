// Seed production guard (issues #126 + #180).
//
// The seed chain is DESTRUCTIVE BY DESIGN: every script deletes all rows in
// the tables it owns (projects, workers, ledger, users, …) before writing
// demo data, and users.ts plants login accounts whose passwords are public
// in README.md (the documented quickstart). That is the right posture for a
// dev/demo database — and the wrong default anywhere else.
//
// This module is the single decision point, kept dependency-free (no
// PrismaClient import) so tests/unit/seed-guard.test.ts can pin the rules
// without touching a database:
//
//   · NODE_ENV !== 'production'            → allowed (dev/demo/test, no bypass)
//   · NODE_ENV === 'production', no bypass → REFUSED, exit 1, loud message
//   · NODE_ENV === 'production' + bypass   → allowed, but only against a
//     local SQLite file: URL (defensive — the chain is only honest for the
//     local demo DB; anything else (postgres://…) is refused even with the
//     bypass). In bypass mode the demo ADMIN account is additionally skipped
//     unless SEED_DEMO_ADMIN=1 (its password is repo-public — #180).
//
// Wiring: assertSeedAllowed() is the first statement of prisma/seed-all.ts,
// prisma/seed.ts and prisma/seed-extras/users.ts (the chain entry + the two
// scripts that own the destructive wipe and the credentials).

/** The explicit, per-run production acknowledgment (issue #126). */
export const SEED_PROD_BYPASS_ENV = 'I_HAVE_BACKED_UP_AND_WANT_TO_SEED_PRODUCTION'

/** Opt-in for the repo-public demo admin password in production-bypass mode (#180). */
export const SEED_DEMO_ADMIN_ENV = 'SEED_DEMO_ADMIN'

/** Anything the guard reads — process.env satisfies this. */
export type SeedEnv = Record<string, string | undefined>

export type SeedGuardResult =
  | { ok: true; productionBypass: boolean }
  | { ok: false; reason: 'production' | 'remote-database'; message: string }

/**
 * True when DATABASE_URL points at a local SQLite file (`file:`/`sqlite:`/
 * `sqlite3:`, case-insensitive — the only URLs this seed chain supports).
 * Anything else — postgres://, mysql://, https://, a bare path — is "outside
 * local files" and refused in production context.
 */
export function isLocalFileDatabaseUrl(url: string): boolean {
  const colon = url.indexOf(':')
  const scheme = colon === -1 ? '' : url.slice(0, colon).toLowerCase()
  return scheme === 'file' || scheme === 'sqlite' || scheme === 'sqlite3'
}

/**
 * The pure guard decision. Takes the env explicitly so tests (and callers)
 * never have to mutate process.env to reason about a scenario.
 */
export function evaluateSeedGuard(env: SeedEnv): SeedGuardResult {
  if (env.NODE_ENV !== 'production') {
    return { ok: true, productionBypass: false }
  }

  if (env[SEED_PROD_BYPASS_ENV] !== '1') {
    return {
      ok: false,
      reason: 'production',
      message:
        `✗ REFUSING TO SEED: NODE_ENV=production.\n` +
        `  The seed chain DELETES every row in the tables it owns (projects, workers,\n` +
        `  ledger, users, …) before writing demo data, and the demo passwords are\n` +
        `  public in README.md. If you have a VERIFIED BACKUP and really want this,\n` +
        `  re-run with:\n` +
        `      ${SEED_PROD_BYPASS_ENV}=1\n` +
        `  Even then: only a local SQLite file: DATABASE_URL is accepted, the admin\n` +
        `  account is skipped unless ${SEED_DEMO_ADMIN_ENV}=1, and every demo password\n` +
        `  must be changed immediately. See DEPLOYMENT.md §6.4.`,
    }
  }

  const url = env.DATABASE_URL?.trim()
  if (url && !isLocalFileDatabaseUrl(url)) {
    return {
      ok: false,
      reason: 'remote-database',
      message:
        `✗ REFUSING TO SEED: production bypass (${SEED_PROD_BYPASS_ENV}=1) is set,\n` +
        `  but DATABASE_URL does not point at a local SQLite file:\n` +
        `      DATABASE_URL=${url}\n` +
        `  This demo seed chain only supports a local file: database — anything else\n` +
        `  looks like live data about to be wiped. See DEPLOYMENT.md §6.4.`,
    }
  }

  return { ok: true, productionBypass: true }
}

/**
 * Whether users.ts may create the admin@mjengo.os demo account (#180).
 * Always yes outside production (the documented quickstart); in
 * production-bypass mode only with an explicit SEED_DEMO_ADMIN=1.
 */
export function shouldSeedDemoAdmin(env: SeedEnv): boolean {
  const result = evaluateSeedGuard(env)
  if (!result.ok) return false // unreachable behind assertSeedAllowed(), but honest
  if (!result.productionBypass) return true
  return env[SEED_DEMO_ADMIN_ENV] === '1'
}

/**
 * The wrapper the seed scripts call as their FIRST statement: prints the
 * refusal message and exits 1 (honest non-zero exit), or warns loudly once
 * when running in production-bypass mode.
 */
export function assertSeedAllowed(): void {
  const result = evaluateSeedGuard(process.env)
  if (result.ok) {
    if (result.productionBypass) {
      console.warn(
        `\n⚠  SEEDING PRODUCTION (explicit ${SEED_PROD_BYPASS_ENV}=1 bypass).\n` +
        `  Every table this chain owns is about to be wiped and re-seeded with DEMO\n` +
        `  data whose passwords are PUBLIC in README.md — change them all immediately\n` +
        `  after this run. The admin account is only created when ${SEED_DEMO_ADMIN_ENV}=1.\n`,
      )
    }
    return
  }
  console.error(`\n${result.message}\n`)
  process.exit(1)
}
