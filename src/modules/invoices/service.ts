// Invoices module — service layer (agent 2-d).
//
// Supplier invoice lifecycle, called from src/lib/actions/invoices.ts:
//   - create/update draft invoices (from a PO or standalone); every total is
//     recomputed server-side — client sums are never trusted
//   - submit to the client decision queue (+ Notification row)
//   - decide (approve/reject) — decisions belong to the CLIENT role; the role
//     is resolved from the signed-in session (modules/invoices/session.ts),
//     never from the payload, so a contractor attempting a decision fails
//     with a clear server-side message
//   - disputes: there is no dispute action in the INVOICE_ACTIONS tuple, so
//     disputes ride `invoice.update` { id, status: 'disputed', note } while
//     SUBMITTED/APPROVED (client-role gated) — documented, UI badge 'DISPUTED'
//   - record payment (method + reference) → exactly ONE Transaction ledger
//     entry, mirroring money.ts conventions: type 'invoice' (peer of
//     'milestone'), method, auto reference (MPESA-XXXXXXXX style), note
//     referencing the invoice code + PO code, date. method 'wallet' debits
//     the escrow wallet exactly like milestone.decide does (balance checked
//     first); external rails never touch the wallet. The wallet is NOT a
//     bank — it records money movement, it never custodies it.
//   - 3-way match (PO vs invoice vs delivery): warn-only — payment still
//     succeeds when the payer explicitly acknowledges the discrepancy
//     (acknowledgeMismatch: true), and that human decision is recorded in
//     the Approval trail + the Bias-Free Ledger (applyAction logs every
//     dispatch). AI/system recommends; an authorized human decides.
//   - A-1-lite ledger consistency: read-only recomputation from the
//     Transaction ledger (three-way.ts) — never mutates wallet values.
//
// Money rules: approvals before payment are enforced server-side (invoice
// must be APPROVED before invoice.pay succeeds); the Transaction ledger is
// append-only thinking — rows are written, never mutated or deleted here.
//
// Every mutation returns a plain object; applyAction() writes the AuditEvent.

import { db } from '@/lib/db'
import { currentActor } from './session'
import { computeLedgerConsistency, matchThreeWay } from './three-way'
import type { LedgerCheck, ThreeWayReport } from './types'

// ---------------- helpers (money.ts house conventions) ----------------

function kes(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

/** Auto reference like MPESA-7XK2P4QA when the client doesn't supply one (money.ts helper, extended). */
function autoReference(method: string): string {
  const prefix =
    method === 'bank' ? 'BANK'
    : method === 'card' ? 'CARD'
    : method === 'wallet' ? 'WALLET'
    : method === 'cash' ? 'CASH'
    : 'MPESA'
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let suffix = ''
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
  return `${prefix}-${suffix}`
}

function posNumber(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function money(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Next invoice code: INV-YYYY-000NNN (max NNN on THIS project + 1). */
async function nextInvoiceCode(projectId: string): Promise<string> {
  const year = new Date().getFullYear()
  const existing = await db.invoice.findMany({
    where: { projectId, invoiceCode: { startsWith: `INV-${year}-` } },
    select: { invoiceCode: true },
  })
  let max = 0
  for (const { invoiceCode } of existing) {
    const n = parseInt(invoiceCode.slice(`INV-${year}-`.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `INV-${year}-${String(max + 1).padStart(6, '0')}`
}

/** Server-side client-role gate. Share-link callers (no session) are already client-gated upstream. */
async function requireClientRole(projectId: string, actionDescription: string): Promise<string> {
  const actor = await currentActor()
  if (actor.role === null || actor.role === 'client') {
    return actor.name || 'client'
  }
  const project = await db.project.findUnique({ where: { id: projectId } })
  throw new Error(
    `Only the client may ${actionDescription} — signed in as "${actor.role}"${actor.name ? ` (${actor.name})` : ''}. ` +
      `The decision queue is waiting for ${project?.client ?? 'the project client'}.`,
  )
}

interface LineInput {
  name: string
  qty: number
  unitPrice: number
  lineTotal: number
}

/** Validate + normalize lines and compute totals server-side. */
function normalizeLines(raw: unknown): { lines: LineInput[]; subtotal: number } {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('At least one invoice line is required')
  const lines: LineInput[] = []
  let subtotal = 0
  for (const item of raw) {
    const name = String((item as Record<string, unknown>)?.name ?? '').trim()
    const qty = money((item as Record<string, unknown>)?.qty)
    const unitPrice = money((item as Record<string, unknown>)?.unitPrice)
    if (!name) throw new Error('Every invoice line needs a name')
    if (qty === null || qty <= 0) throw new Error(`Line "${name}": quantity must be greater than zero`)
    if (unitPrice === null) throw new Error(`Line "${name}": unit price must be zero or more`)
    const lineTotal = Math.round(qty * unitPrice * 100) / 100
    lines.push({ name, qty, unitPrice, lineTotal })
    subtotal += lineTotal
  }
  return { lines, subtotal: Math.round(subtotal * 100) / 100 }
}

async function getInvoiceOrThrow(id: unknown, projectId: string) {
  const invoiceId = String(id ?? '')
  if (!invoiceId) throw new Error('Invoice id required')
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, projectId } })
  if (!invoice) throw new Error('Invoice not found in this project')
  return invoice
}

async function notify(projectId: string, kind: string, title: string, body: string, audienceRole: string, recipient: string | null) {
  await db.notification.create({
    data: { projectId, kind, title, body, audienceRole, recipient },
  })
}

// ---------------- lifecycle ----------------

/** `invoice.create` { orderId?, supplierId?, lines, tax?, dueDate?, note? } → DRAFT. */
export async function createInvoice(projectId: string, payload: Record<string, unknown>) {
  const { lines, subtotal } = normalizeLines(payload.lines)
  const tax = payload.tax === undefined || payload.tax === null ? 0 : money(payload.tax)
  if (tax === null) throw new Error('Tax must be zero or more')
  const total = Math.round((subtotal + tax) * 100) / 100

  // PO link (optional) — must belong to this project; it also implies the supplier
  let orderId: string | null = null
  let supplierId: string | null = null
  if (payload.orderId) {
    const order = await db.purchaseOrder.findFirst({
      where: { id: String(payload.orderId), projectId },
      include: { supplier: true },
    })
    if (!order) throw new Error('Purchase order not found in this project')
    orderId = order.id
    supplierId = order.supplierId
  }
  if (payload.supplierId) {
    const supplier = await db.supplier.findUnique({ where: { id: String(payload.supplierId) } })
    if (!supplier) throw new Error('Supplier not found')
    supplierId = supplier.id
  }

  const invoiceCode = await nextInvoiceCode(projectId)
  const actor = await currentActor()
  const supplierName = supplierId
    ? (await db.supplier.findUnique({ where: { id: supplierId } }))?.businessName ?? null
    : null
  const invoice = await db.invoice.create({
    data: {
      invoiceCode,
      projectId,
      orderId,
      supplierId,
      status: 'draft',
      subtotal,
      tax,
      total,
      dueDate: parseDate(payload.dueDate),
      issuedAt: new Date(),
      createdBy: actor.name ?? supplierName ?? 'MjengoOS',
      note: typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : null,
      lines: { create: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })) },
    },
    include: { lines: true },
  })
  return { id: invoice.id, invoiceCode, total }
}

/** `invoice.update` — edit while DRAFT, or file a DISPUTE while SUBMITTED/APPROVED. */
export async function updateInvoice(projectId: string, payload: Record<string, unknown>) {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)

  // ---- dispute transition (no dispute action in the tuple — documented path) ----
  if (payload.status === 'disputed') {
    const decidedBy = await requireClientRole(projectId, 'dispute an invoice')
    if (!['submitted', 'approved'].includes(invoice.status)) {
      throw new Error(`Cannot dispute an invoice that is ${invoice.status.toUpperCase()} — disputes are filed while the invoice is SUBMITTED or APPROVED`)
    }
    const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : null
    await db.invoice.update({
      where: { id: invoice.id },
      data: { status: 'disputed', decidedAt: new Date(), decidedBy, note: note ?? invoice.note },
    })
    await notify(
      projectId,
      'invoice.disputed',
      `Invoice disputed: ${invoice.invoiceCode}`,
      `${kes(invoice.total)} from the supplier is disputed${note ? ` — “${note}”` : ''}. The site team should reconcile with the supplier before re-approval.`,
      'contractor',
      null,
    )
    return { id: invoice.id, status: 'disputed' }
  }

  // ---- draft edits ----
  if (invoice.status !== 'draft') {
    throw new Error(`Only DRAFT invoices can be edited — this one is ${invoice.status.toUpperCase()}`)
  }
  if (payload.status !== undefined && payload.status !== 'draft') {
    throw new Error("Status changes go through invoice.submit / invoice.decide / invoice.pay — updates can only file a dispute")
  }

  const data: Record<string, unknown> = {}
  if (payload.lines !== undefined) {
    const { lines, subtotal } = normalizeLines(payload.lines)
    const tax = payload.tax === undefined ? invoice.tax : money(payload.tax)
    if (tax === null) throw new Error('Tax must be zero or more')
    data.subtotal = subtotal
    data.tax = tax
    data.total = Math.round((subtotal + tax) * 100) / 100
    await db.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } })
    await db.invoiceLine.createMany({
      data: lines.map((l) => ({ invoiceId: invoice.id, name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    })
  } else if (payload.tax !== undefined) {
    const tax = money(payload.tax)
    if (tax === null) throw new Error('Tax must be zero or more')
    data.tax = tax
    data.total = Math.round((invoice.subtotal + tax) * 100) / 100
  }
  if (payload.dueDate !== undefined) data.dueDate = parseDate(payload.dueDate)
  if (typeof payload.note === 'string') data.note = payload.note.trim() || null

  await db.invoice.update({ where: { id: invoice.id }, data })
  return { id: invoice.id }
}

/** `invoice.submit` { id } → SUBMITTED (+ notification to the client). */
export async function submitInvoice(projectId: string, payload: Record<string, unknown>) {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)
  if (invoice.status !== 'draft') {
    throw new Error(`Only DRAFT invoices can be submitted — this one is ${invoice.status.toUpperCase()}`)
  }
  await db.invoice.update({ where: { id: invoice.id }, data: { status: 'submitted', submittedAt: new Date() } })
  const project = await db.project.findUnique({ where: { id: projectId } })
  await notify(
    projectId,
    'invoice.submitted',
    `Invoice ${invoice.invoiceCode} submitted`,
    `${kes(invoice.total)}${invoice.orderId ? ' against a purchase order' : ''} from the supplier — awaiting your decision.`,
    'client',
    project?.client ?? null,
  )
  return { id: invoice.id, status: 'submitted' }
}

/** `invoice.decide` { id, decision: approve|reject, by?, note? } — CLIENT only. */
export async function decideInvoice(projectId: string, payload: Record<string, unknown>) {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)
  const decision = payload.decision
  if (decision !== 'approve' && decision !== 'reject') {
    // disputes are filed via invoice.update { status: 'disputed' } — see the module docs
    throw new Error("decision must be 'approve' or 'reject' (file disputes with invoice.update { status: 'disputed' })")
  }
  if (!['submitted', 'disputed'].includes(invoice.status)) {
    throw new Error(`Invoice is not awaiting a client decision — it is ${invoice.status.toUpperCase()}`)
  }

  const sessionName = await requireClientRole(projectId, decision === 'approve' ? 'approve invoices' : 'reject invoices')
  const project = await db.project.findUnique({ where: { id: projectId } })
  const by = typeof payload.by === 'string' && payload.by.trim() ? payload.by.trim() : sessionName !== 'client' ? sessionName : project?.client ?? 'Client'
  const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : null
  const now = new Date()

  const status = decision === 'approve' ? 'approved' : 'rejected'
  await db.invoice.update({
    where: { id: invoice.id },
    data: { status, decidedAt: now, decidedBy: by },
  })

  // Approval trail (plain entityType/entityId — audited via the ledger, same as the seed)
  const pending = await db.approval.findFirst({
    where: { entityType: 'invoice', entityId: invoice.id, decision: 'pending' },
  })
  if (pending) {
    await db.approval.update({
      where: { id: pending.id },
      data: { decision: status === 'approved' ? 'approved' : 'rejected', approverRole: 'client', approverName: by, decidedAt: now, note },
    })
  } else {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'invoice',
        entityId: invoice.id,
        approverRole: 'client',
        approverName: by,
        decision: status === 'approved' ? 'approved' : 'rejected',
        note,
        decidedAt: now,
      },
    })
  }

  await notify(
    projectId,
    'invoice.decided',
    `Invoice ${status}: ${invoice.invoiceCode}`,
    `${kes(invoice.total)} ${status} by ${by}${note ? ` — “${note}”` : ''}.`,
    'contractor',
    null,
  )
  return { id: invoice.id, status }
}

/** `invoice.threeWayCheck` { id } → read-only PO ↔ invoice ↔ delivery report. */
export async function threeWayCheck(projectId: string, payload: Record<string, unknown>): Promise<ThreeWayReport & { invoiceCode: string }> {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)
  // NOTE: InvoiceLine/PurchaseOrderLine carry no timestamp column, so lines
  // load in default (insertion) order — the match is name-first and only falls
  // back to positional matching, so order sensitivity is minimal.
  const invoiceLines = await db.invoiceLine.findMany({ where: { invoiceId: invoice.id } })

  let order: Awaited<ReturnType<typeof loadOrderForMatch>> = null
  if (invoice.orderId) order = await loadOrderForMatch(invoice.orderId)

  // 2-way fallback: project-wide delivery records grouped by material name
  const projectDeliveries: { name: string; qtyReceived: number }[] = []
  if (!order) {
    const rows = await db.orderDeliveryLine.findMany({
      where: { delivery: { order: { projectId } } },
      include: { orderLine: { select: { name: true } } },
    })
    for (const r of rows) {
      const found = projectDeliveries.find((d) => d.name === r.orderLine.name)
      if (found) found.qtyReceived += r.qtyReceived
      else projectDeliveries.push({ name: r.orderLine.name, qtyReceived: r.qtyReceived })
    }
  }

  const report = matchThreeWay({
    invoiceLines: invoiceLines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    order,
    projectDeliveries,
  })
  return { ...report, invoiceCode: invoice.invoiceCode }
}

async function loadOrderForMatch(orderId: string) {
  const order = await db.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      lines: true, // default (insertion) order — see the note in threeWayCheck
      deliveries: { orderBy: { createdAt: 'desc' }, include: { lines: true } },
    },
  })
  if (!order) return null
  return {
    orderCode: order.orderCode,
    deliveryFee: order.deliveryFee,
    lines: order.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty })),
    deliveries: order.deliveries.map((d) => ({
      createdAt: d.createdAt,
      lines: d.lines.map((dl) => ({ orderLineId: dl.orderLineId, qtyReceived: dl.qtyReceived })),
    })),
  }
}

/**
 * `invoice.pay` { id, method, reference?, acknowledgeMismatch?, by? } — CLIENT only,
 * APPROVED only. Writes exactly ONE Transaction (money.ts conventions); the
 * 3-way check runs internally and mismatched payments need the payer's
 * explicit acknowledgeMismatch — the human decision, recorded in the trail.
 */
export async function payInvoice(projectId: string, payload: Record<string, unknown>) {
  const invoice = await getInvoiceOrThrow(payload.id, projectId)
  const method = String(payload.method ?? '').toLowerCase()
  if (!['mpesa', 'bank', 'card', 'wallet', 'cash'].includes(method)) {
    throw new Error("method must be one of mpesa, bank, card, wallet, cash")
  }
  if (invoice.status !== 'approved') {
    // approvals-before-payment is a server-side money rule, not a UI nicety
    throw new Error(`Invoice must be APPROVED before payment — ${invoice.invoiceCode} is ${invoice.status.toUpperCase()}`)
  }

  const sessionName = await requireClientRole(projectId, 'release invoice payments')
  const project = await db.project.findUnique({ where: { id: projectId } })
  const actor = await currentActor()
  const by = typeof payload.by === 'string' && payload.by.trim()
    ? payload.by.trim()
    : sessionName !== 'client' ? sessionName : project?.client ?? 'Client'
  const paidByRole = actor.role === 'finance' ? 'finance' : 'client'

  // ---- 3-way match gate: warn, human decides ----
  const report = await threeWayCheck(projectId, { id: invoice.id })
  if (report.mismatches.length > 0 && payload.acknowledgeMismatch !== true) {
    throw new Error(
      `3-way match shows ${report.mismatches.length} open item(s) on ${invoice.invoiceCode} (first: ${report.mismatches[0].issue}). ` +
        'Review them with the supplier and confirm with acknowledgeMismatch to record the payment anyway — the human decides.',
    )
  }

  const reference =
    typeof payload.reference === 'string' && payload.reference.trim()
      ? payload.reference.trim()
      : autoReference(method)

  // ---- wallet semantics (mirrors money.ts milestone.decide) ----
  let balance: number | undefined
  if (method === 'wallet') {
    const wallet = await db.escrowWallet.findUnique({ where: { projectId } })
    if (!wallet || wallet.balance < invoice.total) throw new Error('Insufficient escrow balance — top up first')
    const updatedWallet = await db.escrowWallet.update({
      where: { projectId },
      data: { balance: { decrement: invoice.total } },
    })
    balance = updatedWallet.balance
  }

  // ---- exactly ONE ledger row (append-only; never mutated/deleted here) ----
  const now = new Date()
  const supplierName = invoice.supplierId
    ? (await db.supplier.findUnique({ where: { id: invoice.supplierId } }))?.businessName ?? 'the supplier'
    : 'the supplier'
  const orderCode = invoice.orderId
    ? (await db.purchaseOrder.findUnique({ where: { id: invoice.orderId } }))?.orderCode ?? null
    : null
  await db.transaction.create({
    data: {
      projectId,
      type: 'invoice', // peer of money.ts 'milestone' — supplier payments ledgered at source
      amount: invoice.total,
      method,
      reference,
      note: `${invoice.invoiceCode}${orderCode ? ` (${orderCode})` : ''} paid to ${supplierName} — recorded by ${by}`,
      date: now,
    },
  })

  await db.invoice.update({
    where: { id: invoice.id },
    data: {
      status: 'paid',
      paidAt: now,
      paidByRole,
      paymentMethod: method,
      paymentReference: reference,
    },
  })

  // The acknowledged-discrepancy decision is part of the honest trail
  if (report.mismatches.length > 0) {
    await db.approval.create({
      data: {
        projectId,
        entityType: 'invoice',
        entityId: invoice.id,
        approverRole: paidByRole,
        approverName: by,
        decision: 'approved',
        note: `Payment recorded with ${report.mismatches.length} open 3-way item(s) — discrepancy reviewed with the supplier before paying.`,
        decidedAt: now,
      },
    })
  }

  await notify(
    projectId,
    'invoice.paid',
    `Invoice paid: ${invoice.invoiceCode}`,
    `${kes(invoice.total)} paid to ${supplierName} via ${method.toUpperCase()} (${reference}) — recorded by ${by}.`,
    'contractor',
    null,
  )
  return { id: invoice.id, status: 'paid', reference, balance }
}

// ---------------- A-1-lite (read-only) ----------------

/** Recompute the wallet/ledger consistency projection — never mutates values. */
export async function ledgerConsistency(projectId: string): Promise<LedgerCheck & { walletBalance: number }> {
  const [wallet, transactions, milestones, invoices] = await Promise.all([
    db.escrowWallet.findUnique({ where: { projectId } }),
    db.transaction.findMany({ where: { projectId } }),
    db.milestone.findMany({ where: { projectId }, select: { id: true, status: true } }),
    db.invoice.findMany({ where: { projectId, status: 'paid' }, select: { paymentReference: true } }),
  ])
  const check = computeLedgerConsistency({
    walletBalance: wallet?.balance ?? 0,
    transactions: transactions.map((t) => ({ type: t.type, method: t.method, amount: t.amount, reference: t.reference })),
    releasedMilestoneIds: milestones.filter((m) => m.status === 'released').map((m) => m.id),
    paidInvoiceReferences: invoices.map((i) => i.paymentReference ?? ''),
  })
  return { ...check, walletBalance: wallet?.balance ?? 0 }
}
