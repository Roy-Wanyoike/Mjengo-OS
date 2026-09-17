import { db } from '@/lib/db'
import type { MjengoSessionUser } from '@/lib/auth'
import { badRequest, fieldStr, notFound } from '@/backend/core/http'
import { logAudit } from '@/backend/core/audit'

/**
 * Site Intelligence service.
 *
 * HONESTY RULES
 *  · The `live` block is computed from REAL project data on every read —
 *    attendance verification mix, milestones with evidence, open signals.
 *    Nothing in this tab is a hardcoded number.
 *  · The risk metric is ALWAYS called "Verification Risk" — it measures how
 *    evidence-backed a record is, never "fraud".
 *  · recomputeRiskAssessment is DETERMINISTIC: same live data → same score.
 *    Every point is attributable to a documented rule + actual record counts
 *    (the "drivers"). If no rule has any data we say so — no fabricated score.
 */

/**
 * VERIFICATION RISK RULES (computeProjectRisk) — documented weights + caps.
 * Bands: low 0-33 · medium 34-66 · high 67-100 (matches the model comment).
 *
 *  RULE 1 — Supply verification (project's SupplyOrders, any age):
 *    · status "mismatch" (failed delivery-note verification)   +8 each, cap +24
 *    · status "delivered" (received, verification still pending) +2 each, cap +6
 *    · "verified" / "ordered" / "cancelled" contribute 0.
 *
 *  RULE 2 — Open RiskSignals:
 *    · high open   +15 each, cap +30
 *    · medium open  +8 each, cap +24
 *    · low open     +4 each, cap +12
 *    · acknowledged/resolved signals contribute 0 — a human has taken
 *      ownership; only exposure nobody has seen yet adds risk.
 *
 *  RULE 3 — Worker trust (Worker carries no trust column — trust is earned
 *  from attendance evidence, exactly like the Fundis-tab reliability ring):
 *    · worker with ≥5 attendance records in the last 30 days whose verified
 *      share is < 50% ("low-trust")                                +6 each, cap +18
 *
 *  RULE 4 — Land verification:
 *    · LandParcel linked to the project in status caveat/attention +12 each, cap +24
 *    · TitleSearch on those parcels with found:false (honest miss)  +6 each, cap +12
 *
 *  RULE 5 — Attendance anomalies (last 14 days, needs ≥1 record in window):
 *    · exception rate (exceptionReason set) > 25% → +15
 *    · exception rate > 10%                        → +8
 *    · at or below 10%                             → +0
 *
 *  A rule with data but nothing wrong contributes a 0-point "all clear"
 *  driver (transparency). A rule with NO data is omitted. If EVERY rule is
 *  omitted → insufficient-data state, no score is written.
 */

export interface RiskDriver {
  rule: string
  points: number
  detail: string
}

/** EAT "today" — same convention as trust.ts / lib/mjengo.ts todayStr(). */
const eatToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10)

/** EAT date n days ago, YYYY-MM-DD (attendance.date is a plain string). */
const eatDaysAgo = (n: number) =>
  new Date(Date.now() + 3 * 3600_000 - n * 86400_000).toISOString().slice(0, 10)

/** Monday of the current EAT week, YYYY-MM-DD ("w/c" = week commencing). */
function weekCommencing(): string {
  const d = new Date(`${eatToday()}T12:00:00Z`)
  const dow = d.getUTCDay() // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1))
  return d.toISOString().slice(0, 10)
}

/** 0-100 → low / medium / high (existing thresholds, model comment + UI). */
function bandFor(score: number): string {
  return score <= 33 ? 'low' : score <= 66 ? 'medium' : 'high'
}

/** Engine-written project rows store drivers as a JSON array in `factors`. */
export function parseDrivers(factors: string): RiskDriver[] | null {
  if (!factors.startsWith('[')) return null
  try {
    const parsed: unknown = JSON.parse(factors)
    if (!Array.isArray(parsed)) return null
    return parsed
      .filter(
        (d): d is RiskDriver =>
          !!d && typeof d === 'object' && typeof (d as RiskDriver).rule === 'string' &&
          typeof (d as RiskDriver).points === 'number' && typeof (d as RiskDriver).detail === 'string',
      )
      .map((d) => ({ rule: d.rule, points: d.points, detail: d.detail }))
  } catch {
    return null
  }
}

/** Deterministic Verification Risk compute over LIVE data — pure read. */
async function computeProjectRisk(projectId: string): Promise<{
  hasData: boolean
  score: number
  band: string
  drivers: RiskDriver[]
}> {
  const since30 = eatDaysAgo(30)
  const since14 = eatDaysAgo(14)
  const [orders, signals, attendance, parcels] = await Promise.all([
    db.supplyOrder.findMany({ where: { projectId }, select: { status: true } }),
    db.riskSignal.findMany({ where: { projectId }, select: { severity: true, status: true } }),
    db.attendance.findMany({
      where: { projectId, date: { gte: since30 } },
      select: { workerId: true, verification: true, exceptionReason: true, date: true },
    }),
    db.landParcel.findMany({
      where: { projectId },
      include: { searches: { where: { found: false } } },
    }),
  ])

  const drivers: RiskDriver[] = []

  // RULE 1 — Supply verification
  if (orders.length > 0) {
    const mismatched = orders.filter((o) => o.status === 'mismatch').length
    const awaiting = orders.filter((o) => o.status === 'delivered').length
    const points = Math.min(24, mismatched * 8) + Math.min(6, awaiting * 2)
    const parts: string[] = []
    if (mismatched > 0) parts.push(`${mismatched} mismatched delivery${mismatched === 1 ? '' : 'ies'}`)
    if (awaiting > 0) parts.push(`${awaiting} delivered awaiting verification check`)
    if (parts.length === 0) parts.push(`all ${orders.length} orders verified or still open — no mismatches`)
    drivers.push({ rule: 'Supply verification', points, detail: parts.join('; ') })
  }

  // RULE 2 — Open signals (acknowledged/resolved contribute 0)
  if (signals.length > 0) {
    const open = signals.filter((s) => s.status === 'open')
    const high = open.filter((s) => s.severity === 'high').length
    const medium = open.filter((s) => s.severity === 'medium').length
    const low = open.filter((s) => s.severity === 'low').length
    const points = Math.min(30, high * 15) + Math.min(24, medium * 8) + Math.min(12, low * 4)
    drivers.push({
      rule: 'Open signals',
      points,
      detail:
        open.length > 0
          ? `${open.length} open signal${open.length === 1 ? '' : 's'}: ${high} high, ${medium} medium, ${low} low`
          : `all ${signals.length} signals on record acknowledged or resolved`,
    })
  }

  // RULE 3 — Worker trust (verified share of recent attendance per worker)
  if (attendance.length > 0) {
    const byWorker = new Map<string, { total: number; verified: number }>()
    for (const a of attendance) {
      const row = byWorker.get(a.workerId) ?? { total: 0, verified: 0 }
      row.total += 1
      if (a.verification === 'verified') row.verified += 1
      byWorker.set(a.workerId, row)
    }
    const lowTrust = [...byWorker.values()].filter((w) => w.total >= 5 && w.verified / w.total < 0.5)
    const points = Math.min(18, lowTrust.length * 6)
    drivers.push({
      rule: 'Worker trust',
      points,
      detail:
        lowTrust.length > 0
          ? `${lowTrust.length} of ${byWorker.size} workers below 50% verified attendance (last 30 days)`
          : `all ${byWorker.size} workers at or above 50% verified attendance (last 30 days)`,
    })
  }

  // RULE 4 — Land verification (flagged parcels + honest-miss searches)
  if (parcels.length > 0) {
    const flagged = parcels.filter((p) => p.status === 'caveat' || p.status === 'attention')
    const misses = parcels.reduce((n, p) => n + p.searches.length, 0)
    const points = Math.min(24, flagged.length * 12) + Math.min(12, misses * 6)
    const parts: string[] = []
    if (flagged.length > 0) parts.push(`${flagged.length} parcel${flagged.length === 1 ? '' : 's'} flagged (${flagged.map((p) => p.status).join(', ')})`)
    if (misses > 0) parts.push(`${misses} honest-miss title search${misses === 1 ? '' : 'es'}`)
    if (parts.length === 0) parts.push(`${parcels.length} parcel${parcels.length === 1 ? '' : 's'} verified — no caveats or missed searches`)
    drivers.push({ rule: 'Land verification', points, detail: parts.join('; ') })
  }

  // RULE 5 — Attendance anomalies (exception rate, last 14 days)
  const recent = attendance.filter((a) => a.date >= since14)
  if (recent.length > 0) {
    const exceptions = recent.filter((a) => a.exceptionReason != null).length
    const rate = Math.round((exceptions / recent.length) * 100)
    const points = rate > 25 ? 15 : rate > 10 ? 8 : 0
    drivers.push({
      rule: 'Attendance anomalies',
      points,
      detail: `attendance exception rate ${rate}% (${exceptions} of ${recent.length} records, last 14 days)`,
    })
  }

  const raw = drivers.reduce((sum, d) => sum + d.points, 0)
  const score = Math.max(0, Math.min(100, raw))
  return { hasData: drivers.length > 0, score, band: bandFor(score), drivers }
}

/** action=recompute — deterministic Verification Risk over live data, upserted. */
export async function recomputeRiskAssessment(projectId: string, actor: MjengoSessionUser) {
  if (!projectId) badRequest('projectId required')
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) notFound('Project not found')

  const computed = await computeProjectRisk(projectId)

  // HONESTY: no rule had ANY data → say so, write nothing, invent nothing.
  if (!computed.hasData) {
    await logAudit(projectId, 'intel', actor, 'Verification Risk recompute attempted — not enough verified data to score', {
      insufficient: true,
    })
    return { ok: true, insufficient: true, assessment: null }
  }

  const prev = await db.riskAssessment.findFirst({
    where: { projectId, entityType: 'project' },
    orderBy: { updatedAt: 'desc' },
  })
  const data = {
    entityType: 'project',
    entityName: project.name,
    score: computed.score,
    band: computed.band,
    factors: JSON.stringify(computed.drivers), // drivers live in the model's string field
    updatedAt: new Date(), // schema has @default(now()), not @updatedAt — stamp it ourselves
  }
  const assessment = prev
    ? await db.riskAssessment.update({ where: { id: prev.id }, data })
    : await db.riskAssessment.create({ data: { ...data, projectId } })

  await logAudit(projectId, 'intel', actor, `Verification Risk recomputed: ${prev ? `${prev.score} (${prev.band})` : 'no prior score'} → ${assessment.score} (${assessment.band})`, {
    from: prev?.score ?? null,
    to: assessment.score,
    drivers: computed.drivers,
  })
  return { ok: true, insufficient: false, assessment }
}

/** action=digest — compile the last 7 days of real records into an IntelDigest. */
export async function generateIntelDigest(projectId: string, actor: MjengoSessionUser) {
  if (!projectId) badRequest('projectId required')
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) notFound('Project not found')

  const since = new Date(Date.now() - 7 * 86400_000)
  const [orders, signals, risk] = await Promise.all([
    db.supplyOrder.findMany({ where: { projectId } }),
    db.riskSignal.findMany({ where: { projectId } }),
    computeProjectRisk(projectId),
  ])

  // Real counts from the last 7 days only — an order counts if any of its
  // lifecycle timestamps (created / delivered / verified) falls in the window.
  const inWindow = (d: Date | null) => d != null && d >= since
  const touched = orders.filter((o) => inWindow(o.createdAt) || inWindow(o.deliveredAt) || inWindow(o.verifiedAt))
  const verified = touched.filter((o) => o.status === 'verified').length
  const mismatched = touched.filter((o) => o.status === 'mismatch').length
  const awaiting = touched.filter((o) => o.status === 'delivered').length
  const placed = touched.filter((o) => o.status === 'ordered').length

  const opened = signals.filter((s) => s.detectedAt >= since).length
  const resolved = signals.filter((s) => inWindow(s.resolvedAt)).length
  const stillOpen = signals.filter((s) => s.status === 'open').length

  const headline = `Weekly site intel — w/c ${weekCommencing()}`

  // Previous digest = newest other row; trend compares mapped risk levels.
  const prev = await db.intelDigest.findFirst({
    where: { projectId, headline: { not: headline } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  })
  const LEVEL_RANK: Record<string, number> = { low: 0, elevated: 1, high: 2 }
  const BAND_TO_LEVEL: Record<string, string> = { low: 'low', medium: 'elevated', high: 'high' }
  const nowLevel = risk.hasData ? BAND_TO_LEVEL[risk.band] : null
  const prevLevel = prev?.riskLevel ?? null
  const trend =
    nowLevel == null || prevLevel == null
      ? 'no prior digest to compare'
      : LEVEL_RANK[nowLevel] < LEVEL_RANK[prevLevel]
        ? 'improving'
        : LEVEL_RANK[nowLevel] > LEVEL_RANK[prevLevel]
          ? 'worsening'
          : 'stable'

  // Summary assembled from the real numbers above — nothing else.
  const lines: string[] = [
    `Supply this week: ${verified} deliveries verified, ${mismatched} mismatched, ${awaiting} awaiting verification check, ${placed} orders placed.`,
    `Signals this week: ${opened} opened, ${resolved} resolved — ${stillOpen} still open right now.`,
  ]
  if (risk.hasData) {
    lines.push(`Verification Risk: ${risk.score} (${risk.band}) — ${trend} vs the previous digest${prev ? ` (${prev.riskLevel})` : ''}.`)
    const top = [...risk.drivers].sort((a, b) => b.points - a.points).slice(0, 3)
    if (top.length > 0) {
      lines.push('Top drivers:')
      for (const d of top) lines.push(`· ${d.rule} — ${d.detail} (+${d.points})`)
    }
  } else {
    lines.push('Verification Risk: not enough verified data to compute a score yet — record deliveries and attendance first.')
  }
  const body = lines.join('\n')

  // riskLevel is required by the model; with no computable score we keep the
  // neutral default 'low' and the body states plainly why (no fabricated level).
  const riskLevel = risk.hasData ? BAND_TO_LEVEL[risk.band] : 'low'

  // Upsert by headline: same week → same row, re-generation just refreshes it.
  const existing = await db.intelDigest.findFirst({ where: { projectId, headline } })
  const digestData = { date: eatToday(), headline, body, riskLevel }
  const digest = existing
    ? await db.intelDigest.update({ where: { id: existing.id }, data: { ...digestData, createdAt: new Date() } })
    : await db.intelDigest.create({ data: { ...digestData, projectId } })

  await logAudit(projectId, 'intel', actor, `Weekly intel digest generated — Verification Risk ${risk.hasData ? `${risk.score} (${risk.band}), ${trend}` : 'not computable (insufficient data)'}`, {
    deliveriesVerified: verified,
    deliveriesMismatched: mismatched,
    signalsOpened: opened,
    signalsResolved: resolved,
    trend,
  })
  return { ok: true, digest }
}

/** GET payload: signals, digests, assessments + the live evidence stats. */
export async function getIntelData(projectId: string) {
  if (!projectId) badRequest('projectId required')

  const [signals, digests, assessments, attendance, milestones] = await Promise.all([
    db.riskSignal.findMany({ where: { projectId }, orderBy: { detectedAt: 'desc' } }),
    db.intelDigest.findMany({ where: { projectId }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
    db.riskAssessment.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' } }),
    db.attendance.findMany({ where: { projectId }, select: { verification: true } }),
    db.milestone.findMany({ where: { projectId }, select: { status: true, evidencePhotoIds: true } }),
  ])

  const total = attendance.length
  const verified = attendance.filter((a) => a.verification === 'verified').length
  const reported = attendance.filter((a) => a.verification === 'reported').length
  const exception = attendance.filter((a) => a.verification === 'exception').length
  const withEvidence = milestones.filter((m) => m.evidencePhotoIds && m.evidencePhotoIds !== '[]').length
  const released = milestones.filter((m) => m.status === 'released').length
  const open = signals.filter((s) => s.status === 'open')
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0)

  // Project-level Verification Risk (entityType 'project', written by the
  // recompute engine). Additive key — existing consumers keep working.
  const projectRow = assessments.find((a) => a.entityType === 'project') ?? null

  return {
    signals,
    digests,
    assessments,
    risk: projectRow
      ? {
          score: projectRow.score,
          band: projectRow.band,
          computedAt: projectRow.updatedAt,
          drivers: parseDrivers(projectRow.factors),
        }
      : null,
    live: {
      attendance: {
        total,
        verified,
        reported,
        exception,
        verifiedPct: pct(verified),
      },
      milestones: { total: milestones.length, withEvidence, released },
      signals: {
        high: open.filter((s) => s.severity === 'high').length,
        medium: open.filter((s) => s.severity === 'medium').length,
        low: open.filter((s) => s.severity === 'low').length,
      },
    },
  }
}

/** action=signal.ack / signal.resolve — a human decision on a detected signal. */
export async function updateSignal(body: Record<string, unknown>, actor: MjengoSessionUser) {
  const action = String(body.action ?? '')
  const id = fieldStr(body.id, 'Signal id required')
  const signal = await db.riskSignal.findUnique({ where: { id } })
  if (!signal) notFound('Signal not found')

  const updated = await db.riskSignal.update({
    where: { id },
    data:
      action === 'signal.ack'
        ? { status: 'acknowledged' }
        : { status: 'resolved', resolvedAt: new Date() },
  })

  const verb = action === 'signal.ack' ? 'Acknowledged' : 'Resolved'
  await logAudit(signal.projectId, 'intel', actor, `${verb} signal: ${signal.title}`)
  return { ok: true, signal: updated }
}
