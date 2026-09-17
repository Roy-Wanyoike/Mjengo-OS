import { NextRequest, NextResponse } from 'next/server'
// v4's types keep getToken in 'next-auth/jwt' (not the 'next-auth/next' barrel)
import { getToken } from 'next-auth/jwt'
import type { MjengoSessionUser } from '@/lib/auth'
import { apiErrorResponse } from './http'
import { checkRateLimit } from './rate-limit'

/**
 * Canonical API guard. `src/lib/guard.ts` re-exports this module so every
 * pre-existing import keeps working — new code should import from here.
 *
 * withGuard gives every route, for free:
 *  1. 401 when there is no session
 *  2. 403 when `roles` is set and the session role is not in it
 *  3. 429 when `rateLimit` budget is exhausted (keyed by user)
 *  4. an error boundary: ApiError → its status/message, anything else →
 *     logged + generic 500 (no stack traces to clients)
 */

export type GuardSession = { user: MjengoSessionUser } | null

/** JWT-decode the next-auth session straight off the request cookie. */
export async function getSessionFromReq(req: NextRequest): Promise<GuardSession> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.email) return null
  return {
    user: {
      id: String(token.id ?? token.sub ?? ''),
      email: String(token.email),
      name: String(token.name ?? ''),
      role: String(token.role ?? 'contractor'),
      projectId: token.projectId ?? null,
    },
  }
}

/** 401 — the caller must sign in (owner APIs). */
export function unauthorized() {
  return NextResponse.json({ error: 'Sign in required' }, { status: 401 })
}

/** 403 — signed in but the role is not permitted for this operation. */
export function forbidden(role?: string) {
  return NextResponse.json(
    { error: role ? `Not permitted for role "${role}"` : 'Not permitted' },
    { status: 403 },
  )
}

export interface GuardOptions {
  /** Role allowlist — omit to allow any signed-in role. */
  roles?: readonly string[]
  /** Per-user sliding-window budget. */
  rateLimit?: { limit: number; windowMs: number }
  /** Log tag on unexpected errors (match the route path). */
  tag?: string
}

type GuardedHandler = (
  req: NextRequest,
  session: NonNullable<GuardSession>,
) => Promise<NextResponse> | NextResponse

export function withGuard(handler: GuardedHandler, opts?: GuardOptions) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const tag = opts?.tag ?? 'api'
    try {
      const session = await getSessionFromReq(req)
      if (!session) return unauthorized()
      if (opts?.roles && !opts.roles.includes(session.user.role)) {
        return forbidden(session.user.role)
      }
      if (opts?.rateLimit) {
        const who = session.user.id || session.user.email
        const allowed = checkRateLimit(
          `${tag}:${who}`,
          opts.rateLimit.limit,
          opts.rateLimit.windowMs,
        )
        if (!allowed) {
          return NextResponse.json(
            { error: 'Too many requests — wait a moment and try again.' },
            { status: 429 },
          )
        }
      }
      return await handler(req, session)
    } catch (e) {
      return apiErrorResponse(e, tag)
    }
  }
}
