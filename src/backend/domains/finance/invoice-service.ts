import { db } from '@/lib/db'
import type { MjengoSessionUser } from '@/lib/auth'
import { accessDenied, badRequest, fieldPos, fieldStr, notFound, optionalId } from '@/backend/core/http'
import { logAudit } from '@/backend/core/audit'

/**
 * Invoice lifecycle service — a request for payment with human approval.
 *
 * LIFECYCLE (state machine — every transition is audit-logged):
 *
 *   draft ──submit──▶ submitted ──decide──▶ approved ──markPaid──▶ paid
 *                        │
 *                        └──decide──▶ rejected (terminal)
 *
 * RULES (documented, enforced here — the route is a thin controller)
 *  · create / updateDraft / submit / markPaid — site team (contractor/admin)
 *    only. A hidden button is UI; this check is the security.
 *  · decide — the CLIENT (the payer; this is their decision surface) and
 *    admin only. The contractor never approves their own invoice.
 *  · Drafts are editable; once submitted the content freezes — the client
 *    approves exactly what was submitted, nothing else.
 *  · Client role is pinned to their own project: a foreign invoice id is
 *    answered with a plain 404 (indistinguishable from an invalid id).
 *  · Client role sees ONLY submitted / approved / paid — never draft or
 *    rejected internals.
 *  · "paid" means a HUMAN recorded a payment reference (the M-Pesa code from
 *    their statement). The system never claims a provider settled funds —
 *    markPaid writes the matching Transaction row so the ledger stays the
 *    single source of truth.
 *  · Nothing is ever auto-approved or auto-paid.
 */

const CATEGORIES = ['materials', 'labour', 'professional', 'transport', 'other'] as const

/** Ledger Transaction.type for each invoice category. */
const CATEGORY_TX_TYPE: Record<string, string> = {
  materials: 'material',
  labour: 'wage',
  transport: 'transport',
  professional: 'other',
  other: 'other',
}

/** The only states a client-role session may ever see. */
const CLIENT_STATUSES = ['submitted', 'approved', 'paid']

const SITE_TEAM = ['contractor', 'admin']

function kes(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

function categoryOf(value: unknown): string {
  const c = String(value ?? '').trim()
  if (!(CATEGORIES as readonly string[]).includes(c)) {
    badRequest('Category must be materials, labour, professional, transport or other')
  }
  return c
}

function decisionOf(value: unknown): 'approve' | 'reject' {
  const d = String(value ?? '').trim()
  if (d !== 'approve' && d !== 'reject') badRequest('Decision must be approve or reject')
  return d
}

/** Site-team-only mutations (create/updateDraft/submit/markPaid). */
function requireSiteTeam(actor: MjengoSessionUser): void {
  if (!SITE_TEAM.includes(actor.role)) {
    accessDenied(`Not permitted for role "${actor.role}"`)
  }
}

/** Load an invoice; client-role callers get a plain 404 for foreign projects. */
async function loadInvoice(id: string, actor: MjengoSessionUser) {
  const invoice = await db.invoice.findUnique({ where: { id } })
  if (!invoice) notFound('Invoice not found')
  if (actor.role === 'client' && invoice.projectId !== actor.projectId) {
    notFound('Invoice not found')
  }
  return invoice
}

/* ------------------------------------------------------------------ *
 * GET — role-based list                                              *
 * ------------------------------------------------------------------ */

/**
 * List invoices.
 *  · site team — every invoice, optionally narrowed by ?projectId=
 *  · client — ONLY their own project's submitted / approved / paid rows
 */
export async function listInvoices(actor: MjengoSessionUser, projectId: string | null) {
  const where =
    actor.role === 'client'
      ? { projectId: actor.projectId ?? 'none', status: { in: CLIENT_STATUSES } }
      : projectId
        ? { projectId }
        : undefined
  const invoices = await db.invoice.findMany({ where, orderBy: { createdAt: 'desc' } })
  return {
    invoices,
    /** Server-truth affordances — the UI shows buttons from these, the API enforces them. */
    viewer: {
      role: actor.role,
      canManage: SITE_TEAM.includes(actor.role),
      canDecide: actor.role === 'client' || actor.role === 'admin',
    },
  }
}

/* ------------------------------------------------------------------ *
 * Mutations                                                          *
 * ------------------------------------------------------------------ */

/** action=create — site team drafts an invoice (status starts at draft). */
export async function createInvoice(body: Record<string, unknown>, actor: MjengoSessionUser) {
  requireSiteTeam(actor)
  const projectId = fieldStr(body.projectId, 'Project is required')
  const number = fieldStr(body.number, 'Invoice number is required')
  const description = fieldStr(body.description, 'Description is required')
  const category = categoryOf(body.category)
  const amount = fieldPos(body.amount, 'Amount must be greater than 0')
  const dueDate = optionalId(body.dueDate)
  const supplyOrderId = optionalId(body.supplyOrderId)

  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) notFound('Project not found')

  const invoice = await db.invoice.create({
    data: {
      projectId,
      number,
      description,
      category,
      amount,
      status: 'draft',
      dueDate: dueDate ? new Date(dueDate) : null,
      supplyOrderId,
    },
  })

  await logAudit(projectId, 'invoice', actor, `Invoice ${number} drafted — ${description} (${kes(amount)})`)
  return { ok: true, invoice }
}

/** action=updateDraft — site team edits a draft; submitted content is frozen. */
export async function updateDraft(body: Record<string, unknown>, actor: MjengoSessionUser) {
  requireSiteTeam(actor)
  const invoiceId = fieldStr(body.invoiceId, 'Invoice id required')
  const invoice = await loadInvoice(invoiceId, actor)
  if (invoice.status !== 'draft') {
    badRequest(`Only draft invoices can be edited (this one is ${invoice.status})`)
  }

  const data: Record<string, unknown> = {}
  if (body.number !== undefined) data.number = fieldStr(body.number, 'Invoice number is required')
  if (body.description !== undefined) data.description = fieldStr(body.description, 'Description is required')
  if (body.category !== undefined) data.category = categoryOf(body.category)
  if (body.amount !== undefined) data.amount = fieldPos(body.amount, 'Amount must be greater than 0')
  if (body.dueDate !== undefined) data.dueDate = optionalId(body.dueDate) ? new Date(String(body.dueDate)) : null
  if (body.supplyOrderId !== undefined) data.supplyOrderId = optionalId(body.supplyOrderId)

  const updated = await db.invoice.update({ where: { id: invoice.id }, data })
  await logAudit(invoice.projectId, 'invoice', actor, `Invoice ${updated.number} draft updated — ${updated.description} (${kes(updated.amount)})`)
  return { ok: true, invoice: updated }
}

/**
 * action=submit — draft → submitted. Stamps submittedBy from the session
 * and notifies the project's client that a decision is waiting.
 */
export async function submitInvoice(body: Record<string, unknown>, actor: MjengoSessionUser) {
  requireSiteTeam(actor)
  const invoiceId = fieldStr(body.invoiceId, 'Invoice id required')
  const invoice = await loadInvoice(invoiceId, actor)
  if (invoice.status !== 'draft') {
    badRequest(`Only draft invoices can be submitted (this one is ${invoice.status})`)
  }

  const project = await db.project.findUnique({ where: { id: invoice.projectId } })
  const updated = await db.invoice.update({
    where: { id: invoice.id },
    data: { status: 'submitted', submittedBy: actor.name, submittedAt: new Date() },
  })

  await db.notification.create({
    data: {
      projectId: invoice.projectId,
      kind: 'invoice',
      title: `Invoice ${invoice.number} submitted for approval`,
      body: `${kes(invoice.amount)} — ${invoice.description}. Awaiting the client's decision.`,
      recipient: project?.client ?? null,
    },
  })

  await logAudit(invoice.projectId, 'invoice', actor, `Invoice ${invoice.number} submitted for approval — ${kes(invoice.amount)} awaiting ${project?.client ?? 'the client'}`)
  return { ok: true, invoice: updated }
}

/**
 * action=decide — submitted → approved | rejected.
 * Client (the payer) and admin only — the contractor cannot grade their
 * own invoice. decidedBy/decidedAt are stamped from the session; the note
 * comes from the body and lands in the decision history.
 */
export async function decideInvoice(body: Record<string, unknown>, actor: MjengoSessionUser) {
  if (actor.role !== 'client' && actor.role !== 'admin') {
    accessDenied('Only the client (payer) or an admin can decide invoices')
  }
  const invoiceId = fieldStr(body.invoiceId, 'Invoice id required')
  const decision = decisionOf(body.decision)
  const invoice = await loadInvoice(invoiceId, actor)
  if (invoice.status !== 'submitted') {
    badRequest(`Only submitted invoices can be decided (this one is ${invoice.status})`)
  }
  const note = String(body.note ?? '').trim() || null

  const status = decision === 'approve' ? 'approved' : 'rejected'
  const updated = await db.invoice.update({
    where: { id: invoice.id },
    data: { status, decidedBy: actor.name, decidedAt: new Date(), decisionNote: note },
  })

  const project = await db.project.findUnique({ where: { id: invoice.projectId } })
  await db.notification.create({
    data: {
      projectId: invoice.projectId,
      kind: 'invoice',
      title: `Invoice ${invoice.number} ${status}`,
      body:
        status === 'approved'
          ? `${kes(invoice.amount)} approved for payment by ${actor.name}. The site team records the payment reference when it settles.`
          : `${kes(invoice.amount)} rejected by ${actor.name}${note ? ` — “${note}”` : ''}`,
      recipient: project?.client ?? null,
    },
  })

  await logAudit(invoice.projectId, 'invoice', actor, `Invoice ${invoice.number} ${status} by ${actor.name}${note ? ` — “${note}”` : ''}`)
  return { ok: true, invoice: updated }
}

/**
 * action=markPaid — approved → paid. Site team only.
 * The caller supplies paidReference (the M-Pesa code a human received); the
 * system records it, stamps paidAt, and writes the matching Transaction so
 * the ledger remains the single source of truth. It NEVER claims a provider
 * settled funds — "paid" means a human vouched with a reference.
 */
export async function markPaid(body: Record<string, unknown>, actor: MjengoSessionUser) {
  requireSiteTeam(actor)
  const invoiceId = fieldStr(body.invoiceId, 'Invoice id required')
  const paidReference = fieldStr(body.paidReference, 'Enter the M-Pesa payment reference')
  const invoice = await loadInvoice(invoiceId, actor)
  if (invoice.status !== 'approved') {
    badRequest(`Only approved invoices can be marked paid (this one is ${invoice.status})`)
  }

  const now = new Date()
  const txType = CATEGORY_TX_TYPE[invoice.category] ?? 'other'
  const [updated, transaction] = await db.$transaction(async (tx) => {
    const updatedInvoice = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'paid', paidAt: now, paidReference },
    })
    const created = await tx.transaction.create({
      data: {
        projectId: invoice.projectId,
        type: txType,
        amount: invoice.amount,
        method: 'mpesa',
        reference: paidReference,
        note: `Invoice ${invoice.number} — ${invoice.description}`,
        date: now,
      },
    })
    return [updatedInvoice, created]
  })

  await logAudit(
    invoice.projectId,
    'invoice',
    actor,
    `Invoice ${invoice.number} marked paid — M-Pesa ref ${paidReference} recorded by ${actor.name}; ledger entry ${kes(invoice.amount)} (${txType}) created`,
  )
  return { ok: true, invoice: updated, transaction }
}
