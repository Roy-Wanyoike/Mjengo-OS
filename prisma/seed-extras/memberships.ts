// ProjectMembership seed (issue #174 / SEC-6 — the site-team read scope).
// Standalone — safe to re-run anytime: wipes ONLY the ProjectMembership
// table (the grants it owns) and re-plants it from the CURRENT User +
// Project rows, so it never touches any other model.
//
// WHAT IT PLANTS (the SINGLE-ORG ACCEPTED-RISK posture, see SECURITY.md):
// every supervisor / procurement / qs / finance user gets a membership row
// on EVERY project, with role-on-project = their account role. That keeps
// every demo journey exactly as wide as it was before #174 (Wanjiru the
// supervisor still opens all three seeded sites) while the ENFORCEMENT
// exists: a site-team account with no rows reads the honest empty portfolio,
// never everything. contractor/admin get NO rows — their portfolio grant is
// code (src/backend/lib/membership-scope.ts PORTFOLIO_GRANT_ROLES), not
// data, so this seed can never widen or narrow it. client/supplier sessions
// pin through their own session stamps and never consult this table.
//
// WHEN TO REVISIT (the SECURITY.md trigger conditions): multi-org
// onboarding, or external professionals getting accounts — then this
// blanket grant becomes per-project intent (an operator decides who works
// where), and grant/revoke tooling replaces this seed as the writer.
//
// Dependencies: prisma/seed.ts (projects) + prisma/seed-extras/users.ts
// (the demo personas) must have run. Missing users or projects → honest
// error (the users.ts rule), never a silent partial grant.

import { PrismaClient } from '@prisma/client'

import { assertSeedAllowed } from '../seed-guard'

assertSeedAllowed()

const db = new PrismaClient()

/** The site-team roles whose reads are membership-scoped (SEC-6). */
const MEMBERSHIP_ROLES = ['supervisor', 'procurement', 'qs', 'finance'] as const

async function main() {
  await db.projectMembership.deleteMany()

  const users = await db.user.findMany({ select: { id: true, email: true, role: true } })
  const projects = await db.project.findMany({ select: { id: true, name: true } })
  if (!projects.length) throw new Error('Base projects missing — run `bun prisma/seed.ts` first')

  const siteTeam = users.filter((u) => (MEMBERSHIP_ROLES as readonly string[]).includes(u.role))
  if (!siteTeam.length) {
    // Honest no-op: no site-team personas exist (e.g. a production DB with
    // only contractor/admin/client accounts) — nothing to grant, and the
    // empty table is the CORRECT fail-closed state for such accounts.
    console.log('ProjectMembership seeded: 0 rows (no site-team users exist — fail-closed empty scope)')
    return
  }

  await db.projectMembership.createMany({
    data: siteTeam.flatMap((u) =>
      projects.map((p) => ({ userId: u.id, projectId: p.id, role: u.role })),
    ),
  })

  console.log(
    `ProjectMembership seeded: ${siteTeam.length} site-team user(s) × ${projects.length} project(s) = ` +
      `${siteTeam.length * projects.length} rows (single-org posture, issue #174 / SECURITY.md)`,
  )
  for (const u of siteTeam) {
    console.log(`  ${u.email.padEnd(24)} → all ${projects.length} projects as ${u.role}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
