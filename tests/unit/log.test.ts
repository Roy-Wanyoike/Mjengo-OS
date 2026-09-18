// Structured logger + requestId propagation — issue #204 (audit OBS-2).
//
// WHAT IS PINNED HERE (the issue's acceptance criteria, one block each):
//   · JSON shape: one console call, one JSON object per line, ts/level/scope/
//     msg always; requestId/ip/route/method only when a context is active;
//     caller fields spread after; reserved keys never overridable.
//   · Text format: the historical `[scope] message` line (+ rid suffix in
//     context), Errors as raw args — dev/test ergonomics unchanged.
//   · Format toggle: LOG_FORMAT=json|text per emit; NODE_ENV-aware default
//     (json in production, text elsewhere).
//   · Id propagation ACROSS an awaited handler (AsyncLocalStorage survives
//     awaits/concurrent requests — the withAuditContext pattern).
//   · The no-id case: no context → no requestId key (never 'undefined').
//   · withRequestLogging: header echo, inbound-id honor, inbound-id
//     validation (log-forging refusal), access line on completion (method,
//     path, status, durationMs, requestId — query string NEVER logged), the
//     throwing-handler access line, TRUST_PROXY-gated ip.
//   · route-kit integration: a forced failure through publicRoute emits a
//     line whose requestId EQUALS the x-request-id response header (the
//     issue's exact scenario), on both the custom-500 and the default-400
//     error paths.
//   · Job drains: runDueJobs mints its own drain-run id and a failing
//     handler's line carries it (the background no-request case).
//   · Audit unification: logAudit with no explicit ctx consumes the ambient
//     log-context requestId — one id per request across rows AND lines.
//   · Never-throws serialization: BigInt fields, circular refs (the
//     'error-field redaction' robustness story — a log line must not crash).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// Top-level mocks (vi.mock is hoisted — factories must not close over test
// state, so the shared fns live in vi.hoisted and tests re-program them).
const dbMock = vi.hoisted(() => ({
  jobRecord: {
    findMany: vi.fn(async () => [] as unknown[]),
    update: vi.fn(async () => ({} as Record<string, unknown>)),
  },
  auditEvent: { create: vi.fn(async () => ({} as Record<string, unknown>)) },
}))
vi.mock('@/backend/lib/db', () => ({ db: dbMock }))

const handlersMock = vi.hoisted(() => ({
  JOB_TYPES: ['test.fail'] as string[],
  JOB_HANDLERS: {
    'test.fail': async (): Promise<unknown> => {
      throw new Error('handler exploded')
    },
  },
}))
vi.mock('@/backend/modules/jobs/handlers', () => handlersMock)

const {
  log,
  withLogContext,
  getLogContext,
  currentRequestId,
  resolveLogFormat,
  sanitizeInboundRequestId,
  withRequestLogging,
  mintDrainRunId,
} = await import('@/backend/lib/log')

// ---------------------------------------------------------------- helpers

function spyConsole() {
  const spies = {
    error: vi.spyOn(console, 'error').mockClear().mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockClear().mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockClear().mockImplementation(() => {}),
  }
  return spies
}

/** The single string arg the logger writes for a line (JSON or text head). */
function firstArg(spy: ReturnType<typeof spyConsole>['error']): string {
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy.mock.calls[0].length).toBeGreaterThanOrEqual(1)
  return String(spy.mock.calls[0][0])
}

/** Parse the JSON line the spy captured (json format only). */
function jsonLine(spy: ReturnType<typeof spyConsole>['error']): Record<string, unknown> {
  return JSON.parse(firstArg(spy)) as Record<string, unknown>
}

function req(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(url, init)
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------- shape

describe('log — JSON shape (LOG_FORMAT=json)', () => {
  beforeEach(() => vi.stubEnv('LOG_FORMAT', 'json'))
  afterEach(() => vi.unstubAllEnvs())

  it('one console call, one JSON object: ts/level/scope/msg always, fields spread after', () => {
    const c = spyConsole()
    log.error('api/test', 'something failed', { code: 17, note: 'x' })
    const line = jsonLine(c.error)
    expect(Object.keys(line).slice(0, 4)).toEqual(['ts', 'level', 'scope', 'msg'])
    expect(line.level).toBe('error')
    expect(line.scope).toBe('api/test')
    expect(line.msg).toBe('something failed')
    expect(line.code).toBe(17)
    expect(line.note).toBe('x')
    expect(Number.isNaN(Date.parse(String(line.ts)))).toBe(false) // valid ISO ts
  })

  it('levels map to the historical streams: error→console.error, warn→console.warn, info→console.info', () => {
    const c = spyConsole()
    log.error('s', 'e')
    log.warn('s', 'w')
    log.info('s', 'i')
    expect(c.error).toHaveBeenCalledTimes(1)
    expect(c.warn).toHaveBeenCalledTimes(1)
    expect(c.info).toHaveBeenCalledTimes(1)
    expect((JSON.parse(String(c.error.mock.calls[0][0])) as { level: string }).level).toBe('error')
    expect((JSON.parse(String(c.warn.mock.calls[0][0])) as { level: string }).level).toBe('warn')
    expect((JSON.parse(String(c.info.mock.calls[0][0])) as { level: string }).level).toBe('info')
  })

  it('no context → no requestId/ip/route/method keys at all (the no-id case)', () => {
    const c = spyConsole()
    log.warn('boot', 'no request here')
    const line = jsonLine(c.warn)
    expect(line).not.toHaveProperty('requestId')
    expect(line).not.toHaveProperty('ip')
    expect(line).not.toHaveProperty('route')
    expect(line).not.toHaveProperty('method')
  })

  it('reserved keys cannot be overridden by fields — ts/level/scope/msg stay the logger shape', () => {
    const c = spyConsole()
    log.info('real-scope', 'msg', { scope: 'fake', level: 'fake', ts: 'fake', msg: 'fake' })
    const line = jsonLine(c.info)
    expect(line.scope).toBe('real-scope')
    expect(line.level).toBe('info')
    expect(line.ts).not.toBe('fake')
    expect(line.msg).toBe('msg')
  })

  it('error fields serialize structurally: name/message/stack, never {} or [object Object]', () => {
    const c = spyConsole()
    const boom = new Error('kaboom')
    log.error('api/test', 'handler failed', { error: boom })
    const line = jsonLine(c.error)
    const err = line.error as Record<string, unknown>
    expect(err.name).toBe('Error')
    expect(err.message).toBe('kaboom')
    expect(typeof err.stack).toBe('string')
    expect(String(err.stack)).toContain('kaboom')
  })

  it('never throws: BigInt fields stringify, circular refs degrade to [Circular]', () => {
    const c = spyConsole()
    const circular: Record<string, unknown> = { self: null }
    circular.self = circular
    expect(() => log.error('s', 'odd payload', { cents: 123456789012345678n, circular })).not.toThrow()
    const line = jsonLine(c.error)
    expect(line.cents).toBe('123456789012345678')
    expect((line.circular as Record<string, unknown>).self).toBe('[Circular]')
  })
})

// ---------------------------------------------------------------- text format

describe('log — text format (LOG_FORMAT=text)', () => {
  beforeEach(() => vi.stubEnv('LOG_FORMAT', 'text'))
  afterEach(() => vi.unstubAllEnvs())

  it('the historical line: `[scope] message`, single first arg, Errors as raw args', () => {
    const c = spyConsole()
    const boom = new Error('kaboom')
    log.error('api/test', 'something failed', { error: boom })
    expect(firstArg(c.error)).toBe('[api/test] something failed')
    expect(c.error.mock.calls[0][1]).toBe(boom) // stack prints, exactly like before
  })

  it('in context the rid is appended to the first arg — every line greppable by id', async () => {
    const c = spyConsole()
    await withLogContext({ requestId: 'rid-123' }, async () => {
      log.warn('jobs', 'background warning')
    })
    expect(firstArg(c.warn)).toBe('[jobs] background warning rid=rid-123')
  })

  it('non-Error fields ride as key=json args', () => {
    const c = spyConsole()
    log.warn('storage', 'partial config', { missing: ['A', 'B'] })
    expect(firstArg(c.warn)).toBe('[storage] partial config')
    expect(c.warn.mock.calls[0][1]).toBe('missing=["A","B"]')
  })
})

// ---------------------------------------------------------------- format resolution

describe('resolveLogFormat — the toggle and its NODE_ENV-aware default', () => {
  it('explicit values win, case/whitespace-tolerant, read per call', () => {
    expect(resolveLogFormat({ LOG_FORMAT: 'json' })).toBe('json')
    expect(resolveLogFormat({ LOG_FORMAT: ' text ' })).toBe('text')
    expect(resolveLogFormat({ LOG_FORMAT: 'JSON' })).toBe('json')
  })

  it('unset/invalid → text outside production (dev/test ergonomics), json in production (pipelines)', () => {
    expect(resolveLogFormat({ NODE_ENV: 'development' })).toBe('text')
    expect(resolveLogFormat({ NODE_ENV: 'test' })).toBe('text')
    expect(resolveLogFormat({})).toBe('text')
    expect(resolveLogFormat({ NODE_ENV: 'production' })).toBe('json')
    expect(resolveLogFormat({ LOG_FORMAT: 'nonsense', NODE_ENV: 'production' })).toBe('json')
    expect(resolveLogFormat({ LOG_FORMAT: 'text', NODE_ENV: 'production' })).toBe('text')
  })

  it('the default is live at emit time (no re-import needed)', () => {
    const c = spyConsole()
    vi.stubEnv('LOG_FORMAT', '') // unset → NODE_ENV default
    vi.stubEnv('NODE_ENV', 'production')
    log.info('s', 'production default')
    expect(String(c.info.mock.calls[0][0])).toMatch(/^\{/) // json
    vi.stubEnv('NODE_ENV', 'test')
    log.info('s', 'test default')
    expect(String(c.info.mock.calls[1][0])).toBe('[s] test default') // text
  })
})

// ---------------------------------------------------------------- context propagation

describe('withLogContext — id propagation across awaits and concurrency', () => {
  beforeEach(() => vi.stubEnv('LOG_FORMAT', 'json'))
  afterEach(() => vi.unstubAllEnvs())

  it('the id survives an awaited handler (AsyncLocalStorage across async boundaries)', async () => {
    const c = spyConsole()
    await withLogContext({ requestId: 'rid-across-await', route: 'api/x', method: 'POST' }, async () => {
      await new Promise((r) => setTimeout(r, 5))
      log.error('deep', 'after an await')
    })
    const line = jsonLine(c.error)
    expect(line.requestId).toBe('rid-across-await')
    expect(line.route).toBe('api/x')
    expect(line.method).toBe('POST')
  })

  it('concurrent contexts stay isolated — no cross-request bleed', async () => {
    const c = spyConsole()
    await Promise.all([
      withLogContext({ requestId: 'rid-A' }, async () => {
        await new Promise((r) => setTimeout(r, 8))
        log.info('s', 'from A')
      }),
      withLogContext({ requestId: 'rid-B' }, async () => {
        await new Promise((r) => setTimeout(r, 2))
        log.info('s', 'from B')
      }),
    ])
    const lines = c.info.mock.calls.map((call) => JSON.parse(String(call[0])) as { msg: string; requestId: string })
    expect(lines.find((l) => l.msg === 'from A')?.requestId).toBe('rid-A')
    expect(lines.find((l) => l.msg === 'from B')?.requestId).toBe('rid-B')
  })

  it('getLogContext/currentRequestId read the ambient store; outside a run they are undefined', async () => {
    expect(getLogContext()).toBeUndefined()
    expect(currentRequestId()).toBeUndefined()
    await withLogContext({ requestId: 'rid-ambient' }, async () => {
      expect(currentRequestId()).toBe('rid-ambient')
      expect(getLogContext()?.route).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------- inbound ids

describe('sanitizeInboundRequestId — honoring x-request-id without log forging', () => {
  it('accepts sane ids, refuses junk (empty/oversized/control chars/newlines)', () => {
    expect(sanitizeInboundRequestId('  req-abc-123  ')).toBe('req-abc-123')
    expect(sanitizeInboundRequestId(null)).toBeNull()
    expect(sanitizeInboundRequestId('')).toBeNull()
    expect(sanitizeInboundRequestId('   ')).toBeNull()
    expect(sanitizeInboundRequestId('x'.repeat(129))).toBeNull()
    expect(sanitizeInboundRequestId('ok\nGET /admin HTTP/1.1')).toBeNull()
    expect(sanitizeInboundRequestId('tab\there')).toBeNull()
    expect(sanitizeInboundRequestId('space inside')).toBeNull()
    expect(sanitizeInboundRequestId('uuid-with-chars.~_ok')).toBe('uuid-with-chars.~_ok')
  })
})

// ---------------------------------------------------------------- request wrapper

describe('withRequestLogging — every request: id, header echo, access line', () => {
  beforeEach(() => vi.stubEnv('LOG_FORMAT', 'json'))
  afterEach(() => vi.unstubAllEnvs())

  it('happy path: header echo + access line (method, path, status, durationMs, requestId)', async () => {
    const c = spyConsole()
    const res = await withRequestLogging(req('http://localhost/api/widgets?token=SECRET'), 'api/widgets', async () =>
      NextResponse.json({ ok: true }),
    )
    expect(res.status).toBe(200)
    const rid = res.headers.get('x-request-id')
    expect(rid).toMatch(/^[0-9a-f-]{36}$/) // minted UUID
    expect(c.error).not.toHaveBeenCalled()
    const line = jsonLine(c.info)
    expect(line.scope).toBe('http')
    expect(line.requestId).toBe(rid)
    expect(line.method).toBe('GET')
    expect(line.path).toBe('/api/widgets') // query string NEVER logged (share tokens ride in ?query)
    expect(line.status).toBe(200)
    expect(typeof line.durationMs).toBe('number')
  })

  it('inbound x-request-id is honored and echoed (one id per request)', async () => {
    const c = spyConsole()
    const res = await withRequestLogging(
      req('http://localhost/api/widgets', { headers: { 'x-request-id': 'client-rid-42' } }),
      'api/widgets',
      async () => NextResponse.json({ ok: true }),
    )
    expect(res.headers.get('x-request-id')).toBe('client-rid-42')
    expect(jsonLine(c.info).requestId).toBe('client-rid-42')
  })

  it('an oversized inbound id is refused — a fresh UUID is minted', async () => {
    const c = spyConsole()
    const res = await withRequestLogging(
      req('http://localhost/api/widgets', { headers: { 'x-request-id': 'x'.repeat(200) } }),
      'api/widgets',
      async () => NextResponse.json({ ok: true }),
    )
    const rid = res.headers.get('x-request-id')
    expect(rid).toMatch(/^[0-9a-f-]{36}$/)
    expect(rid!.length).toBe(36)
  })

  it('code under the request logs with the SAME id the response echoes (across awaits)', async () => {
    const c = spyConsole()
    const res = await withRequestLogging(req('http://localhost/api/things', { method: 'POST' }), 'api/things', async () => {
      await new Promise((r) => setTimeout(r, 3))
      log.error('api/things', 'mid-handler failure', { error: new Error('x') })
      return NextResponse.json({ ok: true })
    })
    expect(jsonLine(c.error).requestId).toBe(res.headers.get('x-request-id'))
  })

  it('a throwing handler gets its 500 access line and the rethrow (the error belongs to the catcher)', async () => {
    const c = spyConsole()
    await expect(
      withRequestLogging(req('http://localhost/api/boom'), 'api/boom', async () => {
        throw new Error('unhandled')
      }),
    ).rejects.toThrow('unhandled')
    const line = jsonLine(c.info)
    expect(line.scope).toBe('http')
    expect(line.status).toBe(500)
    expect(line.path).toBe('/api/boom')
    expect(typeof line.requestId).toBe('string')
  })

  it('ip only when TRUST_PROXY is set (issue #156 honesty — no client-seeded XFF lies)', async () => {
    const viaEnv = async (trustProxy: string | undefined) => {
      const c = spyConsole()
      if (trustProxy === undefined) vi.stubEnv('TRUST_PROXY', '')
      else vi.stubEnv('TRUST_PROXY', trustProxy)
      await withRequestLogging(
        req('http://localhost/api/x', { headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' } }),
        'api/x',
        async () => NextResponse.json({ ok: true }),
      )
      return jsonLine(c.info)
    }
    expect(await viaEnv(undefined)).not.toHaveProperty('ip')
    const trusted = await viaEnv('1')
    expect(trusted.ip).toBe('198.51.100.7') // rightmost = the proxy's view
  })
})

// ---------------------------------------------------------------- route-kit integration

describe('route-kit integration — a forced failure emits the SAME id as the response header', () => {
  beforeEach(() => vi.stubEnv('LOG_FORMAT', 'json'))
  afterEach(() => vi.unstubAllEnvs())

  it('custom 500 path: error line, access line and x-request-id header share one id', async () => {
    const { publicRoute } = await import('@/backend/lib/route-kit')
    const c = spyConsole()
    const POST = publicRoute(
      {
        scope: 'test/forced-500',
        onError: (e) => {
          log.error('test/forced-500', 'handler failed', { error: e })
          return NextResponse.json({ error: 'forced failure' }, { status: 500 })
        },
      },
      async () => {
        throw new Error('the forced failure')
      },
    )
    const res = await POST(req('http://localhost/api/test', { method: 'POST' }), undefined as never)
    expect(res.status).toBe(500)
    const rid = res.headers.get('x-request-id')
    expect(rid).toMatch(/^[0-9a-f-]{36}$/)
    const errLine = c.error.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { scope: string; requestId?: string })
      .find((l) => l.scope === 'test/forced-500')
    expect(errLine?.requestId).toBe(rid)
    const accessLine = c.info.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { scope: string; status: number; requestId?: string })
      .find((l) => l.scope === 'http')
    expect(accessLine?.status).toBe(500)
    expect(accessLine?.requestId).toBe(rid)
  })

  it('default error path (no onError): route-kit logs the failure with the request id and answers 400', async () => {
    const { publicRoute } = await import('@/backend/lib/route-kit')
    const c = spyConsole()
    const POST = publicRoute({ scope: 'test/default-catch' }, async () => {
      throw new Error('domain failure')
    })
    const res = await POST(req('http://localhost/api/test', { method: 'POST' }), undefined as never)
    expect(res.status).toBe(400)
    const rid = res.headers.get('x-request-id')
    const errLine = c.error.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { scope: string; requestId?: string })
      .find((l) => l.scope === 'test/default-catch')
    expect(errLine?.requestId).toBe(rid)
    expect(errLine?.msg).toBe('Request failed')
  })
})

// ---------------------------------------------------------------- job drains

describe('runDueJobs — background drains mint their own drain-run id', () => {
  beforeEach(() => {
    vi.stubEnv('LOG_FORMAT', 'json')
    dbMock.jobRecord.findMany.mockReset()
    dbMock.jobRecord.update.mockReset()
    dbMock.jobRecord.findMany.mockResolvedValue([
      { id: 'j1', type: 'test.fail', projectId: null, payload: '{}', runAt: new Date(), status: 'queued' },
    ])
    dbMock.jobRecord.update.mockResolvedValue({
      id: 'j1', type: 'test.fail', projectId: null, result: null, lastError: null,
      finishedAt: null, attempts: 1, maxAttempts: 3,
    })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('a failing handler logs with a drain-run id (the no-request case)', async () => {
    const c = spyConsole()
    const { runDueJobs } = await import('@/backend/modules/jobs/service')
    const { ran, results } = await runDueJobs(5)
    expect(ran).toBe(1)
    expect(results[0]?.status).toBe('retrying')
    const line = c.error.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { scope: string; requestId?: string; msg: string })
      .find((l) => l.scope === 'jobs')
    expect(line?.msg).toContain('test.fail')
    expect(line?.requestId).toMatch(/^drain-[0-9a-f-]{36}$/)
  })

  it('mintDrainRunId shape', () => {
    expect(mintDrainRunId()).toMatch(/^drain-[0-9a-f-]{36}$/)
    expect(mintDrainRunId()).not.toBe(mintDrainRunId())
  })
})

// ---------------------------------------------------------------- audit unification

describe('logAudit — audit rows consume the same request id (one mint per request)', () => {
  beforeEach(() => {
    vi.stubEnv('LOG_FORMAT', 'json')
    dbMock.auditEvent.create.mockClear()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('no explicit ctx → the ambient log-context requestId lands on the AuditEvent row', async () => {
    const { logAudit } = await import('@/backend/lib/audit')
    await withLogContext({ requestId: 'rid-shared', route: 'api/v1/x' }, async () => {
      await logAudit('p1', 'task', { name: 'n', role: 'contractor' }, 'did a thing')
    })
    expect(dbMock.auditEvent.create).toHaveBeenCalledTimes(1)
    expect((dbMock.auditEvent.create.mock.calls[0][0] as { data: { requestId?: string } }).data.requestId).toBe('rid-shared')
  })

  it('an explicit ctx requestId still wins (callers can override)', async () => {
    const { logAudit } = await import('@/backend/lib/audit')
    await withLogContext({ requestId: 'rid-ambient' }, async () => {
      await logAudit('p1', 'task', { name: 'n', role: 'contractor' }, 'did a thing', undefined, { requestId: 'rid-explicit' })
    })
    expect((dbMock.auditEvent.create.mock.calls[0][0] as { data: { requestId?: string } }).data.requestId).toBe('rid-explicit')
  })
})
