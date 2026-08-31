import NextAuth from 'next-auth'
import { authOptions } from '@/lib/auth'

// NextAuth v4 route handler (App Router). Cast keeps Next 16's stricter
// route-handler signature happy — v4's handler is (req, res?) => Promise<Response>.
const handler = NextAuth(authOptions) as unknown as (
  req: Request,
) => Promise<Response>

export { handler as GET, handler as POST }
