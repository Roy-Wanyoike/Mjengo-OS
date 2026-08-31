// MjengoPay money & governance actions — escrow wallet, milestones with proof-of-work,
// variation orders. Dispatched from lib/mjengo.ts applyAction(), which auto-writes the
// AuditEvent for every success — never log manually here.
//
// Rules of the house:
//  - Money never moves without photo proof (requestRelease requires ≥1 evidence photo).
//  - Only the client decides releases and variations (decide actions are client actions).
//  - A release both debits the escrow wallet and writes a Transaction (type 'milestone').

import { db } from '@/lib/db'

export const MONEY_ACTIONS = [
  'escrow.topup', // { amount>0, method? ('mpesa'|'bank'|'card'), reference? }
  'milestone.create', // { name, amount, phaseId? }
  'milestone.evidence', // { id, photoIds: string[] } — proof-of-work gate
  'milestone.requestRelease', // { id } — requires ≥1 evidence photo
  'milestone.decide', // { id, decision: 'approve'|'reject', by, note? } — release moves escrow → transaction
  'variation.submit', // { title, description, budgetImpact, phaseId?, submittedBy? }
  'variation.decide', // { id, decision: 'approve'|'reject', by, note? } — approve adjusts phase budget
] as const

// ---------------- helpers ----------------

function kes(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

/** Parse the JSON evidencePhotoIds column safely. */
function parseEvidenceIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Auto reference like MPESA-7XK2P4QA when the client doesn't supply one. */
function autoReference(method: string): string {
  const prefix = method === 'bank' ? 'BANK' : method === 'card' ? 'CARD' : 'MPESA'
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let suffix = ''
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
  return `${prefix}-${suffix}`
}

function posNumber(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

async function resolvePhase(phaseId: unknown, projectId: string): Promise<string | null> {
  if (!phaseId || typeof phaseId !== 'string') return null
  const phase = await db.phase.findFirst({ where: { id: phaseId, projectId } })
  if (!phase) throw new Error('Phase not found in this project')
  return phase.id
}

// ---------------- dispatcher ----------------

export async function applyMoneyAction(type: string, payload: any, projectId: string): Promise<any> {
  switch (type) {
    case 'escrow.topup': {
      const amount = posNumber(payload?.amount)
      if (amount === null) throw new Error('Top-up amount must be a number greater than zero')
      const method = ['mpesa', 'bank', 'card'].includes(payload?.method) ? String(payload.method) : 'mpesa'
      const reference =
        typeof payload?.reference === 'string' && payload.reference.trim()
          ? payload.reference.trim()
          : autoReference(method)
      const wallet = await db.escrowWallet.upsert({
        where: { projectId },
        create: { projectId, balance: amount },
        update: { balance: { increment: amount } },
      })
      return { balance: wallet.balance, reference }
    }

    case 'milestone.create': {
      const name = String(payload?.name ?? '').trim()
      if (!name) throw new Error('Milestone name required')
      const amount = posNumber(payload?.amount)
      if (amount === null) throw new Error('Milestone amount must be a number greater than zero')
      const phaseId = await resolvePhase(payload?.phaseId, projectId)
      const milestone = await db.milestone.create({
        data: { projectId, phaseId, name, amount, status: 'locked' },
      })
      return { id: milestone.id }
    }

    case 'milestone.evidence': {
      const id = String(payload?.id ?? '')
      if (!id) throw new Error('Milestone id required')
      const photoIds = Array.isArray(payload?.photoIds) ? payload.photoIds.map((p: unknown) => String(p)) : []
      if (!photoIds.length) throw new Error('Select at least one photo as evidence')
      const milestone = await db.milestone.findFirst({ where: { id, projectId } })
      if (!milestone) throw new Error('Milestone not found in this project')
      if (!['locked', 'evidence_submitted'].includes(milestone.status)) {
        throw new Error(`Cannot attach evidence — milestone is already ${milestone.status.replace('_', ' ')}`)
      }
      const photos = await db.sitePhoto.findMany({ where: { projectId }, select: { id: true } })
      const valid = new Set(photos.map((p) => p.id))
      if (photoIds.some((pid: string) => !valid.has(pid))) {
        throw new Error('One or more photos do not belong to this project')
      }
      const merged = Array.from(new Set([...parseEvidenceIds(milestone.evidencePhotoIds), ...photoIds]))
      await db.milestone.update({
        where: { id },
        data: { evidencePhotoIds: JSON.stringify(merged), status: 'evidence_submitted' },
      })
      return { count: merged.length }
    }

    case 'milestone.requestRelease': {
      const id = String(payload?.id ?? '')
      if (!id) throw new Error('Milestone id required')
      const milestone = await db.milestone.findFirst({ where: { id, projectId } })
      if (!milestone) throw new Error('Milestone not found in this project')
      if (milestone.status !== 'evidence_submitted') {
        throw new Error('Attach proof-of-work photos first')
      }
      const evidence = parseEvidenceIds(milestone.evidencePhotoIds)
      if (!evidence.length) throw new Error('Attach proof-of-work photos first')
      const updated = await db.milestone.update({
        where: { id },
        data: { status: 'release_requested', requestedAt: new Date() },
      })
      const project = await db.project.findUnique({ where: { id: projectId } })
      await db.notification.create({
        data: {
          projectId,
          kind: 'milestone',
          title: `Release requested: ${milestone.name}`,
          body: `${project?.client ? 'Client' : 'Owner'} approval needed for ${kes(milestone.amount)} — ${evidence.length} evidence photo(s) attached`,
          recipient: project?.client ?? null,
        },
      })
      return { id: updated.id }
    }

    case 'milestone.decide': {
      const id = String(payload?.id ?? '')
      const decision = payload?.decision
      const by = String(payload?.by ?? '').trim()
      if (!id) throw new Error('Milestone id required')
      if (decision !== 'approve' && decision !== 'reject') throw new Error("decision must be 'approve' or 'reject'")
      if (!by) throw new Error('Decision maker (by) required')
      const milestone = await db.milestone.findFirst({ where: { id, projectId } })
      if (!milestone) throw new Error('Milestone not found in this project')
      if (milestone.status !== 'release_requested') throw new Error('Milestone is not awaiting a client decision')
      const note =
        typeof payload?.note === 'string' && payload.note.trim() ? payload.note.trim() : null

      if (decision === 'approve') {
        const wallet = await db.escrowWallet.findUnique({ where: { projectId } })
        if (!wallet || wallet.balance < milestone.amount) throw new Error('Insufficient escrow balance — top up first')
        const now = new Date()
        await db.milestone.update({
          where: { id },
          data: { status: 'released', decidedAt: now, decidedBy: by, decisionNote: note, releasedAt: now },
        })
        const updatedWallet = await db.escrowWallet.update({
          where: { projectId },
          data: { balance: { decrement: milestone.amount } },
        })
        await db.transaction.create({
          data: {
            projectId,
            type: 'milestone',
            amount: milestone.amount,
            method: 'escrow',
            reference: `MJP-${id.slice(-6)}`,
            note: `${milestone.name} released to contractor — approved by ${by}`,
            date: now,
          },
        })
        const project = await db.project.findUnique({ where: { id: projectId } })
        await db.notification.create({
          data: {
            projectId,
            kind: 'milestone',
            title: `Released: ${milestone.name}`,
            body: `${kes(milestone.amount)} released — approved by ${by}`,
            recipient: project?.client ?? null,
          },
        })
        return { id, balance: updatedWallet.balance }
      }

      // reject — no money moves, decision history preserved
      await db.milestone.update({
        where: { id },
        data: { status: 'rejected', decidedAt: new Date(), decidedBy: by, decisionNote: note },
      })
      const wallet = await db.escrowWallet.findUnique({ where: { projectId } })
      return { id, balance: wallet?.balance ?? 0 }
    }

    case 'variation.submit': {
      const title = String(payload?.title ?? '').trim()
      const description = String(payload?.description ?? '').trim()
      if (!title) throw new Error('Variation title required')
      if (!description) throw new Error('Variation description required')
      const budgetImpact = Number(payload?.budgetImpact)
      if (!Number.isFinite(budgetImpact) || budgetImpact === 0) {
        throw new Error('Budget impact must be a non-zero amount (positive for extra cost, negative for saving)')
      }
      const phaseId = await resolvePhase(payload?.phaseId, projectId)
      const submittedBy =
        typeof payload?.submittedBy === 'string' && payload.submittedBy.trim() ? payload.submittedBy.trim() : null
      const variation = await db.variationOrder.create({
        data: { projectId, phaseId, title, description, budgetImpact, status: 'submitted', submittedBy },
      })
      const project = await db.project.findUnique({ where: { id: projectId } })
      await db.notification.create({
        data: {
          projectId,
          kind: 'variation',
          title: `Variation: ${title}`,
          body: `Budget impact ${kes(budgetImpact)} — awaiting client decision`,
          recipient: project?.client ?? null,
        },
      })
      return { id: variation.id }
    }

    case 'variation.decide': {
      const id = String(payload?.id ?? '')
      const decision = payload?.decision
      const by = String(payload?.by ?? '').trim()
      if (!id) throw new Error('Variation id required')
      if (decision !== 'approve' && decision !== 'reject') throw new Error("decision must be 'approve' or 'reject'")
      if (!by) throw new Error('Decision maker (by) required')
      const variation = await db.variationOrder.findFirst({ where: { id, projectId } })
      if (!variation) throw new Error('Variation not found in this project')
      if (variation.status !== 'submitted') throw new Error('Variation is not awaiting a client decision')
      const note =
        typeof payload?.note === 'string' && payload.note.trim() ? payload.note.trim() : null

      if (decision === 'approve') {
        // Budget moves ONLY after client approval
        if (variation.phaseId) {
          const phase = await db.phase.findFirst({ where: { id: variation.phaseId, projectId } })
          if (phase) {
            await db.phase.update({
              where: { id: phase.id },
              data: { budget: Math.max(0, phase.budget + variation.budgetImpact) },
            })
          }
        }
        await db.project.update({
          where: { id: projectId },
          data: { budget: { increment: variation.budgetImpact } },
        })
        await db.variationOrder.update({
          where: { id },
          data: { status: 'approved', decidedBy: by, decidedAt: new Date(), decisionNote: note },
        })
        const project = await db.project.findUnique({ where: { id: projectId } })
        await db.notification.create({
          data: {
            projectId,
            kind: 'variation',
            title: `Variation approved: ${variation.title}`,
            body: `Budget ${variation.budgetImpact >= 0 ? 'increased' : 'reduced'} by ${kes(Math.abs(variation.budgetImpact))}`,
            recipient: project?.client ?? null,
          },
        })
        return { id }
      }

      // reject — budget untouched
      await db.variationOrder.update({
        where: { id },
        data: { status: 'rejected', decidedBy: by, decidedAt: new Date(), decisionNote: note },
      })
      return { id }
    }

    default:
      throw new Error(`Unknown money action: ${type}`)
  }
}
