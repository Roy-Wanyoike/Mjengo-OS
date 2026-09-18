/**
 * PRAGMA foreign_keys boot assert — the stub half (issue #135 / audit DB-12).
 *
 * SQLite only enforces foreign keys when the connection carries
 * `PRAGMA foreign_keys = ON` — per-connection, OFF by default in raw SQLite,
 * and every Cascade/Restrict/SetNull in prisma/schema.prisma
 * (Delivery.materialId Restrict, LedgerEntry.accountId Restrict, …) is a
 * silent no-op without it. lib/db's ensureForeignKeys() is the boot-time
 * assertion: execute the pragma, read it back, REQUIRE a verified 1 — a
 * failure is fatal, never a warning.
 *
 * Pinned here with in-memory fakes (no engine, no DATABASE_URL — the
 * #184-harness real-engine half lives in db-fk-pragma-realdb.test.ts, the
 * src/instrumentation.ts boot wiring in db-fk-pragma-boot.test.ts):
 *
 *   · the assert executes `PRAGMA foreign_keys = ON` FIRST, then verifies
 *     the read-back is 1 — exact SQL, exact order;
 *   · a 0 read-back (the issue's simulated OFF posture) is a LOUD FATAL
 *     ForeignKeysPragmaError naming the pragma, the value read back, and
 *     the remediation;
 *   · a failing ON-execute rejects too (boot dies loudly, read-back never
 *     issued), and an unreadable posture is fatal — "unknown" is not "on"
 *     (fail-closed);
 *   · BigInt and number read-backs are both accepted (the real engine maps
 *     SQLite integers to BigInt);
 *   · the guard is datasource-aware: postgres/postgresql/mysql URLs skip
 *     with ZERO queries (the future Postgres/Supabase path enforces FKs
 *     natively); an unset URL also skips — Prisma itself then fails the
 *     first real query with "Environment variable not found: DATABASE_URL",
 *     a boot failure either way.
 */
import { describe, expect, it } from 'vitest'

import { ensureForeignKeys, ForeignKeysPragmaError } from '@/backend/lib/db'

/** One recorded raw-SQL call against the in-memory fake client. */
interface Call {
  op: '$executeRawUnsafe' | '$queryRawUnsafe'
  sql: string
}

/** A recording in-memory stand-in for the raw-SQL surface of PrismaClient. */
function fakeClient(opts: { readBack?: unknown; executeError?: Error } = {}) {
  const calls: Call[] = []
  return {
    calls,
    client: {
      async $executeRawUnsafe(sql: string) {
        calls.push({ op: '$executeRawUnsafe', sql })
        if (opts.executeError) throw opts.executeError
        return 0
      },
      async $queryRawUnsafe(sql: string) {
        calls.push({ op: '$queryRawUnsafe', sql })
        return opts.readBack
      },
    },
  }
}

const SQLITE_URL = 'file:./db/custom.db'

describe('ensureForeignKeys — the boot assert (#135 / DB-12)', () => {
  it('executes PRAGMA foreign_keys = ON first, then verifies the read-back — exact SQL, exact order', async () => {
    const { calls, client } = fakeClient({ readBack: [{ foreign_keys: 1n }] })
    await expect(ensureForeignKeys(client, SQLITE_URL)).resolves.toBe('enabled')
    expect(calls).toEqual([
      { op: '$executeRawUnsafe', sql: 'PRAGMA foreign_keys = ON' },
      { op: '$queryRawUnsafe', sql: 'PRAGMA foreign_keys' },
    ])
  })

  it('a 0 read-back (the simulated OFF posture) is a loud FATAL ForeignKeysPragmaError — boot refuses to start', async () => {
    const { client } = fakeClient({ readBack: [{ foreign_keys: 0n }] })
    const promise = ensureForeignKeys(client, SQLITE_URL)
    await expect(promise).rejects.toBeInstanceOf(ForeignKeysPragmaError)
    await expect(promise).rejects.toThrow(/PRAGMA foreign_keys is OFF/)
  })

  it('the fatal error names the pragma, the value read back, and the remediation', async () => {
    const { client } = fakeClient({ readBack: [{ foreign_keys: 0n }] })
    const err = (await ensureForeignKeys(client, SQLITE_URL).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(ForeignKeysPragmaError)
    expect(err.name).toBe('ForeignKeysPragmaError')
    expect(err.message).toContain('read-back: 0')
    expect(err.message).toContain('issue #135')
    expect(err.message).toContain('PRAGMA foreign_keys = ON')
  })

  it('the ON execute itself failing → the boot dies loudly (never swallowed), read-back never issued', async () => {
    const boom = new Error('engine exploded')
    const { calls, client } = fakeClient({ executeError: boom, readBack: [{ foreign_keys: 1n }] })
    await expect(ensureForeignKeys(client, SQLITE_URL)).rejects.toThrow('engine exploded')
    expect(calls).toEqual([{ op: '$executeRawUnsafe', sql: 'PRAGMA foreign_keys = ON' }])
  })

  it.each([
    ['no rows back', []],
    ['a row without the column', [{}]],
    ['a non-array body', 'SELECT returned a string'],
    ['null', null],
  ])('an unreadable posture (%s) is fatal — "unknown" is not "on", fail-closed', async (_label, readBack) => {
    const { client } = fakeClient({ readBack })
    await expect(ensureForeignKeys(client, SQLITE_URL)).rejects.toBeInstanceOf(ForeignKeysPragmaError)
  })

  it('BigInt and number read-backs are both accepted (the real engine maps SQLite integers to BigInt)', async () => {
    for (const foreign_keys of [1n, 1]) {
      const { client } = fakeClient({ readBack: [{ foreign_keys }] })
      await expect(ensureForeignKeys(client, SQLITE_URL)).resolves.toBe('enabled')
    }
  })

  it.each([
    ['file:./db/custom.db', 'enabled', 2],
    ['file:/var/lib/mjengo/custom.db', 'enabled', 2],
    ['sqlite:./x.db', 'enabled', 2],
    [':memory:', 'enabled', 2],
    ['postgres://user:pw@host:5432/db', 'skipped-non-sqlite', 0],
    ['postgresql://user:pw@host/db', 'skipped-non-sqlite', 0],
    ['mysql://host/db', 'skipped-non-sqlite', 0],
    ['', 'skipped-non-sqlite', 0],
  ])('datasource %j → %s with exactly %d queries issued', async (url, expected, queries) => {
    const { calls, client } = fakeClient({ readBack: [{ foreign_keys: 1n }] })
    await expect(ensureForeignKeys(client, url)).resolves.toBe(expected)
    expect(calls).toHaveLength(queries)
  })

  it('the datasource URL defaults to process.env.DATABASE_URL — the production source', async () => {
    const prev = process.env.DATABASE_URL
    try {
      process.env.DATABASE_URL = 'postgres://from-env@host/db'
      const off = fakeClient({ readBack: [{ foreign_keys: 1n }] })
      await expect(ensureForeignKeys(off.client)).resolves.toBe('skipped-non-sqlite')
      expect(off.calls).toHaveLength(0)

      process.env.DATABASE_URL = 'file:./from-env.db'
      const on = fakeClient({ readBack: [{ foreign_keys: 1n }] })
      await expect(ensureForeignKeys(on.client)).resolves.toBe('enabled')
      expect(on.calls).toHaveLength(2)
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prev
    }
  })
})
