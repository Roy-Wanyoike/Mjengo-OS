import { NextRequest, NextResponse } from 'next/server'
// v4's types keep getToken in 'next-auth/jwt' (not the 'next-auth/next' barrel)
import { getToken } from 'next-auth/jwt'
import type { MjengoSessionUser } from '@/lib/auth'

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

type GuardedHandler = (
  req: NextRequest,
  session: NonNullable<GuardSession>,
) => Promise<NextResponse> | NextResponse

/**
 * Uniform server-side guard for owner APIs:
 * no session → 401 'Sign in required'; optional role allowlist → 403.
 */
export function withGuard(handler: GuardedHandler, opts?: { roles?: readonly string[] }) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const session = await getSessionFromReq(req)
    if (!session) return unauthorized()
    if (opts?.roles && !opts.roles.includes(session.user.role)) {
      return forbidden(session.user.role)
    }
    return handler(req, session)
  }
}
