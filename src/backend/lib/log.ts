// Structured logger + requestId propagation (issue #204, audit register OBS-2).
//
// WHAT THIS FILE IS — the ONE logging seam for backend code (routes, jobs,
// modules, lib). Three levels, one call shape:
//
//     log.error(scope, message, fields?)
//     log.warn (scope, message, fields?)
//     log.info (scope, message, fields?)
//
// `scope` keeps the historical bracket tag ('api/actions', 'jobs',
// 'daraja-callback', …) so greps keep working. `fields` is a flat record of
// extra structured values — an `error` field is the convention for the caught
// exception (Errors serialize to { name, message, stack }; BigInts to
// strings; circular references degrade to '[Circular]' — emitting a line
// must never throw).
//
// OUTPUT — one line per event, two formats (LOG_FORMAT=json|text):
//
//   json (production default): a single JSON object per console call —
//     {"ts":"…","level":"error","scope":"api/actions","msg":"…",
//      "requestId":"…","ip":"…","route":"api/actions","error":{…}}
//     ts/level/scope/msg are ALWAYS present (colliding field keys are
//     dropped, never overriding them); requestId/ip/route/method appear only
//     when a request context is active; `fields` spread after them.
//   text (dev/test default): the historical human line with the correlation
//     id appended — `[scope] message rid=<uuid>` — plus raw extra args
//     (Errors print their stack, exactly like the console calls this
//     replaces). Dev ergonomics are unchanged apart from the rid suffix.
//
// DEFAULT, stated honestly: json ONLY when NODE_ENV=production (containers
// ship one parseable line per event for `docker logs` / journald / any
// future aggregator — the OBS-2 ask); text everywhere else, because a human
// reads dev/test output and the repo's test suite asserts on console text.
// Override explicitly with LOG_FORMAT (see DEPLOYMENT.md §10).
//
// REQUEST CONTEXT — the same AsyncLocalStorage pattern as lib/audit.ts's
// withAuditContext (the correlation primitive this file extends): a sibling
// store so audit rows and log lines can share ONE id per request without
// either module owning the other. route-kit (and the non-route-kit routes:
// ussd, whatsapp, daraja webhook, ai/*, health) wrap every request in
// withRequestLogging, which
//   · mints a requestId (crypto.randomUUID) or honors an inbound
//     x-request-id header (validated: ≤128 printable ASCII chars — a
//     newline-bearing header must not forge log lines),
//   · echoes the id as the x-request-id RESPONSE header,
//   · runs the whole handler inside the context (auth, rate limit, body
//     parse, business code, catch — anything awaited under it logs with the
//     id), and
//   · emits one access log line on completion:
//       [http] <method> <path> <status> <durationMs>ms rid=<id>
//     (path only, never the query string — share tokens ride in ?query).
//
// NO PII beyond what the old console calls already printed: message text,
// the error's name/message/stack, and the request path. The client ip is
// logged only when TRUST_PROXY is set (the issue #156 honesty rule — an
// untrusted x-forwarded-for is a client-seeded lie, omitted rather than
// logged). Background work has no request: job drains mint their own
// drain-run id (`drain-<uuid>`) so their lines correlate too.
//
// DEPENDENCIES: node: builtins only (issue #204: no pino/winston —
// JSON.stringify to stdout suffices at this scale and keeps the tree flat).
// This module imports NOTHING from the repo, so every other module (audit
// included) can import it without cycles.

import { AsyncLocalStorage } from 'node:async_hooks'

// ---------------------------------------------------------------- context

/** Request-scoped fields threaded onto every log line under the context. */
export interface LogContext {
  /** Correlation id — the ONE id per request (logs + audit rows). */
  requestId?: string
  /** Client ip, only when TRUST_PROXY makes x-forwarded-for trustworthy. */
  ip?: string
  /** Route label, e.g. 'api/actions' (the route-kit scope). */
  route?: string
  /** HTTP method of the carrying request ('GET', 'POST', …). */
  method?: string
}

/**
 * The log context store — withAuditContext's pattern (lib/audit.ts), kept
 * as a SIBLING store: same AsyncLocalStorage mechanics, separate owner, so
 * extending logs never rewrites the audit primitive. Correct across
 * concurrent requests — no shared mutable module state.
 */
const logContextStorage = new AsyncLocalStorage<LogContext>()

/** Run `fn` with a log context — every log line inside it carries the fields. */
export function withLogContext<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> {
  return logContextStorage.run(ctx, fn)
}

/** The ambient log context (undefined outside a withLogContext run). */
export function getLogContext(): LogContext | undefined {
  return logContextStorage.getStore()
}

/**
 * The current request's id, when one is active. THE seam the five
 * historical per-route mint sites (actions, flags, projects, ussd,
 * whatsapp) now read instead of each rolling its own UUID — one mint per
 * request, audit rows and log lines consume the same one.
 */
export function currentRequestId(): string | undefined {
  return logContextStorage.getStore()?.requestId
}

// ---------------------------------------------------------------- format

export type LogFormat = 'json' | 'text'

/**
 * LOG_FORMAT=json|text, read PER EMIT (operators/tests retune without a
 * re-import). Unset/invalid → the NODE_ENV-aware default: json in
 * production (pipeline-parseable), text everywhere else (human-readable).
 */
export function resolveLogFormat(env: NodeJS.ProcessEnv = process.env): LogFormat {
  const raw = (env.LOG_FORMAT ?? '').trim().toLowerCase()
  if (raw === 'json' || raw === 'text') return raw
  return env.NODE_ENV === 'production' ? 'json' : 'text'
}

// ---------------------------------------------------------------- serialization

/** Extra structured values on a log line (`error` is the caught-exception convention). */
export type LogFields = Record<string, unknown>

/**
 * JSON.stringify that never throws: Errors → { name, message, stack },
 * BigInts → strings (this repo's cents are BigInts), circular references →
 * '[Circular]', undefined-root → 'null'. A log line must not take the
 * process down.
 *
 * Exported for the error sink (lib/errors/sink.ts, issue #202), which
 * serializes its POST body under the same never-throw discipline — one
 * implementation, two consumers, no cycle (this module imports nothing
 * from the repo).
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return (
    JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === 'bigint') return v.toString()
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    }) ?? 'null'
  )
}

/** Keys the logger owns — ts/level/scope/msg are the pinned always-present shape. */
const RESERVED_KEYS = new Set(['ts', 'level', 'scope', 'msg', 'requestId', 'ip', 'route', 'method'])

// ---------------------------------------------------------------- emit

function emit(level: 'error' | 'warn' | 'info', scope: string, msg: string, fields?: LogFields): void {
  // Level→stream mapping is the historical one: error→stderr (console.error),
  // warn→stderr (console.warn), info→stdout (console.info). Tests spy these
  // exact methods, so a migration must keep each site's level unchanged.
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  const ctx = logContextStorage.getStore()

  if (resolveLogFormat() === 'json') {
    const line: Record<string, unknown> = { ts: new Date().toISOString(), level, scope, msg }
    if (ctx?.requestId) line.requestId = ctx.requestId
    if (ctx?.ip) line.ip = ctx.ip
    if (ctx?.route) line.route = ctx.route
    if (ctx?.method) line.method = ctx.method
    // Caller fields land AFTER the standard keys and never override the
    // reserved shape (a buggy `scope` field is dropped, not fatal).
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === undefined) continue
      if (RESERVED_KEYS.has(k)) continue
      line[k] = v
    }
    write(safeStringify(line))
    return
  }

  // text — the historical line, plus the correlation id. Errors ride as raw
  // console args (stacks print exactly as before); other fields as key=json.
  let line = `[${scope}] ${msg}`
  if (ctx?.requestId) line += ` rid=${ctx.requestId}`
  const rest: unknown[] = []
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined) continue
    if (v instanceof Error) rest.push(v)
    else rest.push(`${k}=${safeStringify(v)}`)
  }
  write(line, ...rest)
}

/** The backend logging seam — see the file header for the contract. */
export const log = {
  error(scope: string, msg: string, fields?: LogFields): void {
    emit('error', scope, msg, fields)
  },
  warn(scope: string, msg: string, fields?: LogFields): void {
    emit('warn', scope, msg, fields)
  },
  info(scope: string, msg: string, fields?: LogFields): void {
    emit('info', scope, msg, fields)
  },
}

// ---------------------------------------------------------------- request ids

/** Max accepted inbound x-request-id length (bytes). Longer → mint a fresh id. */
const INBOUND_REQUEST_ID_MAX = 128

/**
 * Validate an inbound x-request-id: trimmed, 1..128 printable ASCII chars
 * (no control chars, no spaces). An id that could forge/break a log line or
 * header is refused — we mint our own instead. Never throws.
 */
export function sanitizeInboundRequestId(raw: string | null | undefined): string | null {
  const v = raw?.trim()
  if (!v || v.length > INBOUND_REQUEST_ID_MAX) return null
  return /^[\x21-\x7e]+$/.test(v) ? v : null
}

/** The id for THIS request: the validated inbound x-request-id, else a fresh UUID. */
export function requestIdFor(req: { headers: Headers }): string {
  return sanitizeInboundRequestId(req.headers.get('x-request-id')) ?? crypto.randomUUID()
}

/**
 * The client ip for LOG lines — the issue #156 honesty rule, inlined so this
 * module stays import-cycle-free: x-forwarded-for is client-seeded unless
 * TRUST_PROXY says every hop is a proxy we control; untrusted → omit the ip
 * entirely (never log the client's lie). When trusted, the RIGHTMOST value
 * is the proxy's view of the real client.
 */
function clientIpForLog(headers: Headers): string | undefined {
  const v = (process.env.TRUST_PROXY ?? '').trim().toLowerCase()
  if (!v || v === '0' || v === 'false') return undefined
  const values = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return values.length ? values[values.length - 1] : undefined
}

/** The request path for access lines — pathname only, NEVER the query string. */
function pathnameOf(req: Request): string {
  try {
    return new URL(req.url).pathname
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- request wrapper

/**
 * Wrap ONE API request with the log context (route-kit calls this for every
 * route()/publicRoute() handler; the non-route-kit routes — ussd, whatsapp,
 * the Daraja webhook, ai/*, health — call it directly):
 *
 *   1. mint/honor the requestId (validated inbound x-request-id),
 *   2. run the WHOLE handler inside withLogContext (anything awaited under
 *      it — auth, rate limit, business code, the catch — logs with the id),
 *   3. echo the id on the response as `x-request-id` (best effort: a
 *      response with immutable headers simply skips it), and
 *   4. emit the access line on completion — method, path, status,
 *      durationMs, requestId — level info, scope 'http'. A handler that
 *      THROWS gets its access line (status 500) and the rethrow: the error
 *      itself is logged by whichever catch owns it.
 *
 * No PII beyond the path (query strings are dropped — share tokens ride in
 * ?query; the ip only when TRUST_PROXY is set).
 */
export async function withRequestLogging<R extends Response>(
  req: Request,
  scope: string,
  handler: () => Promise<R>,
): Promise<R> {
  const startedAt = Date.now()
  const requestId = requestIdFor(req)
  const method = req.method
  const path = pathnameOf(req)
  const ip = clientIpForLog(req.headers)
  const ctx: LogContext = { requestId, route: scope, method, ...(ip ? { ip } : {}) }

  return withLogContext(ctx, async () => {
    let status = 500
    try {
      const res = await handler()
      status = res.status
      try {
        res.headers.set('x-request-id', requestId)
      } catch {
        // Immutable header guard (e.g. a passthrough fetch Response) — the
        // log lines still correlate; only the echo is skipped.
      }
      return res
    } finally {
      const durationMs = Date.now() - startedAt
      log.info('http', `${method} ${path} ${status} ${durationMs}ms`, { method, path, status, durationMs })
    }
  })
}

// ---------------------------------------------------------------- drain runs

/**
 * A drain-run id for background work with NO carrying request (issue #204's
 * no-id case): every log line under a runDueJobs drain — handler failures,
 * reconciliation warns — carries the same `drain-<uuid>` so one drain is
 * one greppable unit.
 */
export function mintDrainRunId(): string {
  return `drain-${crypto.randomUUID()}`
}
