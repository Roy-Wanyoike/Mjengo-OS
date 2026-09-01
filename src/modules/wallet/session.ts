// Wallet / money module — server-side actor resolution (F-MONEY F3).
//
// Same pattern as modules/invoices/session.ts: applyAction() strips the
// __actor/__role overrides before handlers run (they only feed the Bias-Free
// Ledger), so decision-grade role checks must resolve the signed-in identity
// HERE, from the request cookie — never from the payload.
//
// Resolution rules (documented, deny-by-default):
//  · a session whose role is in the caller's allowlist  → the decider
//  · any other signed-in role                            → NOT the decider —
//    the action fails with a clear server-side message naming the role
//  · no session (share-link / public route path)         → the payload actor
//    fallback. /api/share and /api/sync only let CLIENT-allowlisted actions
//    through unauthenticated or client-gated traffic, so a null role reaching
//    a money applier has already been gated to client semantics upstream —
//    the payload `by` is used ONLY on that path (same as invoices).
//
// This file is imported only through server-side action/service code, so it
// never reaches a client bundle.

import { headers as nextHeaders } from 'next/headers'
import { getToken } from 'next-auth/jwt'
import { db } from '@/lib/db'

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
    // Same JWT contract as src/lib/guard.ts (next-auth v4 getToken).
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

export interface DeciderIdentity {
  name: string
  role: string
}

/**
 * Session gate for money decisions (F3). The decision-maker is resolved from
 * the signed-in session — the payload `by` is trusted ONLY on the sessionless
 * share-link path, where it falls back to the project's client (the share
 * route stamps that actor). Every other role throws with an honest message.
 */
export async function requireDeciderRole(
  projectId: string,
  opts: { allowed: readonly string[]; action: string; payloadBy?: unknown },
): Promise<DeciderIdentity> {
  const actor = await currentActor()
  if (actor.role === null) {
    // Share-link / public route path: upstream gates already restricted this
    // caller to client semantics; the recorded decider is the project client.
    const project = await db.project.findUnique({ where: { id: projectId } })
    const fallback =
      typeof opts.payloadBy === 'string' && opts.payloadBy.trim() ? opts.payloadBy.trim() : project?.client ?? 'Client'
    return { name: fallback, role: 'client' }
  }
  if (opts.allowed.includes(actor.role)) {
    return { name: actor.name?.trim() || actor.role, role: actor.role }
  }
  const project = await db.project.findUnique({ where: { id: projectId } })
  throw new Error(
    `Only ${opts.allowed.join(' or ')} may ${opts.action} — signed in as "${actor.role}"${actor.name ? ` (${actor.name})` : ''}. ` +
      `The decision queue is waiting for ${project?.client ?? 'the project client'}.`,
  )
}
