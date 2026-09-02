import NextAuth from 'next-auth'
import { buildAuthOptions, warnNextAuthUrlMismatch } from '@/backend/lib/auth'

/**
 * NextAuth v4 route handler (App Router), hardened for reverse-proxy access.
 *
 * Cookie policy is built PER REQUEST from the real protocol
 * (`x-forwarded-proto`, set by the sandbox gateway / any TLS proxy):
 * - https  → SameSite=None; Secure, __Secure-/__Host- names (iframe-safe —
 *   the preview panel embeds the app; lax cookies are not sent in
 *   cross-site iframes, which broke preview sign-in)
 * - http   → next-auth defaults (lax), plain names for localhost dev
 *
 * The returned handler cast keeps Next 16's stricter route-handler
 * signature happy — v4's handler is (req, res?) => Promise<Response>.
 */
async function handler(req: Request, ctx: unknown): Promise<Response> {
  warnNextAuthUrlMismatch(req.headers)
  const proto = req.headers.get('x-forwarded-proto') ?? 'http'
  const secureCookies = proto === 'https'
  const nextAuth = NextAuth(buildAuthOptions(secureCookies)) as unknown as (
    r: Request,
    c: unknown,
  ) => Promise<Response>
  return nextAuth(req, ctx)
}

export { handler as GET, handler as POST }
