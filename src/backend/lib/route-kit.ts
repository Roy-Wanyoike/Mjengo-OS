// Shared route middleware (W-BACKEND task 2-a, "route-kit").
//
// One composable wrapper that folds the boilerplate every standard JSON route
// in this app repeats, in the SAME order the routes already used it:
//
//   1. mutation Origin allowlist (optional, env-gated — see MUTATION_ORIGIN_ALLOWLIST)
//   2. auth guard     → 401 'Sign in required' / 403 'Not permitted for role "x"'
//      (delegated to withGuard — guard.ts stays the single source of 401/403)
//   3. rate limit     → 429 'Too many requests' + Retry-After
//      (delegated to enforceRateLimit — rate-limit.ts stays the single bucket)
//   4. request body   → optional raw-size cap BEFORE any parse/decode (audit
//      #4), one JSON parse, optional zod strictObject validation
//   5. try/catch      → console.error + the route's error mapper (default:
//      safeErrorMessage redaction) → JSON response
//
// BEHAVIOR CONTRACT: migrating a route to route() must not change any status
// code or body shape. The body-parse and error-mapping modes below exist
// precisely so each route family can keep its exact historical behavior:
//   · 'throw'    — the legacy `const body = await req.json()` inside the
//                  handler's try: a SyntaxError flows into onError and gets
//                  that route's status/body (actions 400, sync 500, …).
//   · 'reject'   — the strict v1/upload contract: unparseable JSON → 400
//                  'Invalid JSON body'; non-object → 400 'Body must be a JSON
//                  object' (an empty body counts as unparseable).
//   · 'tolerate' — jobs/run's contract: any parse failure resolves to {}.
//   · schema     — v1's validateBody contract: empty raw → {}, then strict
//                  zod validation with the { error, field } rendering
//                  (unrecognized keys listed by name).
//
// WHAT IS DELIBERATELY NOT HERE: next-auth routes (own CSRF machinery),
// /api/health (public probe), /api/ussd (text/plain aggregator contract — has
// its own targeted hardening), and the five /api/ai/* routes (they already
// share one composable gate, enforceAiRoutePolicy in rate-limit.ts, whose
// error copy is a public contract route-kit would silently rewrite).

import { NextRequest, NextResponse } from 'next/server'
import type { z, ZodIssue, ZodType } from 'zod'
import { getSessionFromReq, safeErrorMessage, withGuard, type GuardSession } from './guard'
import { enforceRateLimit } from './rate-limit'

// ---------------------------------------------------------------- handlers

export type GuardedHandler<C, B> = (
  req: NextRequest,
  session: NonNullable<GuardSession>,
  body: B,
  ctx: C,
) => Promise<NextResponse> | NextResponse

export type PublicHandler<C, B> = (
  req: NextRequest,
  session: GuardSession,
  body: B,
  ctx: C,
) => Promise<NextResponse> | NextResponse

/** What a route file re-exports as GET/POST/… — same shape withGuard returns. */
export type NextRouteHandler<C = unknown> = (req: NextRequest, ctx: C) => Promise<NextResponse>

// ---------------------------------------------------------------- options

export interface BodyOptions<S extends ZodType | undefined> {
  /**
   * Cap the RAW request body (bytes) BEFORE parsing or base64-decoding it
   * (audit #4). Honors Content-Length when present and re-checks the actual
   * byte length after reading — a lying client still cannot push a huge
   * payload into JSON.parse. Exceeding the cap → 413.
   */
  maxBytes?: number
  /**
   * zod (strictObject) schema: after the JSON parse the body is validated and
   * the handler receives the parsed value. Implies the v1 parse contract
   * ('reject' + empty-body-becomes-{}). See the file header.
   */
  schema?: S
  /**
   * 'throw' (default without schema): legacy behavior — parse errors surface
   * through the route's error mapper.
   * 'reject': 400 'Invalid JSON body' / 'Body must be a JSON object' (the
   * upload + notifications-PUT + v1 contract; schema mode implies this).
   */
  onParseError?: 'throw' | 'reject'
  /** Parse failures (and empty bodies) resolve to {} instead of failing. */
  tolerateInvalid?: boolean
}

export interface RouteOptions<S extends ZodType | undefined> {
  /** Log tag used by the built-in error path, e.g. 'api/flags POST'. */
  scope: string
  /** Role allowlist — omit for "any signed-in role". Unknown roles fail closed (guard.ts). */
  roles?: readonly string[]
  /** Per-principal token bucket: bucket key, burst/sustained limit, window (default 60s). */
  rateLimit?: { bucket: string; limit: number; windowMs?: number }
  /** Request-body pipeline — omit when the handler reads the body itself. */
  body?: BodyOptions<S>
  /**
   * Error path for exceptions thrown by the parse step or the handler.
   * Built-in mappers: safeError() / genericError(). A custom onError (the v1
   * routes use mapServiceError) OWNS ITS OWN LOGGING — route-kit stays silent
   * so v1's "Error bodies are not logged, 500s are" behavior is preserved.
   */
  onError?: (e: unknown, scope: string) => NextResponse
}

// ---------------------------------------------------------------- error mappers

export type RouteErrorMapper = (e: unknown, scope: string) => NextResponse

/**
 * `{ error: safeErrorMessage(e, fallback) }` — domain messages pass through,
 * Prisma/framework internals are redacted (guard.ts). This is the S-SEC
 * default the action/share/jobs/projects family already used.
 */
export function safeError(status: number, fallback: string, opts?: { okFalse?: boolean }): RouteErrorMapper {
  return (e) =>
    NextResponse.json(
      opts?.okFalse ? { ok: false, error: safeErrorMessage(e, fallback) } : { error: safeErrorMessage(e, fallback) },
      { status },
    )
}

/** Always `{ error: message }` — for routes whose catch never leaked e (sync, flags, audit…). */
export function genericError(status: number, message: string, opts?: { okFalse?: boolean }): RouteErrorMapper {
  return () => NextResponse.json(opts?.okFalse ? { ok: false, error: message } : { error: message }, { status })
}

// ---------------------------------------------------------------- origin allowlist

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

/**
 * MUTATION_ORIGIN_ALLOWLIST (comma-separated Origins), when set: browsers may
 * only mutate (POST/PUT/DELETE/PATCH) from an allowlisted Origin — a classic
 * CSRF hardening gate. Requests WITHOUT an Origin header (curl, the USSD
 * aggregator, health probes — not CSRF vectors, they cannot carry credentials
 * cross-site) are allowed. UNSET = permissive: the sandbox preview embeds the
 * app in a cross-site iframe, so Origin checks must stay off by default or
 * the preview breaks. Read per request so the env can change without a redeploy.
 */
function mutationOriginDenied(req: NextRequest): NextResponse | null {
  const raw = process.env.MUTATION_ORIGIN_ALLOWLIST
  if (!raw || !MUTATING_METHODS.has(req.method)) return null
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (allowed.length === 0) return null
  const origin = req.headers.get('origin')
  if (!origin) return null // non-browser caller — not a CSRF vector
  if (allowed.includes(origin)) return null
  return NextResponse.json(
    { error: `Origin "${origin}" is not allowed to mutate this API` },
    { status: 403 },
  )
}

// ---------------------------------------------------------------- body pipeline

/** Render one honest zod issue as a 400 { error, field? } response (v1 contract). */
export function zodIssueResponse(issues: ZodIssue[]): NextResponse {
  const issue = issues[0]
  const field = issue.path.length ? String(issue.path.join('.')) : undefined
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.map((k) => `"${String(k)}"`).join(', ')
    return NextResponse.json({ error: `Unknown field(s): ${keys}` }, { status: 400 })
  }
  return NextResponse.json({ error: issue.message, ...(field ? { field } : {}) }, { status: 400 })
}

const bodyTooLarge = (maxBytes: number): NextResponse =>
  NextResponse.json(
    { error: `Request body too large — this endpoint accepts at most ${Math.round(maxBytes / 1024 / 1024)} MB` },
    { status: 413 },
  )

/**
 * Read + validate the request body once. Returns the parsed body, a response
 * the caller must return, or — for 'throw' mode — the parse error to rethrow
 * into the route's error mapper (the legacy in-handler `await req.json()`).
 */
type BodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse }
  | { ok: false; rethrow: unknown }

async function readBody(req: NextRequest, opts: BodyOptions<ZodType | undefined>): Promise<BodyResult> {
  // Raw-size cap FIRST — before JSON.parse and before anything base64-decodes
  // (audit #4: oversized bodies used to be fully parsed before rejection).
  const maxBytes = opts.maxBytes
  if (maxBytes !== undefined) {
    const declared = Number(req.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: bodyTooLarge(maxBytes) }
  }

  let raw: string
  try {
    raw = await req.text()
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Could not read the request body' }, { status: 400 }) }
  }
  if (maxBytes !== undefined && Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return { ok: false, response: bodyTooLarge(maxBytes) }
  }

  const schemaMode = opts.schema !== undefined
  const reject = opts.tolerateInvalid ? false : schemaMode || opts.onParseError === 'reject'

  let body: unknown
  if (schemaMode && !raw.trim()) {
    body = {} // v1 validateBody contract: an empty body is an empty object
  } else {
    try {
      body = JSON.parse(raw)
    } catch (e) {
      if (opts.tolerateInvalid) return { ok: true, body: {} }
      if (!reject) return { ok: false, rethrow: e } // 'throw' mode → the route's onError
      return { ok: false, response: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    }
  }

  if (reject && (body === null || typeof body !== 'object' || Array.isArray(body))) {
    return { ok: false, response: NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 }) }
  }

  if (opts.schema) {
    const result = opts.schema.safeParse(body)
    if (!result.success) return { ok: false, response: zodIssueResponse(result.error.issues) }
    return { ok: true, body: result.data }
  }
  return { ok: true, body }
}

// ---------------------------------------------------------------- wrappers

/** The body a handler receives: zod-validated output when a schema is given, the loose JSON value otherwise. */
export type BodyOf<S extends ZodType | undefined> = S extends ZodType ? z.output<S> : unknown

/**
 * Everything after auth: origin gate → rate limit → body → handler → catch.
 * Shared verbatim by route() (guarded) and publicRoute().
 */
async function runPipeline<C>(
  opts: RouteOptions<ZodType | undefined>,
  handler: GuardedHandler<C, unknown>,
  req: NextRequest,
  session: GuardSession,
  ctx: C,
): Promise<NextResponse> {
  // 1. Optional mutation-Origin gate (env-gated, off by default).
  const originDenied = mutationOriginDenied(req)
  if (originDenied) return originDenied

  // 2. Rate limit (outside the try — exactly where the routes kept it, so
  // malformed spam still burns tokens and limiter failures never mask 429s).
  if (opts.rateLimit) {
    const limited = await enforceRateLimit(
      req,
      opts.rateLimit.bucket,
      opts.rateLimit.limit,
      opts.rateLimit.windowMs ?? 60_000,
    )
    if (limited) return limited
  }

  // 3. Body pipeline + handler, inside the route's error path.
  try {
    let body: unknown = undefined
    if (opts.body) {
      const parsed = await readBody(req, opts.body)
      if (parsed.ok) body = parsed.body
      else if ('rethrow' in parsed) throw parsed.rethrow
      else return parsed.response
    }
    return await handler(req, session as NonNullable<GuardSession>, body, ctx)
  } catch (e) {
    if (opts.onError) return opts.onError(e, opts.scope)
    console.error(`[${opts.scope}]`, e)
    return safeError(400, 'Request failed')(e, opts.scope)
  }
}

/**
 * Guarded JSON route: requires a session (401), optional role allowlist
 * (403), then the shared pipeline. The auth step is literally withGuard —
 * guard.ts keeps exactly one 401/403 implementation, fail-closed included.
 */
export function route<C = unknown, S extends ZodType | undefined = undefined>(
  opts: RouteOptions<S>,
  handler: GuardedHandler<C, BodyOf<S>>,
): NextRouteHandler<C> {
  return withGuard<C>(
    (req, session, ctx) => runPipeline(opts, handler as GuardedHandler<C, unknown>, req, session, ctx),
    { roles: opts.roles },
  )
}

/**
 * Public JSON route (share links, /api/project's token path, /api/actions's
 * session-or-shareToken contract): no 401. A session cookie, when present, is
 * still decoded (best-effort — a garbage cookie is "no session", never a 500)
 * and handed to the handler as `GuardSession | null`.
 */
export function publicRoute<C = unknown, S extends ZodType | undefined = undefined>(
  opts: RouteOptions<S>,
  handler: PublicHandler<C, BodyOf<S>>,
): NextRouteHandler<C> {
  return async (req: NextRequest, ctx: C): Promise<NextResponse> => {
    let session: GuardSession = null
    try {
      session = await getSessionFromReq(req)
    } catch {
      session = null // unsigned/garbage cookie is not a principal
    }
    return runPipeline(opts, handler as GuardedHandler<C, unknown>, req, session, ctx)
  }
}
