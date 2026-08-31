import type { NextAuthOptions } from 'next-auth'
import type { NextRequest } from 'next/server'
// v4's types keep getToken in 'next-auth/jwt' (the 'next-auth/next' barrel is
// not typed for it) — runtime signature is identical: { req, secret }.
import { getToken } from 'next-auth/jwt'
import CredentialsProvider from 'next-auth/providers/credentials'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'

/** Shape carried on the session (JWT → session callback). */
export interface MjengoSessionUser {
  id: string
  email: string
  name: string
  role: 'contractor' | 'client' | 'admin' | string
  /** For client-role users: the project they are buying. Null for site team / admin. */
  projectId: string | null
}

declare module 'next-auth' {
  interface User {
    role?: string
    projectId?: string | null
  }
  interface Session {
    user: MjengoSessionUser
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string
    role?: string
    projectId?: string | null
  }
}

// ---------------------------------------------------------------- scrypt passwords

/** scrypt hash, salt embedded: `<salt hex>:<hash hex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

/** Constant-time scrypt verification against a `salt:hash` string. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = String(stored ?? '').split(':')
  if (!salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const candidate = scryptSync(password, salt, expected.length)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

// ---------------------------------------------------------------- next-auth options

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 }, // 30 days
  providers: [
    CredentialsProvider({
      name: 'MjengoOS account',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase()
        const password = credentials?.password ?? ''
        if (!email || !password) return null
        const user = await db.user.findUnique({ where: { email } })
        if (!user || !verifyPassword(password, user.passwordHash)) return null
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          projectId: user.projectId,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = user.role ?? 'contractor'
        token.projectId = user.projectId ?? null
        token.name = user.name ?? token.name
        token.email = user.email ?? token.email
      }
      return token
    },
    async session({ session, token }) {
      session.user = {
        id: String(token.id ?? token.sub ?? ''),
        email: String(token.email ?? ''),
        name: String(token.name ?? ''),
        role: String(token.role ?? 'contractor'),
        projectId: token.projectId ?? null,
      }
      return session
    },
  },
}

// ---------------------------------------------------------------- helper

/** Server-side session for a request (JWT decode) — null when signed out. */
export async function requireSession(
  req: NextRequest,
): Promise<{ user: MjengoSessionUser } | null> {
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
