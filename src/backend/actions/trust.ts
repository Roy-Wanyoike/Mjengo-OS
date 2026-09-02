// Workforce Trust actions — reported vs verified attendance, exceptions,
// append-only overrides, and payroll gated on verification. Dispatched from
// lib/mjengo.ts applyAction(), which also writes the AuditEvent (Bias-Free
// Ledger) for every successful action — never log manually here.

import { db } from '@/backend/lib/db'
import type { Attendance, Worker } from '@prisma/client'

export const TRUST_ACTIONS = [
  'attendance.record', // bulk muster roll { records: [{workerId,status}] | JSON string, verification?, recordedBy? }
  'attendance.exception', // { workerId, date?, reason, note?, evidence? }
  'attendance.override', // { id, to, reason, by } — append-only overrideLog
  'payroll.approve', // gated: refuses while exception records exist (unless force)
] as const

// ---------------- helpers ----------------

/** EAT "today" — must match lib/mjengo.ts so actions target the same rows todayStatus reports. */
function todayStr(): string {
  const d = new Date()
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

const STATUSES = ['present', 'absent', 'half_day', 'excused'] as const
const EXCEPTION_REASONS = ['phone_damaged', 'battery_dead', 'network', 'forgot', 'new_worker', 'emergency', 'other'] as const

function wageFor(status: string, dailyRate: number): number {
  return status === 'present' ? dailyRate : status === 'half_day' ? dailyRate * 0.5 : 0
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : []
  } catch {
    return []
  }
}

function parseOverrideLog(raw: string | null | undefined): Array<Record<string, unknown>> {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// ---------------- actions ----------------

export async function applyTrustAction(type: string, payload: any, projectId: string): Promise<any> {
  switch (type) {
    // Daily muster roll — bulk manager record of TODAY's attendance.
    case 'attendance.record': {
      let records = payload?.records
      if (typeof records === 'string') {
        try { records = JSON.parse(records) } catch { records = null }
      }
      if (!Array.isArray(records) || records.length === 0) throw new Error('records (non-empty array of {workerId,status}) required')
      // audit.ts summarizeAction() JSON.parses payload.records — keep it a JSON
      // string on the shared payload object no matter how the caller sent it.
      payload.records = JSON.stringify(records)

      const verification = payload?.verification === 'verified' ? 'verified' : 'reported'
      const recordedBy = typeof payload?.recordedBy === 'string' && payload.recordedBy.trim()
        ? payload.recordedBy.trim() : 'Site Manager'
      const today = todayStr()
      const workers = await db.worker.findMany({ where: { projectId } })
      const byId = new Map<string, Worker>(workers.map((w) => [w.id, w]))

      let count = 0
      for (const r of records) {
        const worker = byId.get(String(r?.workerId ?? ''))
        if (!worker) throw new Error(`Unknown worker: ${r?.workerId}`)
        const status = (STATUSES as readonly string[]).includes(r?.status) ? r.status : 'present'
        const wage = wageFor(status, worker.dailyRate)
        const existing = await db.attendance.findFirst({ where: { workerId: worker.id, date: today } })

        if (!existing) {
          // No record yet — manager's word is the source: reported (or caller-verified)
          await db.attendance.create({
            data: {
              workerId: worker.id, projectId, date: today,
              status, wage,
              checkIn: status === 'absent' || status === 'excused' ? null : new Date(),
              method: 'manager', verification, recordedBy,
            },
          })
        } else if (existing.status !== status) {
          // Status correction — append-only override history, manager statement supersedes
          const overrideLog = parseOverrideLog(existing.overrideLog)
          overrideLog.push({
            at: new Date().toISOString(), by: recordedBy,
            from: existing.status, to: status, reason: 'Daily muster correction',
          })
          await db.attendance.update({
            where: { id: existing.id },
            data: {
              status, wage,
              overrideLog: JSON.stringify(overrideLog),
              method: 'manager', verification, recordedBy,
            },
          })
        }
        // Same status: leave the row untouched — a re-saved muster must never
        // downgrade worker-verified evidence (geofence/USSD/kiosk) to reported,
        // and unresolved exceptions stay flagged for the payroll gate.
        count++
      }
      return { count }
    }

    // Exception — worker is present but could not produce normal check-in evidence.
    case 'attendance.exception': {
      const { workerId, reason, note, evidence } = payload ?? {}
      if (!workerId) throw new Error('workerId required')
      if (!(EXCEPTION_REASONS as readonly string[]).includes(reason)) {
        throw new Error(`reason must be one of: ${EXCEPTION_REASONS.join(', ')}`)
      }
      const worker = await db.worker.findUnique({ where: { id: String(workerId) } })
      if (!worker) throw new Error('Unknown worker')
      const day = isIsoDate(payload?.date) ? payload.date : todayStr()

      const extraEvidence = Array.isArray(evidence) ? evidence.filter((e: unknown) => typeof e === 'string').map(String) : []
      let att: Attendance
      const existing = await db.attendance.findFirst({ where: { workerId: worker.id, date: day } })
      if (!existing) {
        att = await db.attendance.create({
          data: {
            workerId: worker.id, projectId, date: day,
            status: 'present', wage: worker.dailyRate,
            method: 'manager',
            verification: 'exception',
            exceptionReason: reason,
            exceptionNote: typeof note === 'string' && note.trim() ? note.trim() : null,
            evidence: JSON.stringify(['supervisor', ...extraEvidence]),
            recordedBy: 'Site Manager',
          },
        })
      } else {
        const merged = Array.from(new Set([...parseJsonArray(existing.evidence), 'supervisor', ...extraEvidence]))
        att = await db.attendance.update({
          where: { id: existing.id },
          data: {
            verification: 'exception',
            exceptionReason: reason,
            exceptionNote: typeof note === 'string' && note.trim() ? note.trim() : existing.exceptionNote,
            evidence: JSON.stringify(merged),
            method: 'manager',
          },
        })
      }
      return { id: att.id }
    }

    // Override — explicit status change with a reason. History is append-only, never truncated.
    case 'attendance.override': {
      const { id, to, reason, by } = payload ?? {}
      if (!id) throw new Error('attendance id required')
      if (!(STATUSES as readonly string[]).includes(to)) {
        throw new Error(`to must be one of: ${STATUSES.join(', ')}`)
      }
      const why = typeof reason === 'string' ? reason.trim() : ''
      if (!why) throw new Error('reason required (recorded in the append-only override log)')
      const att = await db.attendance.findUnique({ where: { id: String(id) } })
      if (!att) throw new Error('Attendance record not found')
      const worker = await db.worker.findUnique({ where: { id: att.workerId } })

      const overrideLog = parseOverrideLog(att.overrideLog)
      overrideLog.push({
        at: new Date().toISOString(),
        by: typeof by === 'string' && by.trim() ? by.trim() : 'Site Manager',
        from: att.status, to, reason: why,
      })

      const data: Partial<Attendance> = {
        status: to,
        wage: wageFor(to, worker?.dailyRate ?? 0),
        overrideLog: JSON.stringify(overrideLog), // full history + new entry
      }
      // A manager override is reported evidence — except excused, which resolves
      // the exception as a sanctioned absence without pay.
      if (att.verification === 'exception' && to !== 'excused') {
        data.verification = 'reported'
        data.recordedBy = typeof by === 'string' && by.trim() ? by.trim() : 'Site Manager'
      }
      const updated = await db.attendance.update({ where: { id: att.id }, data })
      return { id: updated.id, status: updated.status, wage: updated.wage }
    }

    // THE GATE — payroll for a date (default today). Refuses to pay while any
    // unpaid attendance still carries an unreviewed exception, unless forced.
    case 'payroll.approve': {
      const date = isIsoDate(payload?.date) ? payload.date : todayStr()
      const force = Boolean(payload?.force)
      const where: { date: string; paid: boolean; projectId: string; workerId?: { in: string[] } } = {
        date, paid: false, projectId,
      }
      if (Array.isArray(payload?.workerIds) && payload.workerIds.length > 0) {
        where.workerId = { in: payload.workerIds.map(String) }
      }
      const rows = await db.attendance.findMany({ where })
      const unpaid = rows.filter((r) => r.status !== 'absent' && r.status !== 'excused' && r.wage > 0)
      if (unpaid.length === 0) return { blocked: false, paid: 0, amount: 0 }

      const exceptions = unpaid.filter((r) => r.verification === 'exception')
      const total = unpaid.reduce((s, u) => s + u.wage, 0)

      if (exceptions.length > 0 && !force) {
        // Blocked — return the review payload (no throw: the UI needs the list)
        const reviewWorkers = await db.worker.findMany({ where: { id: { in: exceptions.map((e) => e.workerId) } } })
        return {
          blocked: true,
          date,
          requiringReview: exceptions.map((e) => ({
            workerId: e.workerId,
            name: reviewWorkers.find((w) => w.id === e.workerId)?.name ?? 'Unknown',
            reason: e.exceptionReason,
          })),
          amount: total, // payroll on hold
          reviewAmount: exceptions.reduce((s, e) => s + e.wage, 0), // exception wages only
        }
      }

      await db.attendance.updateMany({
        where: { id: { in: unpaid.map((u) => u.id) } },
        data: { paid: true },
      })
      const paidWorkers = await db.worker.findMany({ where: { id: { in: unpaid.map((u) => u.workerId) } } })
      await db.transaction.create({
        data: {
          projectId,
          type: 'wage',
          amount: total,
          method: 'mpesa',
          reference: `B2C-${Date.now().toString().slice(-8)}`,
          note: `Payroll ${date}${exceptions.length > 0 ? ' (forced past exceptions)' : ''} — ${unpaid
            .map((u) => paidWorkers.find((w) => w.id === u.workerId)?.name.split(' ')[0] ?? '?')
            .join(', ')}`,
          date: new Date(),
        },
      })
      return {
        blocked: false,
        paid: unpaid.length,
        amount: total,
        forced: force && exceptions.length > 0,
      }
    }

    default:
      throw new Error(`Unknown trust action: ${type}`)
  }
}
