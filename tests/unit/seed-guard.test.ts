/**
 * Issues #126 + #180 — the seed chain's production guard.
 *
 * The seed scripts wipe every table they own (deleteMany) before writing
 * demo rows, and users.ts plants login accounts whose passwords are public
 * in README.md — with NOTHING standing between that and a NODE_ENV=production
 * run except documentation. The fix is one decision point,
 * prisma/seed-guard.ts, wired as the first statement of the destructive
 * entries. Pinned here, per acceptance criteria:
 *
 *   · production refusal — NODE_ENV=production with no bypass env is
 *     REFUSED with a loud message naming the bypass variable;
 *   · bypass env — I_HAVE_BACKED_UP_AND_WANT_TO_SEED_PRODUCTION=1 lets a
 *     production run through, but ONLY against a local SQLite file:
 *     DATABASE_URL (a postgres:// URL is refused even with the bypass);
 *   · test-env allowance — development/test (and any non-production
 *     NODE_ENV, incl. unset) run with no bypass needed, keeping CI and the
 *     documented quickstart unchanged;
 *   · the #180 credential rule — in production-bypass mode the admin demo
 *     account is only seeded with an explicit SEED_DEMO_ADMIN=1;
 *   · wiring — assertSeedAllowed() is called BEFORE any deleteMany in
 *     seed-all.ts (the runner), seed.ts (the chain entry) and
 *     seed-extras/users.ts (the credential seed), and users.ts consults
 *     shouldSeedDemoAdmin() when building its rows.
 *
 * The decision helpers are PURE (env in, verdict out — no process.env
 * mutation, no database); only the assertSeedAllowed() wrapper tests touch
 * process.env/process.exit, with spies and save/restore.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SEED_DEMO_ADMIN_ENV,
  SEED_PROD_BYPASS_ENV,
  assertSeedAllowed,
  evaluateSeedGuard,
  isLocalFileDatabaseUrl,
  shouldSeedDemoAdmin,
} from '../../prisma/seed-guard'

const LOCAL_DB = 'file:./db/seed-guard-check.db'

/** Source of a seed script, for the wiring pins (sw-offline-shell idiom). */
const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const SEED_ALL_SRC = src('../../prisma/seed-all.ts')
const SEED_SRC = src('../../prisma/seed.ts')
const USERS_SRC = src('../../prisma/seed-extras/users.ts')

// ---------------------------------------------- the env names are contract

describe('guard env names (the documented contract)', () => {
  it('the bypass env is the exact issue-#126 literal', () => {
    expect(SEED_PROD_BYPASS_ENV).toBe('I_HAVE_BACKED_UP_AND_WANT_TO_SEED_PRODUCTION')
  })

  it('the admin opt-in env is the exact issue-#180 literal', () => {
    expect(SEED_DEMO_ADMIN_ENV).toBe('SEED_DEMO_ADMIN')
  })
})

// ---------------------------------------- isLocalFileDatabaseUrl (defensive)

describe('isLocalFileDatabaseUrl — what counts as a local file', () => {
  it('accepts the SQLite URL family (case-insensitive)', () => {
    for (const url of [
      'file:./db/custom.db',
      'file:/app/db/custom.db',
      'FILE:../db/custom.db',
      'sqlite:./db/custom.db',
      'Sqlite3:/tmp/x.db',
    ]) {
      expect(isLocalFileDatabaseUrl(url)).toBe(true)
    }
  })

  it('rejects everything that points outside local files', () => {
    for (const url of [
      'postgres://user:pass@db.example.com:5432/mjengo',
      'postgresql://db.example.com/mjengo',
      'mysql://db.example.com/mjengo',
      'https://db.example.com/mjengo',
      './db/custom.db', // bare path — not a URL Prisma accepts; refuse, stay honest
      '',
    ]) {
      expect(isLocalFileDatabaseUrl(url)).toBe(false)
    }
  })
})

// ------------------------------------------------ evaluateSeedGuard (pure)

describe('evaluateSeedGuard — production refusal (#126)', () => {
  it('NODE_ENV=production with no bypass → refused with the loud message', () => {
    const result = evaluateSeedGuard({ NODE_ENV: 'production', DATABASE_URL: LOCAL_DB })
    expect(result).toMatchObject({ ok: false, reason: 'production' })
    if (!result.ok) {
      // Loud + actionable: names the wipe, the bypass env and the docs.
      expect(result.message).toContain('REFUSING TO SEED')
      expect(result.message).toContain('NODE_ENV=production')
      expect(result.message).toContain('I_HAVE_BACKED_UP_AND_WANT_TO_SEED_PRODUCTION=1')
      expect(result.message).toContain('DEPLOYMENT.md §6.4')
    }
  })

  it('only the exact bypass value "1" unlocks production — "true"/"yes"/"0" still refuse', () => {
    for (const value of ['true', 'yes', '0', '']) {
      const result = evaluateSeedGuard({
        NODE_ENV: 'production',
        DATABASE_URL: LOCAL_DB,
        [SEED_PROD_BYPASS_ENV]: value,
      })
      expect(result).toMatchObject({ ok: false, reason: 'production' })
    }
  })

  it('unset NODE_ENV and non-production runtimes are allowed with NO bypass (dev/CI unchanged)', () => {
    for (const nodeEnv of [undefined, 'development', 'test', 'staging', 'preview']) {
      const result = evaluateSeedGuard({ NODE_ENV: nodeEnv, DATABASE_URL: LOCAL_DB })
      expect(result).toStrictEqual({ ok: true, productionBypass: false })
      // A stray bypass env must not change the non-production verdict.
      const withBypass = evaluateSeedGuard({
        NODE_ENV: nodeEnv,
        DATABASE_URL: LOCAL_DB,
        [SEED_PROD_BYPASS_ENV]: '1',
      })
      expect(withBypass).toStrictEqual({ ok: true, productionBypass: false })
    }
  })
})

describe('evaluateSeedGuard — bypass + the defensive DATABASE_URL rule', () => {
  const bypass = { NODE_ENV: 'production', [SEED_PROD_BYPASS_ENV]: '1' } as const

  it('bypass + local file: DATABASE_URL → allowed, flagged as productionBypass', () => {
    expect(evaluateSeedGuard({ ...bypass, DATABASE_URL: LOCAL_DB })).toStrictEqual({
      ok: true,
      productionBypass: true,
    })
  })

  it('bypass + remote DATABASE_URL (postgres) → STILL refused, even with the bypass', () => {
    const result = evaluateSeedGuard({
      ...bypass,
      DATABASE_URL: 'postgres://user:pass@db.example.com:5432/mjengo',
    })
    expect(result).toMatchObject({ ok: false, reason: 'remote-database' })
    if (!result.ok) {
      expect(result.message).toContain('REFUSING TO SEED')
      expect(result.message).toContain('postgres://user:pass@db.example.com:5432/mjengo')
    }
  })

  it('bypass + unset DATABASE_URL → passes the guard (Prisma itself then fails closed)', () => {
    // No URL to inspect — the Prisma client refuses to boot without
    // DATABASE_URL, so nothing is ever wiped on this path.
    expect(evaluateSeedGuard({ ...bypass })).toStrictEqual({ ok: true, productionBypass: true })
  })
})

// ------------------------------------------- shouldSeedDemoAdmin (#180)

describe('shouldSeedDemoAdmin — the repo-public admin credential rule', () => {
  it('non-production → admin is seeded (the documented quickstart)', () => {
    expect(shouldSeedDemoAdmin({ NODE_ENV: 'development', DATABASE_URL: LOCAL_DB })).toBe(true)
    expect(shouldSeedDemoAdmin({ NODE_ENV: 'test', DATABASE_URL: LOCAL_DB })).toBe(true)
    // SEED_DEMO_ADMIN is a no-op outside production-bypass mode.
    expect(
      shouldSeedDemoAdmin({ NODE_ENV: 'test', DATABASE_URL: LOCAL_DB, [SEED_DEMO_ADMIN_ENV]: '0' }),
    ).toBe(true)
  })

  it('production bypass without SEED_DEMO_ADMIN → admin NOT seeded', () => {
    expect(
      shouldSeedDemoAdmin({
        NODE_ENV: 'production',
        DATABASE_URL: LOCAL_DB,
        [SEED_PROD_BYPASS_ENV]: '1',
      }),
    ).toBe(false)
  })

  it('production bypass + SEED_DEMO_ADMIN=1 → admin seeded (explicit opt-in)', () => {
    expect(
      shouldSeedDemoAdmin({
        NODE_ENV: 'production',
        DATABASE_URL: LOCAL_DB,
        [SEED_PROD_BYPASS_ENV]: '1',
        [SEED_DEMO_ADMIN_ENV]: '1',
      }),
    ).toBe(true)
  })

  it('plain production (no bypass) → not seeded (the guard refuses the run first)', () => {
    expect(
      shouldSeedDemoAdmin({
        NODE_ENV: 'production',
        DATABASE_URL: LOCAL_DB,
        [SEED_DEMO_ADMIN_ENV]: '1',
      }),
    ).toBe(false)
  })
})

// ------------------------------------------- assertSeedAllowed (the wrapper)

describe('assertSeedAllowed — process wrapper exit semantics', () => {
  const savedNodeEnv = process.env.NODE_ENV
  const savedBypass = process.env[SEED_PROD_BYPASS_ENV]
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
    if (savedBypass === undefined) delete process.env[SEED_PROD_BYPASS_ENV]
    else process.env[SEED_PROD_BYPASS_ENV] = savedBypass
    exitSpy.mockClear()
    errorSpy.mockClear()
    warnSpy.mockClear()
  })

  it('production without bypass → exit(1) + the refusal message on stderr', () => {
    process.env.NODE_ENV = 'production'
    delete process.env[SEED_PROD_BYPASS_ENV]
    assertSeedAllowed()
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('REFUSING TO SEED')
  })

  it('test runtime → passes silently (no exit, no warnings)', () => {
    process.env.NODE_ENV = 'test'
    delete process.env[SEED_PROD_BYPASS_ENV]
    assertSeedAllowed()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('production bypass → passes but warns loudly about the demo passwords', () => {
    process.env.NODE_ENV = 'production'
    process.env[SEED_PROD_BYPASS_ENV] = '1'
    assertSeedAllowed()
    expect(exitSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('SEEDING PRODUCTION')
  })
})

// ------------------------------------------- wiring (source pins)

describe('wiring — the guard actually guards the destructive entries', () => {
  it('seed-all.ts calls assertSeedAllowed() before running any step', () => {
    expect(SEED_ALL_SRC).toContain("from './seed-guard'")
    expect(SEED_ALL_SRC).toContain('assertSeedAllowed()')
    // Before the runner spawns the first script…
    expect(SEED_ALL_SRC.indexOf('assertSeedAllowed()')).toBeLessThan(SEED_ALL_SRC.indexOf('spawnSync('))
    // …and before the destructive-wipe summary is even printed.
    expect(SEED_ALL_SRC.indexOf('assertSeedAllowed()')).toBeLessThan(
      SEED_ALL_SRC.indexOf('DESTRUCTIVE SEED'),
    )
  })

  it('seed.ts calls assertSeedAllowed() before its first deleteMany', () => {
    expect(SEED_SRC).toContain("from './seed-guard'")
    const guardAt = SEED_SRC.indexOf('assertSeedAllowed()')
    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(guardAt).toBeLessThan(SEED_SRC.indexOf('deleteMany'))
  })

  it('users.ts is guarded and consults shouldSeedDemoAdmin before creating rows', () => {
    expect(USERS_SRC).toContain("from '../seed-guard'")
    const guardAt = USERS_SRC.indexOf('assertSeedAllowed()')
    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(guardAt).toBeLessThan(USERS_SRC.indexOf('deleteMany'))
    const adminAt = USERS_SRC.indexOf('shouldSeedDemoAdmin(')
    expect(adminAt).toBeGreaterThan(0)
    // The admin row itself is behind the seedAdmin conditional…
    expect(USERS_SRC).toContain('...(seedAdmin')
    // …and the loud "NOT created" notice explains the SEED_DEMO_ADMIN opt-in.
    expect(USERS_SRC).toContain('admin@mjengo.os NOT created')
  })
})
