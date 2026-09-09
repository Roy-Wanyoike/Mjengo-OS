/**
 * NEXTAUTH_SECRET boot guard (issue #74 / audit BE-2) —
 * src/backend/lib/next-auth-guard.ts + its wiring into the NextAuth route
 * (src/app/api/auth/[...nextauth]/route.ts).
 *
 * The guard mirrors the JOBS_RUN_TOKEN fail-closed posture (jobs-token.ts):
 * production must not serve auth on a missing or weak (< 32 chars) session
 * secret — next-auth v4 would throw per-request with a cryptic message, or
 * (worse) run on a weak value. The decision is a PURE function (verdict in,
 * verdict out), the enforcement runs ONCE per module instance at route
 * module load (a boot error, not a per-request one), and `next build`
 * (NEXT_PHASE=phase-production-build) is exempt because the documented CI
 * invariant is "the build must never need real secrets" (dummy value).
 *
 * Pinned here:
 *   · verdict: production + missing / too-short / sufficient; dev never blocks;
 *   · route module import: production + no secret → REJECTS with the clear
 *     message after ONE console.error; production + real secret → imports
 *     cleanly; build phase → exempt; dev → warns once, still imports;
 *   · one-time semantics: a second enforce() call in the same module
 *     instance is a silent no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route module pulls auth.ts → '@/backend/lib/db' (PrismaClient) — swap
// for an empty stub; the guard's decision never touches the database
// (same mocking idiom as tests/unit/v1-wallets.test.ts).
vi.mock('@/backend/lib/db', () => ({ db: {} }))

const realEnv = { ...process.env }

beforeEach(() => {
  vi.resetModules() // fresh module instances → fresh one-time guard state
  process.env = { ...realEnv }
})

afterEach(() => {
  process.env = realEnv
  vi.restoreAllMocks()
})

const importGuard = () => import('@/backend/lib/next-auth-guard')
const importRoute = () => import('@/app/api/auth/[...nextauth]/route')

const GOOD_SECRET = 'x'.repeat(64) // hex-32 length; any ≥ 32 chars passes
const SHORT_SECRET = 'too-short-secret' // 16 chars

describe('nextAuthSecretVerdict — the pure decision (jobs-token style)', () => {
  it('production + missing secret → fail closed (problem: "missing")', async () => {
    const { nextAuthSecretVerdict } = await importGuard()
    const verdict = nextAuthSecretVerdict(undefined, 'production')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.problem).toBe('missing')
      // the error is actionable: names the env var + the generation command
      expect(verdict.message).toMatch(/NEXTAUTH_SECRET/)
      expect(verdict.message).toMatch(/openssl rand/)
    }
  })

  it('production + empty-string secret → missing, not "set" (no default token)', async () => {
    const { nextAuthSecretVerdict } = await importGuard()
    expect(nextAuthSecretVerdict('', 'production').ok).toBe(false)
  })

  it(`production + secret shorter than 32 chars → fail closed (problem: "too-short")`, async () => {
    const { nextAuthSecretVerdict } = await importGuard()
    const verdict = nextAuthSecretVerdict(SHORT_SECRET, 'production')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.problem).toBe('too-short')
    // the boundary itself: 31 fails, 32 passes
    expect(nextAuthSecretVerdict('y'.repeat(31), 'production').ok).toBe(false)
    expect(nextAuthSecretVerdict('y'.repeat(32), 'production').ok).toBe(true)
  })

  it('production + sufficient secret → ok', async () => {
    const { nextAuthSecretVerdict } = await importGuard()
    expect(nextAuthSecretVerdict(GOOD_SECRET, 'production').ok).toBe(true)
  })

  it('dev / test never blocks — the warning path keeps local dev usable', async () => {
    const { nextAuthSecretVerdict } = await importGuard()
    for (const mode of ['development', 'test', undefined]) {
      expect(nextAuthSecretVerdict(undefined, mode).ok).toBe(true)
      expect(nextAuthSecretVerdict(SHORT_SECRET, mode).ok).toBe(true)
    }
  })
})

describe('route module import — the boot enforcement (fail closed in production)', () => {
  it('production + missing secret: importing the route module THROWS the clear boot error (one console.error)', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.NEXTAUTH_SECRET
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(importRoute()).rejects.toThrow(/NEXTAUTH_SECRET.*openssl rand/s)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/fail closed/)
  })

  it('production + too-short secret: same fail-closed boot error (weak secrets are refused too)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.NEXTAUTH_SECRET = SHORT_SECRET
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(importRoute()).rejects.toThrow(/NEXTAUTH_SECRET/)
  })

  it('production + real secret: the route module imports cleanly, nothing logged', async () => {
    process.env.NODE_ENV = 'production'
    process.env.NEXTAUTH_SECRET = GOOD_SECRET
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await importRoute()
    expect(mod.GET).toBeTypeOf('function')
    expect(mod.POST).toBeTypeOf('function')
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('next build (NEXT_PHASE=phase-production-build) is exempt: the dummy CI secret must not break the build', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.NEXTAUTH_SECRET
    process.env.NEXT_PHASE = 'phase-production-build'
    const mod = await importRoute() // must NOT throw
    expect(mod.GET).toBeTypeOf('function')
  })

  it('dev + missing secret: warns ONCE and the module still loads (dev stays usable)', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.NEXTAUTH_SECRET
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await importRoute()
    expect(mod.GET).toBeTypeOf('function')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/NEXTAUTH_SECRET/)
  })

  it('repeat enforce() calls are silent no-ops (a boot error, never per-request)', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.NEXTAUTH_SECRET
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { enforceNextAuthSecretAtBoot } = await importGuard()
    enforceNextAuthSecretAtBoot()
    enforceNextAuthSecretAtBoot()
    enforceNextAuthSecretAtBoot()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
