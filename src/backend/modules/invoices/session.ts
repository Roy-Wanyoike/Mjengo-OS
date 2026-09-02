// Invoices module — server-side actor resolution.
//
// applyAction() (src/backend/lib/mjengo.ts) strips the __actor/__role overrides before
// handlers run (they only feed the Bias-Free Ledger), so decision-grade role
// checks need the signed-in identity resolved HERE, from the request cookie.
// This module is imported ONLY through src/backend/actions/invoices.ts, which is
// server-only (client files import types from '@/backend/lib/mjengo' with `import
// type`, so this never reaches a client bundle).
//
// Resolution rules:
//  · a session whose role is 'client'      → the payer role (may decide/pay)
//  · any other signed-in role (contractor,
//    admin, foreman…)                       → NOT the payer — decisions fail
//  · no session (share-link client path)   → null. /api/share only lets
//    CLIENT-allowlisted actions through, so a null role reaching an applier
//    has already been gated to client semantics upstream.

import { headers as nextHeaders } from 'next/headers'
import { getToken } from 'next-auth/jwt'

/** Parse a raw cookie header into a plain map (values keep their '=' chars). */
function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx > 0) {
      const name = part.slice(0, idx).trim()
      if (name) out[name] = part.slice(idx + 1).trim()
    }
  }
  return out
}

export interface ActorIdentity {
  role: string | null
  name: string | null
}

/**
 * Resolve the signed-in user inside a dispatched action. Returns
 * { role: null, name: null } when there is no session or we are outside a
 * request scope (defensive — never throws).
 */
export async function currentActor(): Promise<ActorIdentity> {
  try {
    const h = await nextHeaders()
    const cookieHeader = h.get('cookie') ?? ''
    if (!cookieHeader) return { role: null, name: null }
    // Same JWT contract as src/backend/lib/guard.ts (next-auth v4 getToken).
    const token = await getToken({
      req: { cookies: parseCookieHeader(cookieHeader), headers: {} } as never,
      secret: process.env.NEXTAUTH_SECRET,
    })
    if (!token?.email) return { role: null, name: null }
    return { role: String(token.role ?? 'contractor'), name: String(token.name ?? '') }
  } catch {
    return { role: null, name: null }
  }
}
