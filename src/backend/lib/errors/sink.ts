// Opt-in, fail-open error sink — issue #202 (audit register OBS-1).
//
// WHAT THIS FILE IS — the ONE error-capture seam, built ON the #204
// structured-log substrate (lib/log.ts): `captureError(err, context)` takes
// the SAME exceptions the log.error lines already carry and, when — and only
// when — the deployment opts in, offers them to an external collector as one
// structured JSON POST. v1 is provider-agnostic by design: a plain webhook
// (node fetch, ZERO new dependencies — the NOTIFY_SMS_WEBHOOK_URL pattern);
// a Sentry-class adapter can sit behind this same seam later.
//
// THE CONTRACT (every clause fail-open, none negotiable):
//   · NEVER throws — not on a bad payload, a throwing getter, a sync-throwing
//     fetch, nothing. The whole body runs inside a try/catch whose catch is
//     empty: capturing an error must never become one.
//   · NEVER blocks the response path — fire-and-forget. captureError is
//     SYNCHRONOUS and returns void the moment the payload is built; the POST
//     is detached (callers cannot accidentally await it). One AbortController
//     bounds it at 5s so a hung collector cannot pile up sockets.
//   · NEVER sends secrets — the safeErrorMessage discipline (guard.ts)
//     extended to the wire: isInternalError errors (Prisma/framework
//     internals, multi-line messages) ship a redacted message and NO stack
//     (stacks leak absolute build paths); caller `fields` are walked with the
//     same rule (embedded Errors redacted, BigInts stringified, cycles
//     degraded). The sink never sees MORE than the journal; on internal
//     errors it sees strictly LESS (the journal keeps the full detail).
//   · Unconfigured (ERROR_SINK_URL unset — the DEFAULT) → no-op with ONE
//     warning per process, honestly labeled: journal-only, exactly the
//     behavior of every prior release. Never per-call spam.
//   · Failed POSTs (non-2xx, timeout, network) → swallowed after ONE log.warn
//     each — error class or HTTP status ONLY, never the message (fetch
//     failures embed the URL, which may itself be a capability). NO retries,
//     NO retry storm: each captured error attempts exactly one POST, and the
//     journal line that accompanies every capture stays the durable record.
//
// ENV (read per call, never cached — the getSmsProvider discipline):
//   ERROR_SINK_URL    the gate. Unset/blank → the no-op above. Secret-class:
//                     anyone holding it can POST events into your collector
//                     (and Slack-style hook URLs embed tokens in the path).
//   ERROR_SINK_TOKEN  optional bearer token (Authorization header). Secret.
//   ERROR_SINK_ENV    optional non-secret deployment tag ('prod-1', …) so one
//                     collector can serve several deployments; falls back to
//                     NODE_ENV when unset, absent when neither is set.
//
// PAYLOAD (one JSON object, pinned in tests/unit/error-sink.test.ts):
//   { "ts": ISO, "service": "mjengo-os", "environment"?: tag,
//     "scope": 'api/actions POST' | 'jobs' | …,
//     "requestId"?: rid,        // explicit ctx id ?? the ambient #204 log id
//     "route"?: 'api/actions', "method"?: 'POST',   // ambient when present
//     "error": { "class", "message", "stack"?, "internal" },
//     "context"?: caller fields (jobType, jobId, … — identifiers, redacted) }
// The client ip is deliberately NOT sent: the journal keeps it (TRUST_PROXY
// rules), but an external sink is a third party — PII minimization wins.
//
// WIRING (v1 — the sites the issue names): the route-kit default error path,
// the jobs drain failure path (alongside lastError), and the three webhook
// route catch blocks (ussd, whatsapp, daraja). The remaining log.error
// families (v1's custom mapServiceError mappers, events service) migrate
// mechanically later — the signature stays this small on purpose.

import { isInternalError } from '../error-redaction'
import { currentRequestId, getLogContext, log, safeStringify } from '../log'

/** Hard cap on one sink POST — 5s, then the attempt is abandoned (fail-open). */
export const ERROR_SINK_TIMEOUT_MS = 5_000

/** What the payload says when an internal error's message must not ship. */
const INTERNAL_ERROR_MESSAGE =
  'Internal error — message redacted; the full detail is in the server journal (log.error line for this scope)'

/** Bounds on pathological inputs — the journal prints them whole, the wire caps them. */
const MESSAGE_MAX_CHARS = 8_192
const STACK_MAX_CHARS = 65_536
const BODY_MAX_CHARS = 262_144

/** The capture-site context — kept tiny so console.error sites migrate mechanically. */
export interface ErrorSinkContext {
  /** Log-scope tag, e.g. 'api/actions POST' or 'jobs' (the log.error scope of the site). */
  scope: string
  /** Explicit correlation id — defaults to the ambient #204 log-context id. */
  requestId?: string
  /**
   * Extra structured context (jobType, jobId, attempts, …). IDENTIFIERS, not
   * free text: values are redact-walked (embedded Errors follow the
   * safeErrorMessage rules) but strings pass through like domain messages do.
   */
  fields?: Record<string, unknown>
}

/** The one JSON object one sink POST carries (see the file header for the shape). */
export interface ErrorSinkPayload {
  ts: string
  service: string
  environment?: string
  scope: string
  requestId?: string
  route?: string
  method?: string
  error: { class: string; message: string; stack?: string; internal: boolean }
  context?: Record<string, unknown>
}

/** The resolved env — `url` is the gate; token/environment ride along when set. */
export interface ErrorSinkConfig {
  url: string
  token?: string
  environment?: string
}

/**
 * ERROR_SINK_URL (+ optional _TOKEN/_ENV), read PER CALL so operators and
 * tests retune without a re-import. Unset/blank URL → null = the honest
 * no-op posture (journal-only). No format validation: a malformed URL fails
 * at fetch time, once per capture, through the same fail-open warn path.
 */
export function resolveErrorSinkConfig(env: NodeJS.ProcessEnv = process.env): ErrorSinkConfig | null {
  const url = (env.ERROR_SINK_URL ?? '').trim()
  if (!url) return null
  const token = (env.ERROR_SINK_TOKEN ?? '').trim()
  const tag = (env.ERROR_SINK_ENV ?? '').trim() || (env.NODE_ENV ?? '').trim()
  return { url, ...(token ? { token } : {}), ...(tag ? { environment: tag } : {}) }
}

/**
 * The never-send-secrets error shape — safeErrorMessage's rule extended to
 * the wire: internal errors (Prisma/framework class names, P-codes, the
 * "invocation in" banner, multi-line messages) ship a redacted message and
 * NO stack (stacks carry absolute build paths); domain errors ship message +
 * stack, both capped. Non-Error throwables degrade to their string form.
 */
function errorShape(err: unknown): ErrorSinkPayload['error'] {
  if (err instanceof Error) {
    const internal = isInternalError(err)
    const stack = !internal && typeof err.stack === 'string' ? err.stack.slice(0, STACK_MAX_CHARS) : undefined
    return {
      class: err.constructor?.name ?? err.name ?? 'Error',
      message: (internal ? INTERNAL_ERROR_MESSAGE : err.message).slice(0, MESSAGE_MAX_CHARS),
      ...(stack ? { stack } : {}),
      internal,
    }
  }
  return { class: err === null ? 'null' : typeof err, message: String(err).slice(0, MESSAGE_MAX_CHARS), internal: false }
}

/**
 * Redact-walk caller `fields` for the wire: Errors → the redacted shape
 * above, BigInts → strings, cycles → '[Circular]', past depth 8 →
 * '[Truncated]'. Mirrors safeStringify's never-throw replacer, plus the
 * internal-error redaction the sink owes a third party.
 */
function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value instanceof Error) return errorShape(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return typeof value === 'function' ? '[Function]' : '[Symbol]'
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (depth > 8) return '[Truncated]'
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactValue(v, seen, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    out[k] = redactValue(v, seen, depth + 1)
  }
  return out
}

/** One warning per process that the sink is unconfigured — never per-call spam. */
let warnedUnconfigured = false

/**
 * Capture one error for the sink. NEVER throws, NEVER blocks: returns void
 * after building the payload; the POST is detached with a 5s abort bound.
 * Unconfigured → the one-time honest no-op warning (journal-only posture).
 */
export function captureError(err: unknown, context: ErrorSinkContext): void {
  try {
    const config = resolveErrorSinkConfig()
    if (!config) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true
        log.warn(
          'errors/sink',
          'ERROR_SINK_URL is not set — the error sink is INACTIVE; captured errors go to the server journal only (the default posture of every prior release). Set ERROR_SINK_URL to enable external capture (.env.example / DEPLOYMENT.md §3). This warning fires once per process.',
        )
      }
      return
    }
    postToSink(config, buildPayload(err, context, config))
  } catch {
    // Absolute fail-open: nothing in the capture path may ever take the
    // caller down — this catch is deliberately silent (the accompanying
    // log.error line at the capture site is already the durable record).
  }
}

/** Assemble the wire payload — pure, never throws (safeStringify guarantees). */
function buildPayload(err: unknown, context: ErrorSinkContext, config: ErrorSinkConfig): string {
  const ambient = getLogContext()
  const requestId = context.requestId ?? currentRequestId()
  const payload: ErrorSinkPayload = {
    ts: new Date().toISOString(),
    service: 'mjengo-os',
    ...(config.environment ? { environment: config.environment } : {}),
    scope: context.scope,
    ...(requestId ? { requestId } : {}),
    ...(ambient?.route ? { route: ambient.route } : {}),
    ...(ambient?.method ? { method: ambient.method } : {}),
    error: errorShape(err),
    ...(context.fields ? { context: redactValue(context.fields, new WeakSet(), 0) as Record<string, unknown> } : {}),
  }
  let body = safeStringify(payload)
  if (body.length > BODY_MAX_CHARS) {
    // Drop the caller context first — the core shape is bounded by the caps
    // above, so the fallback body always fits the wire budget.
    const { context: _dropped, ...core } = payload
    body = safeStringify(core)
  }
  return body
}

/**
 * The detached POST. AbortController + setTimeout (not AbortSignal.timeout)
 * so the bound stays observable under fake timers in tests. One warn per
 * failure — error class / HTTP status ONLY, never the message (fetch
 * failures embed the URL, which may itself be a bearer capability).
 */
function postToSink(config: ErrorSinkConfig, body: string): void {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ERROR_SINK_TIMEOUT_MS)
  const warn = (reason: string): void => {
    log.warn('errors/sink', `error sink POST failed — ${reason} (not retried; the journal line for this error is the durable record)`)
  }

  let pending: Promise<Response>
  try {
    pending = fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    warn(`unreachable (${err instanceof Error ? err.name : 'unknown'})`)
    return
  }

  void pending
    .then((res) => {
      // The response body is never read — no echo, no memory, no leak.
      if (!res.ok) warn(`HTTP ${res.status}`)
    })
    .catch((err: unknown) => {
      const name = err instanceof Error ? err.name : 'unknown'
      // controller.abort() rejects with AbortError; AbortSignal.timeout with
      // TimeoutError — both mean the 5s bound fired.
      warn(name === 'AbortError' || name === 'TimeoutError' ? `timed out after ${ERROR_SINK_TIMEOUT_MS / 1000}s` : `unreachable (${name})`)
    })
    .finally(() => clearTimeout(timer))
}
