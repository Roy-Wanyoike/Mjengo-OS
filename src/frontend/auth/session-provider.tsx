'use client'

import { SessionProvider } from 'next-auth/react'
import type { Session } from 'next-auth'

/** Client-side next-auth context (JWT session from /api/auth). */
export function AuthSessionProvider({
  children,
  session,
}: {
  children: React.ReactNode
  session?: Session | null
}) {
  return <SessionProvider session={session}>{children}</SessionProvider>
}
