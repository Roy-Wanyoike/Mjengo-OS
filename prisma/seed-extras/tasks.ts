// Task management v2 seed (Doc A §11) — priority, assignment, dependencies,
// blockers with a recorded reason, verification and an overdue escalation case
// for "Nyumba Yangu — 3BR Bungalow".
//
// Standalone: run AFTER prisma/seed.ts (`bun prisma/seed-extras/tasks.ts`).
// Wipes ONLY the tasks it owns (matched by title, so a re-run never touches
// the base seed's tasks) and the audit rows those tasks carry. All lookups
// are by NAME (project, phase, worker, blocker task) — never hardcoded ids.
//
// Seeded scenarios:
//   · URGENT   "Ring beam casting — order & pour ready-mix" → Walling, assigned
//              to a real worker (looked up by name), due in 3 days
//   · BLOCKED  "Roof truss fabrication & delivery" → Roofing, blocked with a
//              reason, depends on the incomplete "Ring beam shuttering & casting"
//              task, was due 2 days ago (blocked AND late — the escalation case)
//   · VERIFIED "Wall plate anchor bolts & retrofit ties" → Walling, done + verified
//              by Wanjiru (Site Supervisor)
//   · OVERDUE  "Mabati & ridge cap delivery booking" → Roofing, in progress but
//              past its due date (not blocked)
//
// The block and verify rows write honest AuditEvent entries so the task card
// banner can show WHO blocked the work and WHEN (the UI reads the ledger).

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

function daysAgo(n: number, hour = 10, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d
}

function daysFromNow(n: number, hour = 17, minute = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() + n)
  d.setHours(hour, minute, 0, 0)
  return d
}

async function main() {
  const project = await db.project.findFirst({ where: { name: { contains: 'Nyumba Yangu' } } })
  if (!project) throw new Error('Base project missing — run `bun prisma/seed.ts` first')

  const [walling, roofing] = await Promise.all([
    db.phase.findFirst({ where: { projectId: project.id, name: 'Walling' } }),
    db.phase.findFirst({ where: { projectId: project.id, name: 'Roofing' } }),
  ])
  if (!walling || !roofing) throw new Error('Walling/Roofing phases missing — run `bun prisma/seed.ts` first')

  // The incomplete task our blocked task waits on (lookup by title, never id)
  const ringBeam = await db.task.findFirst({
    where: { phaseId: walling.id, title: 'Ring beam shuttering & casting' },
  })
  if (!ringBeam) throw new Error('Base task "Ring beam shuttering & casting" missing — run `bun prisma/seed.ts` first')

  // Real worker from the base seed (lookup by name)
  const assignee = await db.worker.findFirst({ where: { projectId: project.id, name: 'Otieno Odhiambo' } })
  if (!assignee) throw new Error('Worker "Otieno Odhiambo" missing — run `bun prisma/seed.ts` first')

  const ownedTitles = [
    'Ring beam casting — order & pour ready-mix',
    'Roof truss fabrication & delivery',
    'Wall plate anchor bolts & retrofit ties',
    'Mabati & ridge cap delivery booking',
  ]

  // Idempotent re-run: wipe only the tasks this script owns (+ their audit rows)
  const existing = await db.task.findMany({ where: { phase: { projectId: project.id }, title: { in: ownedTitles } } })
  if (existing.length > 0) {
    await db.auditEvent.deleteMany({ where: { projectId: project.id, entity: 'task', entityId: { in: existing.map((t) => t.id) } } })
    await db.task.deleteMany({ where: { id: { in: existing.map((t) => t.id) } } })
  }

  // 1 · URGENT — assigned, due soon
  const urgent = await db.task.create({
    data: {
      phaseId: walling.id,
      title: 'Ring beam casting — order & pour ready-mix',
      status: 'in_progress',
      progress: 20,
      priority: 'urgent',
      assignedToId: assignee.id,
      dueDate: daysFromNow(3),
    },
  })

  // 2 · BLOCKED — reason + dependency on incomplete work, and already late
  const blocked = await db.task.create({
    data: {
      phaseId: roofing.id,
      title: 'Roof truss fabrication & delivery',
      status: 'blocked',
      progress: 0,
      priority: 'high',
      blockedById: ringBeam.id,
      blockedReason: 'Trusses cannot be fabricated until the ring beam is cast and cured — sawmill is holding the order',
      dueDate: daysAgo(2),
    },
  })

  // 3 · DONE + VERIFIED
  const verified = await db.task.create({
    data: {
      phaseId: walling.id,
      title: 'Wall plate anchor bolts & retrofit ties',
      status: 'done',
      progress: 100,
      priority: 'normal',
      assignedToId: assignee.id,
      verifiedAt: daysAgo(5, 16),
      verifiedByName: 'Wanjiru (Site Supervisor)',
    },
  })

  // 4 · OVERDUE (not blocked — plain late work)
  const overdue = await db.task.create({
    data: {
      phaseId: roofing.id,
      title: 'Mabati & ridge cap delivery booking',
      status: 'in_progress',
      progress: 45,
      priority: 'normal',
      assignedToId: assignee.id,
      dueDate: daysAgo(3),
    },
  })

  // Honest audit rows so the UI can show who blocked/verified and when
  await db.auditEvent.createMany({
    data: [
      {
        projectId: project.id,
        kind: 'task',
        actor: 'Mwangi Kariuki',
        role: 'foreman',
        summary: `Blocked "${blocked.title}" — waiting on ring beam`,
        meta: JSON.stringify({ type: 'task.block', reason: blocked.blockedReason }),
        entity: 'task',
        entityId: blocked.id,
        createdAt: daysAgo(2, 9, 30),
      },
      {
        projectId: project.id,
        kind: 'task',
        actor: 'Wanjiru (Site Supervisor)',
        role: 'supervisor',
        summary: `Verified "${verified.title}" on site`,
        meta: JSON.stringify({ type: 'task.verify' }),
        entity: 'task',
        entityId: verified.id,
        createdAt: daysAgo(5, 16, 5),
      },
    ],
  })

  const counts = await db.task.count({ where: { phase: { projectId: project.id } } })
  console.log('Task v2 seed — Nyumba Yangu:');
  console.log(`  · urgent:   "${urgent.title}" (${urgent.priority}, assigned to ${assignee.name}, due ${urgent.dueDate?.toISOString().slice(0, 10)})`);
  console.log(`  · blocked:  "${blocked.title}" (blockedBy "${ringBeam.title}", due ${blocked.dueDate?.toISOString().slice(0, 10)} — blocked AND overdue)`);
  console.log(`  · verified: "${verified.title}" (verified by ${verified.verifiedByName} at ${verified.verifiedAt?.toISOString()})`);
  console.log(`  · overdue:  "${overdue.title}" (in progress, was due ${overdue.dueDate?.toISOString().slice(0, 10)})`);
  console.log(`Project now has ${counts} tasks (base seed tasks untouched).`);
  console.log('Task v2 seed done.');
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
