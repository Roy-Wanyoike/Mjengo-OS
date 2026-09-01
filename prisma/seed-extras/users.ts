// Demo users seed (final feature wave: session authentication).
// Standalone — safe to re-run anytime: wipes ONLY the User table.
// Passwords are scrypt-hashed with an embedded per-user salt (`salt:hash` hex),
// verified by src/lib/auth.ts verifyPassword().
//
//   contractor@mjengo.os / mjengo2026  → Site Manager (contractor, full owner app)
//   client@mjengo.os     / mjengo2026  → Amina (Client)   (client role, boots "Nyumba Yangu")
//   admin@mjengo.os      / admin2026   → Mjengo Admin     (admin, full owner app + flags)
//   finance@mjengo.os    / mjengo2026  → Fatuma (Finance) (finance role, F-MONEY — wallet/payment queue)
//   supervisor@mjengo.os / mjengo2026  → Wanjiru (Site Supervisor) (W1-PERM role nav)
//   procurement@mjengo.os / mjengo2026 → Otieno (Procurement)       (W1-PERM role nav)
//   qs@mjengo.os         / mjengo2026  → Kariuki (QS)               (W1-PERM role nav)

import { PrismaClient } from '@prisma/client'
import { randomBytes, scryptSync } from 'node:crypto'

const db = new PrismaClient()

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

async function main() {
  await db.user.deleteMany()

  const p1 = await db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } })
  if (!p1) throw new Error('Base projects missing — run `bun prisma/seed.ts` first')

  await db.user.createMany({
    data: [
      {
        email: 'contractor@mjengo.os',
        passwordHash: hashPassword('mjengo2026'),
        name: 'Site Manager',
        role: 'contractor',
        projectId: null,
      },
      {
        email: 'client@mjengo.os',
        passwordHash: hashPassword('mjengo2026'),
        name: 'Amina (Client)',
        role: 'client',
        projectId: p1.id,
      },
      {
        email: 'admin@mjengo.os',
        passwordHash: hashPassword('admin2026'),
        name: 'Mjengo Admin',
        role: 'admin',
        projectId: null,
      },
      {
        email: 'finance@mjengo.os',
        passwordHash: hashPassword('mjengo2026'),
        name: 'Fatuma (Finance)',
        role: 'finance',
        projectId: null,
      },
      {
        email: 'supervisor@mjengo.os',
        passwordHash: hashPassword('mjengo2026'),
        name: 'Wanjiru (Site Supervisor)',
        role: 'supervisor',
        projectId: null,
      },
      {
        email: 'procurement@mjengo.os',
        passwordHash: hashPassword('mjengo2026'),
        name: 'Otieno (Procurement)',
        role: 'procurement',
        projectId: null,
      },
      {
        email: 'qs@mjengo.os',
        passwordHash: hashPassword('mjengo2026'),
        name: 'Kariuki (QS)',
        role: 'qs',
        projectId: null,
      },
    ],
  })

  const users = await db.user.findMany({ select: { email: true, name: true, role: true, projectId: true } })
  console.log('Users seeded:', users)
  console.log('Users seed done.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
