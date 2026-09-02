// Intel module — service layer (DB orchestration around the pure engines).
//
// Deterministic intelligence over REAL project data — every number traceable
// to rows. Called from src/backend/actions/intel.ts:
//   - risk.recompute:      5 rules → RiskAssessment (history preserved)
//   - digest.generate:     weekly IntelDigest (upsert on the Monday weekStart)
//   - price.record:        manual PricePoint (+ price.alert event when it jumps)
//   - reliability.recompute: Supplier.reliabilityScore from actual history
//
// Intel describes patterns; humans decide. Findings never accuse.

import { db } from '@/backend/lib/db'
import { notify } from '@/backend/modules/notify/service'
import {
  computeReliability, computeRiskFindings, computePriceTrends, mondayOf, overallProgress,
  OPEN_ORDER_STATUSES, OPEN_REQUEST_STATUSES, RULE_VERSION, type SupplierOrderHistory,
  type EngineFinding, type PricePointLike, type RiskPhase,
} from './engine'
import type { DigestItem, ReliabilityResult, SupplierLike } from './types'

const DAY_MS = 86_400_000

function kes(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

// ---------------- risk.recompute ----------------

/** Re-run the 5 deterministic rules over the project's live rows. */
export async function recomputeRisk(projectId: string): Promise<{
  id: string
  overallScore: number
  findings: EngineFinding[]
  ruleVersion: string
}> {
  const now = new Date()
  const [project, phases, transactions, orders, pricePoints, attendances] = await Promise.all([
    db.project.findUnique({ where: { id: projectId } }),
    db.phase.findMany({ where: { projectId }, include: { tasks: true } }),
    db.transaction.findMany({ where: { projectId } }),
    db.purchaseOrder.findMany({
      where: { projectId },
      include: { deliveries: { include: { lines: true } } },
    }),
    db.pricePoint.findMany({ orderBy: { recordedAt: 'asc' } }),
    db.attendance.findMany({
      where: { projectId, date: { gte: new Date(now.getTime() - 10 * DAY_MS).toISOString().slice(0, 10) } },
    }),
  ])
  if (!project) throw new Error('Project not found')

  const riskPhases: RiskPhase[] = phases.map((p) => ({
    name: p.name,
    status: p.status,
    budget: p.budget,
    progressManual: p.progressManual,
    tasks: p.tasks.map((t) => ({ title: t.title, status: t.status, progress: t.progress, dueDate: t.dueDate })),
  }))

  const pointLikes: PricePointLike[] = pricePoints.map((p) => ({
    materialName: p.materialName,
    region: p.region,
    unitPrice: p.unitPrice,
    recordedAt: p.recordedAt,
    source: p.source,
  }))

  const { findings, overallScore } = computeRiskFindings({
    now,
    project: { location: project.location, targetDate: project.targetDate },
    phases: riskPhases,
    transactions: transactions.map((t) => ({ amount: t.amount })),
    orders: orders.map((o) => ({
      orderCode: o.orderCode,
      status: o.status,
      createdAt: o.createdAt,
      deliveries: o.deliveries.map((d) => ({
        status: d.status,
        dispatchedAt: d.dispatchedAt,
        receivedAt: d.receivedAt,
        lines: d.lines.map((l) => ({ qtyOrdered: l.qtyOrdered, qtyReceived: l.qtyReceived })),
      })),
    })),
    priceTrends: computePriceTrends(pointLikes, now),
    attendances: attendances.map((a) => ({ date: a.date, status: a.status })),
  })

  // History is preserved — every recompute appends a new row (latest wins in UI).
  const row = await db.riskAssessment.create({
    data: {
      projectId,
      computedAt: now,
      overallScore,
      findings: JSON.stringify(findings),
      ruleVersion: RULE_VERSION,
    },
  })
  return { id: row.id, overallScore, findings, ruleVersion: RULE_VERSION }
}

// ---------------- digest.generate ----------------

/** Generate (or regenerate) this week's IntelDigest — Monday-based weekStart. */
export async function generateDigest(projectId: string): Promise<{
  id: string
  weekStart: string
  summary: string
  items: DigestItem[]
}> {
  const now = new Date()
  const weekStart = mondayOf(now)

  const [project, phases, latestRisk, pricePoints, approvals, inTransit, discrepancies, milestones] = await Promise.all([
    db.project.findUnique({ where: { id: projectId } }),
    db.phase.findMany({ where: { projectId }, include: { tasks: true } }),
    db.riskAssessment.findFirst({ where: { projectId }, orderBy: { computedAt: 'desc' } }),
    db.pricePoint.findMany({ orderBy: { recordedAt: 'asc' } }),
    db.approval.count({ where: { projectId, decision: 'pending' } }),
    db.purchaseOrder.count({ where: { projectId, status: 'delivering' } }),
    db.orderDelivery.count({ where: { order: { projectId }, status: 'discrepancy' } }),
    db.milestone.findMany({ where: { projectId } }),
  ])
  if (!project) throw new Error('Project not found')

  const riskPhases: RiskPhase[] = phases.map((p) => ({
    name: p.name,
    status: p.status,
    budget: p.budget,
    progressManual: p.progressManual,
    tasks: p.tasks.map((t) => ({ title: t.title, status: t.status, progress: t.progress, dueDate: t.dueDate })),
  }))

  // --- price movements per material (min–max delta across regions) ---
  const trends = computePriceTrends(
    pricePoints.map((p) => ({
      materialName: p.materialName, region: p.region, unitPrice: p.unitPrice, recordedAt: p.recordedAt, source: p.source,
    })),
    now,
  )
  const byMaterial = new Map<string, typeof trends>()
  for (const row of trends) {
    const arr = byMaterial.get(row.materialName) ?? []
    arr.push(row)
    byMaterial.set(row.materialName, arr)
  }

  const items: DigestItem[] = []

  // --- risk ---
  let riskScore: number | null = null
  if (latestRisk) {
    riskScore = latestRisk.overallScore
    items.push({
      kind: 'risk',
      title: `Risk score ${latestRisk.overallScore}/100`,
      detail: `Computed ${latestRisk.computedAt.toISOString().slice(0, 10)} (rule set v${latestRisk.ruleVersion.replace(/^v/, '')}). ${
        JSON.parse(latestRisk.findings || '[]').length
      } rule finding(s) on record — open the Intel tab for the breakdown.`,
    })
  } else {
    items.push({ kind: 'risk', title: 'No risk assessment yet', detail: 'Run "Recompute now" on the Intel tab to produce one.' })
  }

  // --- price movements ---
  for (const [material, rows] of byMaterial) {
    const deltas = rows.map((r) => r.deltaPct).filter((d): d is number => d !== null)
    if (deltas.length === 0) continue
    const min = Math.min(...deltas)
    const max = Math.max(...deltas)
    const span = min === max ? `${min > 0 ? '+' : ''}${min.toFixed(1)}%` : `${min.toFixed(1)}% to +${max.toFixed(1)}%`
    items.push({
      kind: 'price_trend',
      title: `${material} ${span} over ~30d`,
      detail: rows.map((r) => `${r.region} ${kes(r.current)}`).join(' · ') + ' — from platform price history.',
    })
  }

  // --- procurement counts ---
  const pendingApprovals = approvals
  const procurementBits: string[] = []
  if (pendingApprovals > 0) procurementBits.push(`${pendingApprovals} approval${pendingApprovals > 1 ? 's' : ''} pending`)
  if (inTransit > 0) procurementBits.push(`${inTransit} order${inTransit > 1 ? 's' : ''} in transit`)
  if (discrepancies > 0) procurementBits.push(`${discrepancies} delivery discrepanc${discrepancies > 1 ? 'ies' : 'y'}`)
  items.push({
    kind: 'procurement',
    title: procurementBits.length > 0 ? procurementBits.join(' · ') : 'No open procurement items',
    detail: 'Counts straight from the request, order and delivery tables for this project.',
  })

  // --- milestones ---
  const activePhase = riskPhases.find((p) => p.status === 'in_progress')
  const releaseRequested = milestones.filter((m) => m.status === 'release_requested').length
  const released = milestones.filter((m) => m.status === 'released').length
  items.push({
    kind: 'milestone',
    title: releaseRequested > 0
      ? `${releaseRequested} milestone release${releaseRequested > 1 ? 's' : ''} awaiting decision`
      : `${released} milestone${released === 1 ? '' : 's'} released`,
    detail: (activePhase ? `${activePhase.name} is the active phase. ` : '') + `${milestones.length} milestones tracked.`,
  })

  // --- summary sentence (deterministic join of the parts) ---
  const progress = overallProgress(riskPhases)
  const parts: string[] = []
  parts.push(`progress ${progress}%`)
  if (riskScore !== null) parts.push(`risk ${riskScore}/100`)
  if (deltasOf(byMaterial).length > 0) parts.push(`${deltasOf(byMaterial).slice(0, 2).join(', ')} over ~30d`)
  if (procurementBits.length > 0) parts.push(procurementBits.join(', '))
  if (releaseRequested > 0) parts.push(`${releaseRequested} release decision(s) pending`)
  const summary = `Week of ${weekStart}: ${parts.join(' · ')}.`

  const payload = { weekStart, summary, items: JSON.stringify(items) }
  const existing = await db.intelDigest.findFirst({ where: { projectId, weekStart } })
  const row = existing
    ? await db.intelDigest.update({ where: { id: existing.id }, data: { ...payload, createdAt: now } })
    : await db.intelDigest.create({ data: { projectId, ...payload } })

  // A-2-lite event row so the notification center surfaces the weekly digest.
  await notify(projectId, `Weekly digest ready — week of ${weekStart}`, summary, {
    kind: 'digest.weekly',
    audienceRole: 'all',
  })

  return { id: row.id, weekStart, summary, items }
}

function deltasOf(byMaterial: Map<string, Array<{ deltaPct: number | null; materialName: string }>>): string[] {
  const out: string[] = []
  for (const [material, rows] of byMaterial) {
    const deltas = rows.map((r) => r.deltaPct).filter((d): d is number => d !== null)
    if (deltas.length === 0) continue
    const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length
    out.push(`${material.toLowerCase()} ${avg > 0 ? '+' : ''}${avg.toFixed(1)}%`)
  }
  return out
}

// ---------------- price.record ----------------

/** Record a manual price observation → PricePoint row (source MANUAL). */
export async function recordPrice(
  projectId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; materialName: string; region: string; unitPrice: number }> {
  const materialName = String(payload?.materialName ?? '').trim()
  const region = String(payload?.region ?? '').trim()
  const unitPrice = Number(payload?.unitPrice)
  if (!materialName) throw new Error('Material name required')
  if (!region) throw new Error('Region required')
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error('Unit price must be a number greater than zero')

  const row = await db.pricePoint.create({
    data: { materialName, region, unitPrice: Math.round(unitPrice * 100) / 100, source: 'manual' },
  })

  // Deterministic event: if this manual observation is >5% above the most
  // recent point recorded ≥30 days ago, emit a price.alert for the project.
  const cutoff = new Date(Date.now() - 30 * DAY_MS)
  const history = await db.pricePoint.findMany({
    where: { materialName, region },
    orderBy: { recordedAt: 'asc' },
  })
  const prevPoint = [...history].reverse().find((p) => p.recordedAt.getTime() <= cutoff.getTime())
  if (prevPoint && prevPoint.unitPrice > 0) {
    const deltaPct = ((unitPrice - prevPoint.unitPrice) / prevPoint.unitPrice) * 100
    if (deltaPct > 5) {
      await notify(
        projectId,
        `${materialName} price up ${deltaPct.toFixed(1)}% in ${region}`,
        `A manual observation recorded ${kes(unitPrice)} against ${kes(prevPoint.unitPrice)} ~30 days ago (more than +5%). Consider scheduling the next order early.`,
        { kind: 'price.alert', audienceRole: 'all' },
      )
    }
  }

  return { id: row.id, materialName, region, unitPrice: row.unitPrice }
}

// ---------------- reliability.recompute ----------------

/**
 * Recompute supplier reliability from ACTUAL platform transaction history.
 * NO anonymous ratings — spec §16. `supplierId` omitted = every supplier.
 */
export async function recomputeReliability(
  projectId: string,
  payload: Record<string, unknown>,
): Promise<{ results: ReliabilityResult[]; updated: number }> {
  const supplierId = typeof payload?.supplierId === 'string' && payload.supplierId.trim() ? payload.supplierId.trim() : null

  const suppliers = await db.supplier.findMany(supplierId ? { where: { id: supplierId } } : undefined)
  if (supplierId && suppliers.length === 0) throw new Error('Supplier not found')

  // Supplier history is GLOBAL (a supplier serves many projects) — pull every
  // order of the supplier(s) with their deliveries + per-line counts.
  const orders = await db.purchaseOrder.findMany({
    where: supplierId ? { supplierId } : undefined,
    include: { deliveries: { include: { lines: true } } },
  })

  const results: ReliabilityResult[] = []
  for (const supplier of suppliers) {
    const history: SupplierOrderHistory[] = orders
      .filter((o) => o.supplierId === supplier.id)
      .map((o) => ({
        status: o.status,
        createdAt: o.createdAt,
        deliveries: o.deliveries.map((d) => ({
          status: d.status,
          dispatchedAt: d.dispatchedAt,
          receivedAt: d.receivedAt,
          lines: d.lines.map((l) => ({ qtyOrdered: l.qtyOrdered, qtyReceived: l.qtyReceived })),
        })),
      }))
    const supplierLike: SupplierLike = {
      id: supplier.id,
      businessName: supplier.businessName,
      county: supplier.county,
      responseHours: supplier.responseHours,
      reliabilityScore: supplier.reliabilityScore,
    }
    const breakdown = computeReliability(supplierLike, history)
    await db.supplier.update({ where: { id: supplier.id }, data: { reliabilityScore: breakdown.score } })
    results.push({ ...breakdown, updated: true })
  }

  return { results, updated: results.length }
}

// ---------------- read-side helpers (used by the repository) ----------------

/** Trends + open-cover suggestions for a project — shared by repository + UI. */
export async function priceTrends(): Promise<ReturnType<typeof computePriceTrends>> {
  const pricePoints = await db.pricePoint.findMany({ orderBy: { recordedAt: 'asc' } })
  return computePriceTrends(
    pricePoints.map((p) => ({
      materialName: p.materialName, region: p.region, unitPrice: p.unitPrice, recordedAt: p.recordedAt, source: p.source,
    })),
    new Date(),
  )
}

/** Open request/PO docs (with lines) for the cover check — §19 lite. */
export async function openProcurementDocs(projectId: string) {
  const [requests, orders] = await Promise.all([
    db.materialRequest.findMany({
      where: { projectId, status: { in: [...OPEN_REQUEST_STATUSES] } },
      include: { lines: true },
    }),
    db.purchaseOrder.findMany({
      where: { projectId, status: { in: [...OPEN_ORDER_STATUSES] } },
      include: { lines: true },
    }),
  ])
  return [
    ...requests.map((r) => ({
      code: r.requestCode,
      kind: 'request' as const,
      status: r.status,
      lines: r.lines.map((l) => ({ materialName: l.materialName, qty: l.qty, unit: l.unit })),
    })),
    ...orders.map((o) => ({
      code: o.orderCode,
      kind: 'order' as const,
      status: o.status,
      lines: o.lines.map((l) => ({ materialName: l.name, qty: l.qty, unit: l.unit })),
    })),
  ]
}

/** Reliability breakdowns for every supplier (read-side, no writes). */
export async function reliabilityBreakdowns(): Promise<Array<ReturnType<typeof computeReliability>>> {
  const [suppliers, orders] = await Promise.all([
    db.supplier.findMany({ orderBy: { businessName: 'asc' } }),
    db.purchaseOrder.findMany({ include: { deliveries: { include: { lines: true } } } }),
  ])
  return suppliers.map((supplier) =>
    computeReliability(
      {
        id: supplier.id,
        businessName: supplier.businessName,
        county: supplier.county,
        responseHours: supplier.responseHours,
        reliabilityScore: supplier.reliabilityScore,
      },
      orders
        .filter((o) => o.supplierId === supplier.id)
        .map((o) => ({
          status: o.status,
          createdAt: o.createdAt,
          deliveries: o.deliveries.map((d) => ({
            status: d.status,
            dispatchedAt: d.dispatchedAt,
            receivedAt: d.receivedAt,
            lines: d.lines.map((l) => ({ qtyOrdered: l.qtyOrdered, qtyReceived: l.qtyReceived })),
          })),
        })),
    ),
  )
}
