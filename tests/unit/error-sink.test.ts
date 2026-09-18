// Opt-in, fail-open error sink — issue #202 (audit register OBS-1).
//
// WHAT IS PINNED HERE (the issue's acceptance criteria, one block each):
//   · Unconfigured (ERROR_SINK_URL unset — the DEFAULT) → no-op: fetch is
//     never called, and EXACTLY ONE warning ever fires (never per-call spam),
//     honestly labeling the journal-only posture.
//   · Configured happy path → one POST per capture with the pinned payload
//     shape (ts/service/environment?/scope/requestId?/route?/method?/error/
//     context?), bearer header only when ERROR_SINK_TOKEN is set.
//   · requestId propagation: the ambient #204 log-context id (and route/
//     method) ride along; an explicit context id WINS; no context → no key.
//   · Redaction (the safeErrorMessage discipline, extended to the wire):
//     internal errors (multi-line messages, P-codes, Prisma-class names)
//     ship a redacted message and NO stack — the raw text appears nowhere in
//     the serialized body; domain errors keep message + stack; caller fields
//     are redact-walked (embedded Errors, BigInts).
//   · Never-throws / fail-open: a rejecting, non-2xx, or SYNC-THROWING fetch
//     never takes the caller down; each failure warns ONCE with the error
//     class / HTTP status ONLY (no URL — fetch messages embed it); NO retry
//     storm (one POST attempt per capture, fetch calls == captures).
//   · Fire-and-forget: captureError returns while the POST is still pending.
//   · The 5s bound: AbortController + setTimeout — observable under fake
//     timers (no warn at 4999ms, timeout warn at 5000ms, timer cleared).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { captureError, resolveErrorSinkConfig, ERROR_SINK_TIMEOUT_MS } = await import('@/backend/lib/errors/sink')
const { withLogContext } = await import('@/backend/lib/log')

// ---------------------------------------------------------------- helpers

/** Let the detached POST chain (fetch → then/catch → finally) settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

/** A minimal 2xx/non-2xx Response stand-in whose body-read is spyable. */
function resOf(status: number): { res: Response; text: ReturnType<typeof vi.fn> } {
  const text = vi.fn(async () => '')
  return { res: { ok: status < 400, status, text } as unknown as Response, text }
}

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------- env resolution

describe('resolveErrorSinkConfig — the gate, read per call', () => {
  it('unset / blank / whitespace URL → null (the journal-only default posture)', () => {
    expect(resolveErrorSinkConfig({})).toBeNull()
    expect(resolveErrorSinkConfig({ ERROR_SINK_URL: '' })).toBeNull()
    expect(resolveErrorSinkConfig({ ERROR_SINK_URL: '   ' })).toBeNull()
  })

  it('set URL → config; token trimmed/omitted; ERROR_SINK_ENV wins over NODE_ENV, which is the fallback', () => {
    expect(resolveErrorSinkConfig({ ERROR_SINK_URL: ' https://sink.example/hook ' })).toEqual({
      url: 'https://sink.example/hook',
    }) // no token, no environment (neither ERROR_SINK_ENV nor NODE_ENV set)
    expect(resolveErrorSinkConfig({ ERROR_SINK_URL: 'u', ERROR_SINK_TOKEN: ' tok ', ERROR_SINK_ENV: 'prod-1' })).toEqual({
      url: 'u',
      token: 'tok',
      environment: 'prod-1',
    })
    expect(resolveErrorSinkConfig({ ERROR_SINK_URL: 'u', ERROR_SINK_ENV: 'prod-1', NODE_ENV: 'production' })).toMatchObject({
      environment: 'prod-1', // explicit tag wins
    })
    expect(resolveErrorSinkConfig({ ERROR_SINK_URL: 'u', NODE_ENV: 'production' })).toMatchObject({
      environment: 'production', // NODE_ENV fallback
    })
    expect(resolveErrorSinkConfig({ ERROR_SINK_URL: 'u', ERROR_SINK_TOKEN: '   ' })).not.toHaveProperty('token')
  })
})

// ---------------------------------------------------------------- unconfigured

describe('captureError — unconfigured: no-op with EXACTLY ONE warning ever', () => {
  it('fetch is never called; the first capture warns once, later captures are silent (never per-call spam)', async () => {
    vi.resetModules() // fresh module state: the once-per-process flag starts clear
    const { captureError: fresh } = await import('@/backend/lib/errors/sink')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    fresh(new Error('first'), { scope: 's' })
    fresh(new Error('second'), { scope: 's' })
    fresh(new Error('third'), { scope: 's' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1) // EXACTLY one warning ever
    const line = String(warn.mock.calls[0][0])
    expect(line).toContain('[errors/sink]')
    expect(line).toContain('ERROR_SINK_URL')
    expect(line).toContain('journal') // honestly labeled: journal-only
    expect(line).toContain('once per process')
  })
})

// ---------------------------------------------------------------- configured happy path

describe('captureError — configured: one POST per capture, pinned payload shape', () => {
  it('POST + JSON + bearer-when-set; payload keys and error shape pinned', async () => {
    const fetchMock = vi.fn(async () => resOf(204).res)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')
    vi.stubEnv('ERROR_SINK_TOKEN', 'tok-1')
    vi.stubEnv('ERROR_SINK_ENV', 'prod-1')

    captureError(new Error('Wallet not found'), { scope: 'api/wallets POST', fields: { walletId: 'w-1' } })
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://sink.example/hook')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1')

    const payload = JSON.parse(init.body as string) as Record<string, unknown>
    expect(payload.service).toBe('mjengo-os')
    expect(payload.environment).toBe('prod-1')
    expect(payload.scope).toBe('api/wallets POST')
    expect(Number.isNaN(Date.parse(String(payload.ts)))).toBe(false) // valid ISO ts
    expect(payload.error).toMatchObject({ class: 'Error', message: 'Wallet not found', internal: false })
    expect(typeof (payload.error as Record<string, unknown>).stack).toBe('string')
    expect(payload.context).toEqual({ walletId: 'w-1' })
  })

  it('no token → no Authorization header at all (internal relay posture)', async () => {
    const fetchMock = vi.fn(async () => resOf(200).res)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://relay.internal/hook')

    captureError(new Error('x'), { scope: 's' })
    await flush()

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('2xx → completely silent (no warn), and the response body is never read', async () => {
    const fetchMock = vi.fn(async () => resOf(200).res)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    captureError(new Error('x'), { scope: 's' })
    await flush()

    expect(warn).not.toHaveBeenCalled()
    expect(fetchMock.mock.results[0]?.value).toBeTruthy()
  })

  it('requestId/route/method ride along from the ambient #204 log context; an explicit id WINS; no context → no keys', async () => {
    const fetchMock = vi.fn(async () => resOf(204).res)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')

    await withLogContext({ requestId: 'rid-ambient', route: 'api/x', method: 'POST' }, async () => {
      captureError(new Error('a'), { scope: 's' })
    })
    await withLogContext({ requestId: 'rid-ambient' }, async () => {
      captureError(new Error('b'), { scope: 's', requestId: 'rid-explicit' })
    })
    captureError(new Error('c'), { scope: 's' }) // no ambient context, no explicit id
    await flush()

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>)
    expect(bodies[0]).toMatchObject({ requestId: 'rid-ambient', route: 'api/x', method: 'POST' })
    expect(bodies[1]).toMatchObject({ requestId: 'rid-explicit' }) // explicit wins
    expect(bodies[2]).not.toHaveProperty('requestId')
    expect(bodies[2]).not.toHaveProperty('route')
    expect(bodies[2]).not.toHaveProperty('method')
  })

  it('fields are redact-walked: BigInts → strings, embedded internal Errors → redacted shape (no stack, no raw text)', async () => {
    const fetchMock = vi.fn(async () => resOf(204).res)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')

    const inner = new Error('inner secret detail:\n  at /app/.next/server/chunk.js:1:1') // multi-line → internal
    captureError(new Error('domain'), {
      scope: 'jobs',
      fields: { jobId: 'j-1', cents: 123456789012345678n, nested: { err: inner } },
    })
    await flush()

    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>
    expect(payload.context).toEqual({
      jobId: 'j-1',
      cents: '123456789012345678',
      nested: { err: { class: 'Error', message: expect.stringContaining('redacted'), internal: true } },
    })
    expect(JSON.stringify(payload)).not.toContain('inner secret detail')
    expect(JSON.stringify(payload)).not.toContain('/app/')
  })

  it('pathological inputs are capped: message at 8k; a body over 256k drops the caller context first', async () => {
    const fetchMock = vi.fn(async () => resOf(204).res)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')

    captureError(new Error('x'.repeat(20_000)), { scope: 's', fields: { blob: 'y'.repeat(300_000) } })
    await flush()

    const payload = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>
    expect((payload.error as Record<string, unknown>).message).toBe('x'.repeat(8_192))
    expect(payload).not.toHaveProperty('context') // the oversize fallback dropped it
    expect(payload.error).toBeTruthy() // …but kept the bounded core shape
  })
})

// ---------------------------------------------------------------- redaction

describe('captureError — redaction: the safeErrorMessage rules, extended to the wire', () => {
  const captureWith = async (err: unknown): Promise<string> => {
    const fetchMock = vi.fn(async () => resOf(204).res)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')
    captureError(err, { scope: 's' })
    await flush()
    return (fetchMock.mock.calls[0][1] as RequestInit).body as string
  }

  it('a domain error (single-line) ships message + stack, internal: false', async () => {
    const body = await captureWith(new Error('Milestone not found'))
    const error = (JSON.parse(body) as Record<string, unknown>).error as Record<string, unknown>
    expect(error).toMatchObject({ class: 'Error', message: 'Milestone not found', internal: false })
    expect(typeof error.stack).toBe('string')
  })

  it('a multi-line message (the Prisma banner shape) → redacted message, NO stack, internal: true', async () => {
    const body = await captureWith(
      new Error('Error updating db\n  at Object.execute (/app/.next/server/chunks/123.js:1:1)'),
    )
    const error = (JSON.parse(body) as Record<string, unknown>).error as Record<string, unknown>
    expect(error.internal).toBe(true)
    expect(error.message).toContain('redacted')
    expect(error).not.toHaveProperty('stack')
    expect(body).not.toContain('/app/')
    expect(body).not.toContain('Error updating db')
  })

  it('a P-code error → redacted; the code and raw message appear nowhere in the body', async () => {
    const body = await captureWith(Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' }))
    const error = (JSON.parse(body) as Record<string, unknown>).error as Record<string, unknown>
    expect(error.internal).toBe(true)
    expect(body).not.toContain('Unique constraint')
    expect(body).not.toContain('P2002')
  })

  it('a Prisma-class constructor name → redacted (class name itself is diagnostic and ships)', async () => {
    class PrismaClientKnownRequestError extends Error {}
    const body = await captureWith(new PrismaClientKnownRequestError('constraint violation detail'))
    const error = (JSON.parse(body) as Record<string, unknown>).error as Record<string, unknown>
    expect(error.class).toBe('PrismaClientKnownRequestError')
    expect(error.internal).toBe(true)
    expect(body).not.toContain('constraint violation detail')
  })

  it('non-Error throwables degrade to their string form (never a crash, never {})', async () => {
    const body = await captureWith('just a string failure')
    expect((JSON.parse(body) as Record<string, unknown>).error).toMatchObject({
      class: 'string',
      message: 'just a string failure',
      internal: false,
    })
  })
})

// ---------------------------------------------------------------- fail-open / never-throws

describe('captureError — fail-open: the sink can never take the app down', () => {
  it('a rejecting fetch (network down) → no throw, ONE warn with the error class ONLY (no URL leak), no retry', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed to https://secret-sink.example/hook?token=abc')
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://secret-sink.example/hook?token=abc')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => captureError(new Error('a'), { scope: 's' })).not.toThrow()
    await flush()

    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0][0])
    expect(line).toContain('unreachable (TypeError)')
    expect(line).not.toContain('secret-sink') // the URL never reaches the warn
    expect(line).not.toContain('token=')
    expect(line).toContain('not retried')

    // NO retry storm: a second capture is ONE more attempt, one more warn —
    // fetch calls stay == captures (nothing re-POSTs on its own).
    expect(() => captureError(new Error('b'), { scope: 's' })).not.toThrow()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('a non-2xx answer → one warn with the HTTP status only; the body is never read', async () => {
    const { res, text } = resOf(500)
    const fetchMock = vi.fn(async () => res)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    captureError(new Error('a'), { scope: 's' })
    await flush()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('HTTP 500')
    expect(text).not.toHaveBeenCalled() // no echo, no memory, no leak
  })

  it('a SYNC-throwing fetch → still no throw, one warn (absolute fail-open)', async () => {
    vi.stubGlobal('fetch', (() => {
      throw new Error('sync boom')
    }) as unknown as typeof fetch)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => captureError(new Error('a'), { scope: 's' })).not.toThrow()
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('unreachable (Error)')
  })

  it('fire-and-forget: captureError has already returned while the POST is still pending', async () => {
    let resolveFetch!: (r: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    captureError(new Error('pending'), { scope: 's' }) // returns void, synchronously

    expect(fetchMock).toHaveBeenCalledTimes(1) // the POST started…
    expect(warn).not.toHaveBeenCalled() // …and nothing has settled yet

    resolveFetch(resOf(200).res)
    await flush()
    expect(warn).not.toHaveBeenCalled() // 2xx → silent success
  })

  it('the 5s bound (AbortController + setTimeout): no warn at 4999ms, timeout warn at 5000ms, timer cleared', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ERROR_SINK_URL', 'https://sink.example/hook')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    captureError(new Error('hung collector'), { scope: 's' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1) // the abort timer is armed

    await vi.advanceTimersByTimeAsync(ERROR_SINK_TIMEOUT_MS - 1)
    expect(warn).not.toHaveBeenCalled() // still inside the bound

    await vi.advanceTimersByTimeAsync(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('timed out after 5s')
    expect(vi.getTimerCount()).toBe(0) // clearTimeout ran — no dangling timer
  })
})
