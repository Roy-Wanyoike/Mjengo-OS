import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  LoginTracker,
  LoginTrackerKind,
  LoginTrackerStore,
  RateLimitStore,
} from '@/backend/lib/rate-limit'

/**
 * SQLite-backed implementations of the rate-limit / login-lockout store seams
 * (W3-b, closes issue #33: "Rate-limit/lockout store is in-process only —
 * multi-instance deploys lose shared state").
 *
 * PERSISTENCE CHOICE — better-sqlite3, and why not the alternatives:
 *  · NOT the main Prisma client ($executeRaw + a runtime-CREATE'd table):
 *    the RateLimitStore seam is SYNCHRONOUS (hit/check) and so are the login
 *    lockout functions in rate-limit.ts — a Prisma-backed store would be
 *    async, rippling through auth.ts's synchronous lockout calls. Rate-limit
 *    state is cache-like, not domain data: it must not live in the main
 *    custom.db (backup/migration surface), so a Prisma route would need a
 *    second client anyway ("doubles Prisma clients" — rejected).
 *  · NOT node:sqlite (Node 22+ only; the Docker runner is node:20-slim) and
 *    NOT bun:sqlite (the production runtime is plain node).
 *  · better-sqlite3@^12: engines "20.x || 22.x || … || 26.x" (node:20-slim ✓,
 *    the sandbox's node 24 ✓). Synchronous API ⇒ the exact memory-store math
 *    with zero interface churn. HONEST COSTS:
 *      (a) native runtime dep — loaded via createRequire from process.cwd()
 *          (the dev/test repo root and the standalone server root /app both
 *          own node_modules), deliberately INVISIBLE to bundlers so neither
 *          webpack nor Turbopack tries to trace it into the standalone
 *          bundle. A Docker image therefore needs one COPY line in the
 *          runner stage (see DEPLOYMENT.md §9.4) or the store logs a
 *          fallback warning and stays in-memory.
 *      (b) the Bun runtime hard-crashes on this native addon (verified: Bun
 *          1.3.x, v12 and v13 — a crash, not a catchable throw), so the
 *          loader detects process.versions.bun and refuses honestly.
 *      (c) single HOST only — one shared file on one filesystem.
 *          Multi-host still needs the Redis implementation of the same seam
 *          (deliberately not built — no new external service in this repo).
 *
 * CONCURRENCY & DURABILITY: WAL journal + busy_timeout 5000 ms + BEGIN
 * IMMEDIATE around every read-modify-write. Multiple processes on one host
 * see committed state immediately (a bucket exhausted on process A blocks
 * process B — the point of issue #33) and writers serialize over µs-scale
 * critical sections. synchronous=NORMAL: commits survive app crashes; a
 * power cut may lose the last ticks of rate-limit state — harmless for
 * counters, documented here rather than pretended away.
 *
 * FAILURE POLICY (both directions honest):
 *  · INIT failure (module missing, unwritable/bad path, Bun runtime, db
 *    open error): createSqliteStores returns null after ONE console.warn —
 *    the caller (rate-limit.ts resolveStores) falls back to the in-memory
 *    stores. Rate limiting never prevents boot.
 *  · RUNTIME statement failure: fail OPEN with a once-per-store warning.
 *    The in-memory store these replace never fails; a degraded optional
 *    store must not wedge every request behind 429s (a full disk would
 *    otherwise brick the whole API). Losing enforcement while the store is
 *    broken is the smaller, loudly-logged evil.
 *
 * SCHEMA: additive, owned by this module, created lazily on first open
 * (CREATE TABLE IF NOT EXISTS) — never via Prisma migrations. The two tables
 * (rl_bucket, rl_login_tracker) are disposable cache state: deleting the
 * file while the app is stopped simply resets everyone's limits and lockouts.
 */

// ---------------------------------------------------------------- driver load

/**
 * Structural slices of the better-sqlite3 API this module uses. Types are
 * local (not @types/better-sqlite3) because the module is loaded DYNAMICALLY
 * (createRequire) — these keep the store code honestly typed without making
 * the dependency a compile-time import.
 */
type SqliteStatement = {
  run(...params: unknown[]): { changes: number }
  get(...params: unknown[]): unknown
}

type SqliteDatabase = {
  exec(sql: string): unknown
  prepare(sql: string): SqliteStatement
  pragma(source: string): unknown
}

type SqliteDatabaseCtor = new (path: string, opts?: { timeout?: number }) => SqliteDatabase

/** Default store file — relative, resolved against the process working dir
 *  (repo root in dev/tests ⇒ db/ratelimit.db next to custom.db; /app in the
 *  Docker standalone runtime ⇒ /app/db/ratelimit.db on the db volume). NEVER
 *  the Prisma database file. */
export const DEFAULT_RATE_LIMIT_SQLITE_PATH = 'db/ratelimit.db'

export type SqliteStores = {
  rateLimitStore: SqliteRateLimitStore
  loginTrackerStore: SqliteLoginTrackerStore
}

/** True when running under the Bun runtime (cannot load the addon — crashes). */
function isBunRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean((process.versions as { bun?: string } | undefined)?.bun)
}

/**
 * Load the better-sqlite3 constructor, or null with a reason logged by the
 * CALLER. Anchored at process.cwd() — the documented runtimes (next dev from
 * the repo root, vitest, `node server.js` from the standalone root) all have
 * their node_modules there. Never throws.
 */
function loadSqliteConstructor(): { ctor: SqliteDatabaseCtor } | { error: string } {
  if (isBunRuntime()) {
    return {
      error:
        'the better-sqlite3 native addon hard-crashes under the Bun runtime ' +
        '(verified on Bun 1.3.x) — run the standalone server with node ' +
        '(the Docker CMD) or keep RATE_LIMIT_STORE unset',
    }
  }
  try {
    // createRequire is invisible to webpack/Turbopack tracing (a literal
    // `import 'better-sqlite3'` would drag the native module into the
    // standalone bundle and break the build) — hence this indirection.
    const anchoredAtCwd = pathToFileURL(join(process.cwd(), 'rate-limit-anchor.js')).href
    const requireFn = createRequire(anchoredAtCwd)
    const mod = requireFn('better-sqlite3') as unknown
    const ctor = (typeof mod === 'function' ? mod : (mod as { default?: unknown }).default) as
      | SqliteDatabaseCtor
      | undefined
    if (typeof ctor !== 'function') return { error: 'better-sqlite3 did not export a Database constructor' }
    return { ctor }
  } catch (err) {
    return { error: `better-sqlite3 is not loadable in this runtime (${describeError(err)})` }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Resolve the store file path from env (file: prefix tolerated for symmetry
 *  with DATABASE_URL). Never throws, never empty. */
export function resolveRateLimitSqlitePath(env: NodeJS.ProcessEnv): string {
  const raw = (env.RATE_LIMIT_SQLITE_PATH ?? '').trim()
  if (!raw) return DEFAULT_RATE_LIMIT_SQLITE_PATH
  return raw.startsWith('file:') ? raw.slice('file:'.length).trim() || DEFAULT_RATE_LIMIT_SQLITE_PATH : raw
}

/**
 * Open the shared store file (WAL, busy timeout, additive schema) or null on
 * ANY failure — the caller decides the fallback. Eager: the file is created
 * and the schema applied at init, so an unwritable path fails at boot with
 * one honest warning, not on the first limited request.
 */
function openSqliteDatabase(path: string): { db: SqliteDatabase } | { error: string } {
  const loaded = loadSqliteConstructor()
  if ('error' in loaded) return { error: loaded.error }
  try {
    const db = new loaded.ctor(path, { timeout: 5000 })
    // Multi-process posture: WAL lets readers in other processes see
    // committed writes immediately; busy_timeout absorbs writer contention.
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 5000')
    db.exec(SCHEMA_SQL)
    return { db }
  } catch (err) {
    return { error: `cannot open SQLite rate-limit store at "${path}" (${describeError(err)})` }
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rl_bucket (
  bucket_key    TEXT PRIMARY KEY,
  tokens        REAL    NOT NULL,
  last_refill   INTEGER NOT NULL,
  limit_tokens  REAL    NOT NULL,
  refill_per_ms REAL    NOT NULL
);
CREATE TABLE IF NOT EXISTS rl_login_tracker (
  kind            TEXT    NOT NULL CHECK (kind IN ('email', 'pair')),
  track_key       TEXT    NOT NULL,
  failures        INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL,
  locked_until    INTEGER NOT NULL,
  PRIMARY KEY (kind, track_key)
);
`

/**
 * Build both SQLite stores (token buckets + login trackers) over one shared
 * file, or null on ANY init failure after logging ONE warning — the caller
 * falls back to the in-memory stores. Honest by construction: the app never
 * fails to boot because of rate limiting.
 */
export function createSqliteStores(env: NodeJS.ProcessEnv): SqliteStores | null {
  const path = resolveRateLimitSqlitePath(env)
  const opened = openSqliteDatabase(path)
  if ('error' in opened) {
    console.warn(
      `[rate-limit] RATE_LIMIT_STORE=sqlite is not active: ${opened.error}. ` +
        `Falling back to the in-memory store — per-process counters (issue #33 posture).`,
    )
    return null
  }
  try {
    return {
      rateLimitStore: new SqliteRateLimitStore(opened.db),
      loginTrackerStore: new SqliteLoginTrackerStore(opened.db),
    }
  } catch (err) {
    console.warn(
      `[rate-limit] RATE_LIMIT_STORE=sqlite is not active: store construction failed ` +
        `(${describeError(err)}). Falling back to the in-memory store — per-process counters.`,
    )
    return null
  }
}

// ------------------------------------------------------------ token buckets

type BucketRow = { tokens: number; last_refill: number; limit_tokens: number; refill_per_ms: number }

/**
 * Token buckets persisted in one SQLite file. The refill math is byte-for-
 * byte the MemoryRateLimitStore algorithm (compute-on-read: allowance =
 * min(limit, tokens + elapsed × refillPerMs)), just with the bucket state
 * read from / written to disk inside an IMMEDIATE transaction — so every
 * process sharing the file observes the same exhaustion, refill and window
 * reset semantics the in-memory store pins in tests/unit/rate-limit.test.ts.
 */
export class SqliteRateLimitStore implements RateLimitStore {
  private readonly db: SqliteDatabase
  private readonly selectBucket: SqliteStatement
  private readonly upsertBucket: SqliteStatement
  private readonly sweepBuckets: SqliteStatement
  private warned = false

  constructor(db: SqliteDatabase) {
    this.db = db
    this.selectBucket = db.prepare(
      'SELECT tokens, last_refill, limit_tokens, refill_per_ms FROM rl_bucket WHERE bucket_key = ?',
    )
    this.upsertBucket = db.prepare(
      `INSERT INTO rl_bucket (bucket_key, tokens, last_refill, limit_tokens, refill_per_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         tokens = excluded.tokens,
         last_refill = excluded.last_refill,
         limit_tokens = excluded.limit_tokens,
         refill_per_ms = excluded.refill_per_ms`,
    )
    this.sweepBuckets = db.prepare(
      'DELETE FROM rl_bucket WHERE tokens + (? - last_refill) * refill_per_ms >= limit_tokens',
    )
  }

  /** Consume one token; null = allowed, else seconds until one refills. */
  hit(key: string, limit: number, windowMs: number, now: number): number | null {
    try {
      return this.inTx(() => {
        const refillPerMs = limit / Math.max(1, windowMs)
        const row = this.selectBucket.get(key) as BucketRow | undefined
        // Same reset rule as MemoryRateLimitStore.refill(): a changed limit or
        // refill rate starts a fresh, full bucket.
        const base =
          !row || row.limit_tokens !== limit || row.refill_per_ms !== refillPerMs
            ? { tokens: limit, lastRefill: now, limit, refillPerMs }
            : {
                tokens: row.tokens,
                lastRefill: row.last_refill,
                limit: row.limit_tokens,
                refillPerMs: row.refill_per_ms,
              }
        const available = Math.min(base.limit, base.tokens + (now - base.lastRefill) * base.refillPerMs)
        // Persist immediately (cross-process visibility) with the post-hit
        // state the memory store keeps: consume on allow, keep the fraction
        // on block, lastRefill always advances to now.
        this.upsertBucket.run(
          key,
          available >= 1 ? available - 1 : available,
          now,
          limit,
          refillPerMs,
        )
        if (available >= 1) return null
        return Math.max(1, Math.ceil((1 - available) / base.refillPerMs / 1000))
      })
    } catch (err) {
      this.degrade('hit', err)
      return null // fail-open (module header: availability > enforcement when degraded)
    }
  }

  /** Report whether a token is available without consuming one. */
  check(key: string, limit: number, windowMs: number, now: number): number | null {
    try {
      const row = this.selectBucket.get(key) as BucketRow | undefined
      if (!row) return null // a bucket nobody hit is full (memory parity)
      const available = Math.min(row.limit_tokens, row.tokens + (now - row.last_refill) * row.refill_per_ms)
      if (available >= 1) return null
      return Math.max(1, Math.ceil((1 - available) / row.refill_per_ms / 1000))
    } catch (err) {
      this.degrade('check', err)
      return null
    }
  }

  /** Best-effort removal of fully-refilled entries (lazy cadence, no timer). */
  sweep(now: number): void {
    try {
      this.sweepBuckets.run(now)
    } catch (err) {
      this.degrade('sweep', err)
    }
  }

  /** Read-modify-write under BEGIN IMMEDIATE — cross-process atomic. */
  private inTx<T>(fn: () => T): T {
    if (this.inTxDepth > 0) return fn() // nested (single connection): already atomic
    this.db.exec('BEGIN IMMEDIATE')
    this.inTxDepth += 1
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* transaction already closed by the failure */
      }
      throw err
    } finally {
      this.inTxDepth -= 1
    }
  }

  private inTxDepth = 0

  private degrade(op: string, err: unknown): void {
    if (this.warned) return
    this.warned = true
    console.warn(
      `[rate-limit] sqlite store degraded — ${op}() failed (${describeError(err)}); ` +
        `failing OPEN (requests pass) until the store recovers. Counter state may be lost.`,
    )
  }
}

// ------------------------------------------------------------- login trackers

type TrackerRow = { failures: number; last_failure_at: number; locked_until: number }

/**
 * Login lockout trackers persisted in one SQLite file — the same two key
 * spaces as the in-memory maps ('email' kind: the account key,
 * 'pair' kind: the `email|ip` key), the same 5-strikes/window/lockout
 * lifecycle (the engine lives in rate-limit.ts and is shared by both
 * stores, so the semantics cannot drift). Read-modify-write cycles run
 * inside transact() (BEGIN IMMEDIATE) so two processes recording the same
 * account's 4th+5th failure cannot lose the count.
 */
export class SqliteLoginTrackerStore implements LoginTrackerStore {
  private readonly db: SqliteDatabase
  private readonly selectTracker: SqliteStatement
  private readonly upsertTracker: SqliteStatement
  private readonly delTracker: SqliteStatement
  private readonly pruneTrackersStmt: SqliteStatement
  private warned = false
  private inTxDepth = 0

  constructor(db: SqliteDatabase) {
    this.db = db
    this.selectTracker = db.prepare(
      'SELECT failures, last_failure_at, locked_until FROM rl_login_tracker WHERE kind = ? AND track_key = ?',
    )
    this.upsertTracker = db.prepare(
      `INSERT INTO rl_login_tracker (kind, track_key, failures, last_failure_at, locked_until)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, track_key) DO UPDATE SET
         failures = excluded.failures,
         last_failure_at = excluded.last_failure_at,
         locked_until = excluded.locked_until`,
    )
    this.delTracker = db.prepare('DELETE FROM rl_login_tracker WHERE kind = ? AND track_key = ?')
    this.pruneTrackersStmt = db.prepare(
      'DELETE FROM rl_login_tracker WHERE (locked_until = 0 OR locked_until <= ?) AND (? - last_failure_at > ?)',
    )
  }

  getTracker(kind: LoginTrackerKind, key: string): LoginTracker | undefined {
    try {
      const row = this.selectTracker.get(kind, key) as TrackerRow | undefined
      if (!row) return undefined
      return { failures: row.failures, lastFailureAt: row.last_failure_at, lockedUntil: row.locked_until }
    } catch (err) {
      this.degrade('getTracker', err)
      return undefined // fail-open: no tracker ⇒ treated as not locked
    }
  }

  putTracker(kind: LoginTrackerKind, key: string, tracker: LoginTracker): void {
    try {
      this.upsertTracker.run(kind, key, tracker.failures, tracker.lastFailureAt, tracker.lockedUntil)
    } catch (err) {
      this.degrade('putTracker', err)
    }
  }

  deleteTracker(kind: LoginTrackerKind, key: string): void {
    try {
      this.delTracker.run(kind, key)
    } catch (err) {
      this.degrade('deleteTracker', err)
    }
  }

  /** Remove trackers whose lock is served AND whose window is cold — the
   *  exact memory sweep predicate, pruned in the shared file (lazy cadence,
   *  no background timer). */
  pruneTrackers(now: number, windowMs: number): void {
    try {
      this.pruneTrackersStmt.run(now, now, windowMs)
    } catch (err) {
      this.degrade('pruneTrackers', err)
    }
  }

  /** Run fn atomically vs other processes (BEGIN IMMEDIATE). Memory-parity
   *  fallback: if the write txn cannot even start, fn still runs (autocommit)
   *  after one warning — login must never 500 because the lockout store is
   *  degraded. */
  transact<T>(fn: () => T): T {
    if (this.inTxDepth > 0) return fn()
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch (err) {
      this.degrade('transact(begin)', err)
      return fn()
    }
    this.inTxDepth += 1
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* transaction already closed by the failure */
      }
      throw err
    } finally {
      this.inTxDepth -= 1
    }
  }

  private degrade(op: string, err: unknown): void {
    if (this.warned) return
    this.warned = true
    console.warn(
      `[rate-limit] sqlite login-tracker store degraded — ${op} failed (${describeError(err)}); ` +
        `failing OPEN (no lockout enforcement) until the store recovers.`,
    )
  }
}
