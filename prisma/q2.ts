import { PrismaClient } from '@prisma/client'
import { ensureForeignKeys } from '@/backend/lib/db'
const db = new PrismaClient()
async function main() {
  await ensureForeignKeys(db) // issue #135 / audit DB-12 — refuse to write with FK enforcement off
  const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)
  const att = await db.attendance.findMany({ where: { method: 'ussd', date: today } })
  for (const a of att) console.log('ATT:', a.date, a.workerId, a.method, a.verification, a.wage, a.checkIn?.toISOString(), '| evidence:', a.evidence)
  const alerts = await db.alert.findMany({ where: { type: 'info', title: { contains: 'USSD' } } })
  console.log('ussd alerts:', alerts.length)
}
main().finally(() => db.$disconnect())
