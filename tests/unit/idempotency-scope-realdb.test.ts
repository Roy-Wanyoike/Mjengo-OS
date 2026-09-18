/**
 * IdempotencyRecord principal scoping against a REAL SQLite database
 * (issue #177 / audit SEC-10) — the DB-level companion of
 * idempotency-scope.test.ts (the route/applier seams) and
 * wallet-idempotency.test.ts (withIdempotency).
 *
 * The stubs prove the namespaced write/lookup logic; this file proves the
 * guarantee the fix actually leans on, where it is supposed to live: the
 * composite UNIQUE (principal, scope, key) created by migration
 * 17_idempotency_principal_scope on the real engine —
 *
 *   · two actors recording the SAME caller key coexist (one row per
 *     namespace — the pre-#177 GLOBAL unique on `key` alone would have
 *     rejected the second outright);
 *   · the same (principal, scope, key) triple is refused by the real
 *     constraint (P2002) — the write-time dedupe;
 *   · the same key under a different SCOPE (a different action type)
 *     coexists — scope is part of the keyspace;
 *   · the `principal` column exists NOT NULL with the migration's
 *     backfill buckets reachable ('' default = the never-looked-up bucket);
 *   · the old global unique index on `key` is GONE (sqlite_master).
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', async () => (await import('../helpers/db')).realDbModule())

import { disposeRealDb, getRealTestDb } from '../helpers/db'

const { prisma, sqlite } = getRealTestDb()
afterAll(disposeRealDb)

describe('IdempotencyRecord — the (principal, scope, key) composite unique (#177)', () => {
  it('two actors recording the SAME caller key coexist — one row per namespace', async () => {
    const base = { scope: 'comment.add', projectId: 'p-1', responseBody: '{"ok":1}' }
    await prisma.idempotencyRecord.create({
      data: { principal: 'user:a@demo.test|project:p-1', key: 'same-key', ...base },
    })
    await prisma.idempotencyRecord.create({
      data: { principal: 'user:b@demo.test|project:p-2', key: 'same-key', ...base },
    })
    const rows = await prisma.idempotencyRecord.findMany({ where: { key: 'same-key' } })
    expect(rows.map((r) => r.principal).sort()).toEqual([
      'user:a@demo.test|project:p-1',
      'user:b@demo.test|project:p-2',
    ])
  })

  it('the SAME (principal, scope, key) triple is refused by the real constraint (P2002)', async () => {
    await prisma.idempotencyRecord.create({
      data: { principal: 'user:dupe@demo.test|project:p-1', key: 'dupe-key', scope: 'comment.add', responseBody: null },
    })
    await expect(
      prisma.idempotencyRecord.create({
        data: { principal: 'user:dupe@demo.test|project:p-1', key: 'dupe-key', scope: 'comment.add', responseBody: '{}' },
      }),
    ).rejects.toThrow(/Unique constraint failed/i)
  })

  it('the same key under a DIFFERENT scope coexists — the action type is part of the keyspace', async () => {
    await prisma.idempotencyRecord.create({
      data: { principal: 'user:scoped@demo.test|project:p-1', key: 'scoped-key', scope: 'comment.add', responseBody: null },
    })
    await expect(
      prisma.idempotencyRecord.create({
        data: { principal: 'user:scoped@demo.test|project:p-1', key: 'scoped-key', scope: 'task.update', responseBody: null },
      }),
    ).resolves.toBeTruthy()
  })

  it('the principal column is NOT NULL with a default (migration 17); the raw table carries the composite index, not the global one', () => {
    // better-sqlite3 handle is defaultSafeIntegers(true) — PRAGMA ints are BigInts.
    const cols = sqlite.prepare('PRAGMA table_info(IdempotencyRecord)').all() as Array<{ name: string; notnull: bigint; dflt_value: string | null }>
    const principal = cols.find((c) => c.name === 'principal')
    expect(principal).toBeDefined()
    expect(Number(principal!.notnull)).toBe(1)
    expect(principal!.dflt_value).toBe(`''`)

    const indexes = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='IdempotencyRecord'").all() as Array<{ name: string }>
    ).map((i) => i.name)
    expect(indexes).toContain('IdempotencyRecord_principal_scope_key_key')
    expect(indexes).not.toContain('IdempotencyRecord_key_key') // the pre-#177 GLOBAL keyspace index is gone
  })
})
