/**
 * BE-8 (issue #77) — Prisma query logging is dev-only.
 *
 * db.ts used to construct PrismaClient with `log: ['query']`
 * unconditionally: every SQL statement (some carrying user data) landed in
 * stdout logs in PRODUCTION too — log volume, perf cost, and a data-hygiene
 * smell. Pinned here:
 *   · NODE_ENV=production → log levels are ['error', 'warn'] — failures stay
 *     visible, per-statement query logs are OFF;
 *   · NODE_ENV=development (and anything non-production, e.g. 'test') →
 *     'query' stays ON — the dev troubleshooting behavior is unchanged.
 *
 * PrismaClient is swapped for a capturing stub (the real client is never
 * constructed — no engine, no DATABASE_URL); the module is re-imported per
 * environment via vi.resetModules + dynamic import, with the globalThis
 * dev-cache dropped between imports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captured: Array<{ log?: unknown }> = []

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor(opts: { log?: unknown } = {}) {
      captured.push({ log: opts.log })
    }
  },
}))

type DbModule = typeof import('@/backend/lib/db')

/** Fresh import of lib/db (module registry reset; dev global cache dropped). */
async function importDb(): Promise<DbModule> {
  vi.resetModules()
  delete (globalThis as { prisma?: unknown }).prisma
  return import('@/backend/lib/db')
}

let prevNodeEnv: string | undefined

beforeEach(() => {
  captured.length = 0
  prevNodeEnv = process.env.NODE_ENV
})

afterEach(() => {
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = prevNodeEnv
  delete (globalThis as { prisma?: unknown }).prisma
})

describe('PrismaClient log levels (BE-8)', () => {
  it("NODE_ENV=production → ['error', 'warn'] — NO 'query' (per-statement SQL logs off)", async () => {
    process.env.NODE_ENV = 'production'
    const { db } = await importDb()
    expect(db).toBeDefined()
    expect(captured).toHaveLength(1)
    expect(captured[0].log).toEqual(['error', 'warn'])
  })

  it("NODE_ENV=development → 'query' stays on (dev behavior unchanged)", async () => {
    process.env.NODE_ENV = 'development'
    const { db } = await importDb()
    expect(db).toBeDefined()
    expect(captured).toHaveLength(1)
    expect(captured[0].log).toEqual(['query', 'error', 'warn'])
  })

  it("non-production 'test' env → 'query' stays on too (only production gates it)", async () => {
    process.env.NODE_ENV = 'test'
    const { db } = await importDb()
    expect(db).toBeDefined()
    expect(captured[0].log).toEqual(['query', 'error', 'warn'])
  })

  it('dev still caches the instance on globalThis (hot-reload behavior unchanged)', async () => {
    process.env.NODE_ENV = 'development'
    const { db } = await importDb()
    expect((globalThis as { prisma?: unknown }).prisma).toBe(db)
  })

  it('production does NOT plant the globalThis cache (unchanged)', async () => {
    process.env.NODE_ENV = 'production'
    await importDb()
    expect((globalThis as { prisma?: unknown }).prisma).toBeUndefined()
  })
})
