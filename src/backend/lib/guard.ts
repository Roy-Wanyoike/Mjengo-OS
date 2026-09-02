import { NextRequest, NextResponse } from 'next/server'
// v4's types keep getToken in 'next-auth/jwt' (not the 'next-auth/next' barrel)
import { getToken } from 'next-auth/jwt'
import type { MjengoSessionUser } from '@/backend/lib/auth'

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

// ---------------- internal-error redaction (S-SEC) ----------------

/**
 * True when an exception carries framework internals that must not reach a
 * client body: Prisma client errors (class name `Prisma*`, code `P####`, or
 * the "`` invocation in" validation banner) leak absolute build paths, table
 * shapes and the dev-server chunk map. Multi-line messages are treated as
 * internal too — domain errors thrown by the appliers are single-line.
 */
export function isInternalError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const name = e.constructor?.name ?? e.name ?? ''
  const code = String((e as { code?: unknown }).code ?? '')
  return (
    name.startsWith('Prisma') ||
    /^P\d{4}$/.test(code) ||
    e.message.includes('` invocation in') ||
    e.message.includes('\n')
  )
}

/**
 * Honest error message for a response body: the appliers' own single-line
 * Error messages (business rules) pass through; Prisma/framework internals
 * are replaced with `fallback` (full detail still goes to the server log).
 */
export function safeErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && !isInternalError(e) ? e.message : fallback
}

// ---------------- role allowlists (F-MONEY: finance role lands, spec §36/§38) ----

/**
 * Roles that may operate the finance / wallet surface (spec §38 wallet API,
 * payment execution, journals). Finance owns the queue; admin is superuser.
 */
export const FINANCE_ROLES: readonly string[] = ['finance', 'admin']

/** Roles that may execute payments on behalf of the payer queue (incl. the client). */
export const PAYMENT_ROLES: readonly string[] = ['finance', 'admin', 'client']

/** Every known staff/finance role (defensive: unknown roles still fail closed). */
export const KNOWN_ROLES: readonly string[] = [
  'contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs',
]

/**
 * Roles that operate the owner app (W1-PERM, spec §7 role matrix).
 * Mirrored client-side by src/shared/permissions.ts OWNER_ROLES — keep in sync.
 * `client` is intentionally absent: it boots the client surface, not the owner app.
 */
export const OWNER_ROLES: readonly string[] = [
  'contractor', 'admin', 'supervisor', 'procurement', 'qs', 'finance',
]

type GuardedHandler<C> = (
  req: NextRequest,
  session: NonNullable<GuardSession>,
  ctx: C,
) => Promise<NextResponse> | NextResponse

/**
 * Uniform server-side guard for owner APIs:
 * no session → 401 'Sign in required'; optional role allowlist → 403.
 * The wrapped handler receives the route context (Next 16 dynamic-route
 * `{ params }`) so guarded handlers can read path segments.
 */
export function withGuard<C = unknown>(handler: GuardedHandler<C>, opts?: { roles?: readonly string[] }) {
  return async (req: NextRequest, ctx: C): Promise<NextResponse> => {
    const session = await getSessionFromReq(req)
    if (!session) return unauthorized()
    if (opts?.roles && !opts.roles.includes(session.user.role)) {
      return forbidden(session.user.role)
    }
    return handler(req, session, ctx)
  }
}
