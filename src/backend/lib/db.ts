import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// BE-8 (issue #77): query logging is DEV-ONLY. 'error' and 'warn' stay on in
// every environment (failures must always be visible); the 'query' level
// logged every SQL statement to stdout unconditionally — log volume/perf cost
// in production, and statements carrying user data landing in container logs.
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['query', 'error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db