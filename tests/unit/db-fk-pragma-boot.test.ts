/**
 * The BOOT WIRING of the FK pragma assert (issue #135 / audit DB-12) —
 * src/instrumentation.ts, the Next.js server-boot hook (register()).
 *
 * The guard itself is pinned in db-fk-pragma.test.ts; the real-engine
 * posture in db-fk-pragma-realdb.test.ts. This file pins the seam between
 * boot and guard:
 *
 *   · nodejs runtime: register() awaits ensureForeignKeys() before serving
 *     anything — the assert is genuinely part of server boot;
 *   · a pragma failure is a FATAL boot error: register() REJECTS, and Next
 *     rethrows that as "An error occurred while loading instrumentation
 *     hook: …" (verified against next@16.1's registerInstrumentation) — the
 *     server never comes up. Not a warning, not a health flag;
 *   · the edge runtime (src/proxy.ts context) never touches Prisma;
 *   · an UNSET NEXT_RUNTIME still runs the assert — only the one known
 *     Prisma-less runtime is exempt; the default is fail-closed.
 *
 * lib/db is mocked (the real singleton must never be queried here — no
 * DATABASE_URL, no engine: the TEST-3 hermetic posture).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/backend/lib/db', () => ({
  ensureForeignKeys: vi.fn(),
}))

import { ensureForeignKeys } from '@/backend/lib/db'
import { register } from '@/instrumentation'

const mockedEnsure = vi.mocked(ensureForeignKeys)

let prevRuntime: string | undefined

beforeEach(() => {
  prevRuntime = process.env.NEXT_RUNTIME
  mockedEnsure.mockReset()
})

afterEach(() => {
  if (prevRuntime === undefined) delete process.env.NEXT_RUNTIME
  else process.env.NEXT_RUNTIME = prevRuntime
})

describe('instrumentation register() — the FK assert at server boot (#135)', () => {
  it('nodejs runtime: awaits ensureForeignKeys() — the assert is wired into boot', async () => {
    process.env.NEXT_RUNTIME = 'nodejs'
    mockedEnsure.mockResolvedValue('enabled')
    await expect(register()).resolves.toBeUndefined()
    expect(mockedEnsure).toHaveBeenCalledTimes(1)
    expect(mockedEnsure).toHaveBeenCalledWith() // the app singleton + DATABASE_URL defaults
  })

  it('a pragma failure is a FATAL boot error — register() rejects, the server never comes up', async () => {
    process.env.NEXT_RUNTIME = 'nodejs'
    mockedEnsure.mockRejectedValue(
      new Error('PRAGMA foreign_keys is OFF (read-back: 0) — refusing to start'),
    )
    await expect(register()).rejects.toThrow(/foreign_keys is OFF/)
  })

  it('the edge runtime (the src/proxy.ts context) never touches Prisma — no assert call', async () => {
    process.env.NEXT_RUNTIME = 'edge'
    await expect(register()).resolves.toBeUndefined()
    expect(mockedEnsure).not.toHaveBeenCalled()
  })

  it('an UNSET NEXT_RUNTIME still runs the assert — fail-closed: only the known edge runtime is exempt', async () => {
    delete process.env.NEXT_RUNTIME
    mockedEnsure.mockResolvedValue('enabled')
    await expect(register()).resolves.toBeUndefined()
    expect(mockedEnsure).toHaveBeenCalledTimes(1)
  })
})
