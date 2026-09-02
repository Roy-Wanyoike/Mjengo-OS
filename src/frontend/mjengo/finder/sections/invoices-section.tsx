'use client'

// Finder invoices section (agent 2-d) — the money end of the Finder loop:
// draft → submitted → CLIENT decision (approve / reject / dispute) → payment
// recording (method + reference → ONE Transaction ledger entry, visible in
// the project spend totals + here) → printable record.
//
// The 3-way match (PO ↔ invoice ↔ delivery) is computed with the SAME pure
// function the server enforces on invoice.pay (modules/invoices/three-way.ts)
// — the UI shows what the server will check; nothing blocks silently and
// nothing is accused: "review required", the human decides.
//
// Money rules (server-enforced, mirrored here): only APPROVED invoices can be
// paid; mismatched payments need the payer's explicit reviewed-discrepancy
// acknowledgement; only the client role decides/pays — the site team sees the
// queue read-only and their attempts fail honestly server-side.

import { useMemo, useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Label } from '@/frontend/ui/label'
import { Textarea } from '@/frontend/ui/textarea'
import { dateShort, formatKES } from '@/frontend/lib/format'
import { matchThreeWay } from '@/backend/modules/invoices/three-way'
import type { InvoiceWithLines, ThreeWayReport } from '@/backend/modules/invoices/types'
import { AlertTriangle, Banknote, Check, Hourglass, Plus, ReceiptText, ScrollText, Send, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'
import { CreateInvoiceDialog } from './invoices/create-invoice-dialog'
import { DecisionQueueCard } from './invoices/decision-queue-card'
import { InvoiceDetailDialog } from './invoices/invoice-detail-dialog'
import { InvoiceStatusBadge, ThreeWayChip, formatKes, fmtQty } from './invoices/invoice-bits'
import { LedgerConsistencyChip } from './invoices/ledger-consistency-chip'
import { PayInvoiceDialog, PaymentRecordBadge } from './invoices/pay-invoice-dialog'
import { PrintableInvoice } from './invoices/printable-invoice'

export function InvoicesSection() {
  const { data, dispatch, viewMode, shareToken, clientRole, actionBusy, online, outbox } = useMjengo()
  const busy = actionBusy !== null

  const [detailTarget, setDetailTarget] = useState<InvoiceWithLines | null>(null)
  const [matchRunFor, setMatchRunFor] = useState<string | null>(null)
  const [payTarget, setPayTarget] = useState<InvoiceWithLines | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [approveConfirm, setApproveConfirm] = useState<InvoiceWithLines | null>(null)
  const [rejectTarget, setRejectTarget] = useState<InvoiceWithLines | null>(null)
  const [disputeTarget, setDisputeTarget] = useState<InvoiceWithLines | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [printTarget, setPrintTarget] = useState<InvoiceWithLines | null>(null)

  // Client surface = share-link client OR logged-in client-role user. The
  // owner "preview client view" toggle is NOT a decider — the server would
  // honestly reject a contractor deciding.
  const isClientSurface = viewMode === 'client' && (Boolean(shareToken) || clientRole)
  const isDecider = isClientSurface
  const isSiteTeam = !isClientSurface
  const clientName = data?.project.client ?? 'the client'

  const invoices = data?.invoices.invoices ?? []
  const orders = data?.supply.orders ?? []
  const walletBalance = data?.escrow?.balance ?? 0

  // 3-way reports per invoice — the SAME pure function the server runs.
  const reports = useMemo(() => {
    const byId = new Map<string, ThreeWayReport>()
    const projectDeliveries: { name: string; qtyReceived: number }[] = []
    for (const o of orders) {
      for (const d of o.deliveries) {
        for (const dl of d.lines) {
          const name = o.lines.find((l) => l.id === dl.orderLineId)?.name
          if (!name) continue
          const found = projectDeliveries.find((p) => p.name === name)
          if (found) found.qtyReceived += dl.qtyReceived
          else projectDeliveries.push({ name, qtyReceived: dl.qtyReceived })
        }
      }
    }
    for (const inv of invoices) {
      const order = inv.orderId ? orders.find((o) => o.id === inv.orderId) : undefined
      byId.set(inv.id, matchThreeWay({
        invoiceLines: inv.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
        order: order
          ? {
              orderCode: order.orderCode,
              deliveryFee: order.deliveryFee,
              lines: order.lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty })),
              deliveries: order.deliveries.map((d) => ({
                createdAt: d.createdAt,
                lines: d.lines.map((dl) => ({ orderLineId: dl.orderLineId, qtyReceived: dl.qtyReceived })),
              })),
            }
          : null,
        projectDeliveries,
      }))
    }
    return byId
  }, [invoices, orders])

  const queue = invoices.filter((i) => i.status === 'submitted' || i.status === 'disputed')
  const paymentRecords = (data?.transactions ?? []).filter((t) => t.type === 'invoice')
  const offlineNote = `Saved on-device — queued (${outbox.length})`
  // Ledger refs for paid invoices (F-MONEY): Transaction.ledgerTxnId → ledger txn ref
  const allTransactions = data?.transactions
  const ledgerTxns = data?.finance?.ledger.transactions
  const ledgerRefByInvoice = useMemo(() => {
    const byId = new Map<string, string | null>()
    for (const inv of invoices) {
      if (inv.status !== 'paid') continue
      const txnRow = (allTransactions ?? []).find(
        (t) => t.type === 'invoice' && t.reference === inv.paymentReference,
      )
      const ref = txnRow?.ledgerTxnId
        ? ledgerTxns?.find((lt) => lt.id === txnRow.ledgerTxnId)?.ref
        : undefined
      byId.set(inv.id, ref ?? null)
    }
    return byId
  }, [invoices, allTransactions, ledgerTxns])

  if (!data) return null

  // ---------------- handlers ----------------

  function openDetail(inv: InvoiceWithLines) {
    setDetailTarget(inv)
    setMatchRunFor(null)
  }

  async function submitDraft(inv: InvoiceWithLines) {
    const ok = await dispatch('invoice.submit', { id: inv.id }, `Invoice submitted: ${inv.invoiceCode}`)
    if (ok) {
      toast.success(online ? `${inv.invoiceCode} submitted — awaiting ${clientName}` : offlineNote)
      setDetailTarget(null)
    } else toast.error('Could not submit — the invoice may no longer be a draft')
  }

  async function approveInvoice(inv: InvoiceWithLines) {
    const ok = await dispatch('invoice.decide', {
      id: inv.id, decision: 'approve', by: clientName,
    }, `Invoice approved: ${inv.invoiceCode}`)
    if (ok) {
      toast.success(`${inv.invoiceCode} approved — payment can now be recorded`)
      setApproveConfirm(null)
      setDetailTarget(null)
    } else toast.error('Could not record the approval — only the client role may decide')
  }

  async function rejectInvoice(inv: InvoiceWithLines) {
    const ok = await dispatch('invoice.decide', {
      id: inv.id, decision: 'reject', by: clientName,
      note: noteDraft.trim() || undefined,
    }, `Invoice rejected: ${inv.invoiceCode}`)
    if (ok) {
      toast.success(`${inv.invoiceCode} rejected — the supplier can re-issue`)
      setRejectTarget(null); setNoteDraft('')
      setDetailTarget(null)
    } else toast.error('Could not record the rejection — only the client role may decide')
  }

  async function disputeInvoice(inv: InvoiceWithLines) {
    // Disputes ride invoice.update { status: 'disputed' } — documented path (no dispute action in the tuple)
    const ok = await dispatch('invoice.update', {
      id: inv.id, status: 'disputed', note: noteDraft.trim() || undefined,
    }, `Invoice disputed: ${inv.invoiceCode}`)
    if (ok) {
      toast.success(`${inv.invoiceCode} marked disputed — reconcile with the supplier`)
      setDisputeTarget(null); setNoteDraft('')
      setDetailTarget(null)
    } else toast.error('Could not file the dispute — only the client role may dispute')
  }

  async function payConfirmed(inv: InvoiceWithLines, payload: { method: string; reference: string; costCode: string | null; acknowledgeMismatch: boolean }) {
    const ok = await dispatch('invoice.pay', {
      id: inv.id, method: payload.method, reference: payload.reference,
      costCode: payload.costCode ?? undefined,
      acknowledgeMismatch: payload.acknowledgeMismatch || undefined, by: clientName,
    }, `Invoice paid: ${inv.invoiceCode}`)
    if (ok) {
      // F-MONEY: the payment posts a double-entry ledger row — quote its ref
      // from the refreshed payload (Transaction.ledgerTxnId → ledger ref).
      const fresh = useMjengo.getState().data
      const txnRow = fresh?.transactions.find((t) => t.type === 'invoice' && t.reference === payload.reference)
      const ledgerRef = txnRow?.ledgerTxnId
        ? fresh?.finance.ledger.transactions.find((lt) => lt.id === txnRow.ledgerTxnId)?.ref
        : undefined
      toast.success(online
        ? `${formatKES(inv.total)} paid — ${payload.reference} recorded${ledgerRef ? ` (ledger ${ledgerRef}, cost code ${txnRow?.costCode ?? 'invoice'})` : ' in the Transaction ledger'}`
        : offlineNote)
      setPayTarget(null)
      setDetailTarget(null)
    } else {
      // Honest failure: the server blocked it (role, status or unacknowledged mismatch)
      toast.error('Payment was not recorded — the server blocked it (approval, role or unreviewed 3-way discrepancy)')
      setPayTarget(inv) // keep the dialog open so the payer can review
    }
  }

  async function runCheck(inv: InvoiceWithLines) {
    // Dispatch the action too — the run lands in the Bias-Free Ledger trail
    await dispatch('invoice.threeWayCheck', { id: inv.id }, `3-way match: ${inv.invoiceCode}`)
    setMatchRunFor(inv.id)
  }

  function printInvoice(inv: InvoiceWithLines) {
    setPrintTarget(inv)
    setDetailTarget(null)
    setTimeout(() => { window.print() }, 300)
  }

  async function createInvoice(payload: {
    orderId?: string; supplierId?: string; lines: { name: string; qty: number; unitPrice: number }[]
    tax?: number; dueDate?: string; note?: string
  }) {
    const ok = await dispatch('invoice.create', payload, 'Invoice draft created')
    if (ok) {
      toast.success(online ? 'Draft invoice created — review it, then submit to the client' : offlineNote)
      setCreateOpen(false)
    } else toast.error('Could not create the invoice — check the lines')
  }

  // ---------------- render ----------------

  return (
    <section aria-label="Supplier invoices" className="space-y-6">
      {/* Print isolation — only #mjengo-print-root is visible on paper */}
      <style>{`@media print { body * { visibility: hidden !important; } #mjengo-print-root, #mjengo-print-root * { visibility: visible !important; } #mjengo-print-root { position: fixed !important; inset: 0 !important; overflow: visible !important; background: white !important; } }`}</style>

      {/* ---------- decision queue (first — money decisions before records) ---------- */}
      {queue.length > 0 && (
        <Card className="border-stone-200 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
              <Hourglass className="h-5 w-5 text-amber-600" aria-hidden />
              Client decision queue
              <Badge className="border-0 bg-amber-100 text-amber-900">{queue.length}</Badge>
            </CardTitle>
            <CardDescription>
              Supplier invoices waiting on <span className="font-medium text-stone-700">{clientName}</span> — approve, reject with a note, or dispute.
              The 3-way match flags open items; the system recommends, a human decides.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-[32rem] space-y-4 overflow-y-auto pr-2 -mr-2" role="region" aria-label="Invoices awaiting a client decision, scrollable">
              {queue.map((inv) => (
                <DecisionQueueCard
                  key={inv.id}
                  invoice={inv}
                  report={reports.get(inv.id) ?? matchThreeWay({ invoiceLines: [], order: null })}
                  clientName={clientName}
                  isDecider={isDecider}
                  busy={busy}
                  onApprove={setApproveConfirm}
                  onReject={(i) => { setRejectTarget(i); setNoteDraft('') }}
                  onDispute={(i) => { setDisputeTarget(i); setNoteDraft('') }}
                  onOpen={openDetail}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------- all invoices ---------- */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-2">
            <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
              <ReceiptText className="h-5 w-5 text-amber-600" aria-hidden /> Invoices
              <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{invoices.length}</Badge>
            </CardTitle>
            <CardDescription>
              Draft → submitted → client decision → paid. Every payment writes one permanent Transaction ledger entry.
            </CardDescription>
            <LedgerConsistencyChip check={data.invoices.ledgerCheck} walletBalance={walletBalance} />
          </div>
          {isSiteTeam && (
            <Button size="sm" variant="outline" className="min-h-11 gap-1.5" onClick={() => setCreateOpen(true)} aria-label="Create a new supplier invoice">
              <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">New invoice</span>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center">
              <ReceiptText className="mx-auto h-8 w-8 text-stone-300" aria-hidden />
              <p className="pt-3 text-sm font-medium text-stone-700">No invoices yet</p>
              <p className="pt-1 text-xs text-stone-500">
                {isSiteTeam
                  ? 'Create one from a purchase order — supplier and lines pre-fill from the PO.'
                  : 'The site team drafts supplier invoices here; you decide and pay.'}
              </p>
              {isSiteTeam && (
                <Button size="sm" className="mt-4 min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden /> New invoice
                </Button>
              )}
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto pr-2 -mr-2" role="region" aria-label="All invoices, scrollable">
              <div className="overflow-x-auto rounded-md border border-stone-200">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                      <th scope="col" className="px-3 py-2 font-medium">Invoice</th>
                      <th scope="col" className="px-2 py-2 font-medium">Supplier</th>
                      <th scope="col" className="px-2 py-2 font-medium">Match</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Total</th>
                      <th scope="col" className="px-2 py-2 font-medium">Status</th>
                      <th scope="col" className="px-3 py-2 font-medium">Payment</th>
                      <th scope="col" className="relative px-2 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => {
                      const report = reports.get(inv.id)
                      return (
                        <tr key={inv.id} className="border-b border-stone-100 transition last:border-0 hover:bg-stone-50">
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <button
                              className="font-mono text-xs font-semibold text-stone-800 underline-offset-2 hover:text-amber-700 hover:underline"
                              onClick={() => openDetail(inv)}
                              aria-label={`Open invoice ${inv.invoiceCode}`}
                            >
                              {inv.invoiceCode}
                            </button>
                            {inv.orderCode && <p className="text-[10px] text-stone-400">{inv.orderCode}</p>}
                          </td>
                          <td className="max-w-[150px] truncate px-2 py-2.5 text-xs text-stone-600">{inv.supplierName ?? '—'}</td>
                          <td className="px-2 py-2.5">{report ? <ThreeWayChip report={report} /> : null}</td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right font-semibold tabular-nums text-stone-800">{formatKes(inv.total)}</td>
                          <td className="px-2 py-2.5"><InvoiceStatusBadge status={inv.status} /></td>
                          <td className="px-3 py-2.5">{inv.status === 'paid' ? <PaymentRecordBadge invoice={inv} ledgerRef={ledgerRefByInvoice.get(inv.id)} /> : <span className="text-[11px] text-stone-400">—</span>}</td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right">
                            <div className="flex justify-end gap-1.5">
                              {isSiteTeam && inv.status === 'draft' && (
                                <Button
                                  size="sm" variant="outline" className="h-8 min-h-8 gap-1 px-2 text-xs"
                                  disabled={busy}
                                  onClick={() => void submitDraft(inv)}
                                  aria-label={`Submit ${inv.invoiceCode} to the client`}
                                >
                                  <Send className="h-3.5 w-3.5" aria-hidden /> Submit
                                </Button>
                              )}
                              {isDecider && inv.status === 'approved' && (
                                <Button
                                  size="sm" className="h-8 min-h-8 gap-1 bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700"
                                  disabled={busy}
                                  onClick={() => setPayTarget(inv)}
                                  aria-label={`Record payment for ${inv.invoiceCode}`}
                                >
                                  <Banknote className="h-3.5 w-3.5" aria-hidden /> Pay
                                </Button>
                              )}
                              <Button
                                size="sm" variant="ghost" className="h-8 min-h-8 gap-1 px-2 text-xs text-stone-500"
                                onClick={() => openDetail(inv)}
                                aria-label={`Open ${inv.invoiceCode} details`}
                              >
                                Details
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- payment records (ledger cross-proof) ---------- */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <ScrollText className="h-5 w-5 text-amber-600" aria-hidden /> Payment records
            <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{paymentRecords.length}</Badge>
          </CardTitle>
          <CardDescription>
            Every invoice payment writes one Transaction ledger entry (type <span className="font-mono text-[10px]">invoice</span>) —
            the same ledger that feeds the project spend totals (header + Overview burn-down).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {paymentRecords.length === 0 ? (
            <p className="rounded-md bg-stone-50 p-3 text-xs text-stone-500">
              No invoice payments recorded yet — seeded history predates the runtime ledger (no double counting).
            </p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto pr-2 -mr-2" role="region" aria-label="Invoice payment ledger entries, scrollable">
              {paymentRecords.slice(0, 8).map((t) => (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-stone-200 bg-white p-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-stone-700">{t.note}</p>
                    <p className="text-[11px] text-stone-400">
                      {dateShort(t.date)} · {t.method.toUpperCase()} · <span className="font-mono">{t.reference ?? '—'}</span>
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-bold tabular-nums text-stone-900">{formatKES(t.amount)}</span>
                </div>
              ))}
              {paymentRecords.length > 8 && (
                <p className="text-[11px] text-stone-400">+{paymentRecords.length - 8} older entr{paymentRecords.length - 8 === 1 ? 'y' : 'ies'} — the full ledger lives in the project exports.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- detail dialog ---------------- */}
      <InvoiceDetailDialog
        invoice={detailTarget}
        report={detailTarget ? reports.get(detailTarget.id) ?? null : null}
        showMatch={Boolean(detailTarget && matchRunFor === detailTarget.id)}
        isDecider={isDecider}
        isSiteTeam={isSiteTeam}
        busy={busy}
        onClose={() => setDetailTarget(null)}
        onRunCheck={(inv) => void runCheck(inv)}
        onSubmit={(inv) => void submitDraft(inv)}
        onApprove={setApproveConfirm}
        onReject={(i) => { setRejectTarget(i); setNoteDraft('') }}
        onDispute={(i) => { setDisputeTarget(i); setNoteDraft('') }}
        onPay={setPayTarget}
        onPrint={printInvoice}
      />

      {/* ---------------- pay dialog ---------------- */}
      <PayInvoiceDialog
        invoice={payTarget}
        report={payTarget ? reports.get(payTarget.id) ?? null : null}
        walletBalance={walletBalance}
        busy={busy}
        onConfirm={({ method, reference, costCode, acknowledgeMismatch }) => {
          if (payTarget) void payConfirmed(payTarget, { method, reference, costCode, acknowledgeMismatch })
        }}
        onClose={() => setPayTarget(null)}
      />

      {/* ---------------- create dialog ---------------- */}
      <CreateInvoiceDialog
        open={createOpen}
        orders={orders}
        suppliers={data.supply.suppliers}
        busy={busy}
        onOpenChange={setCreateOpen}
        onCreate={(payload) => void createInvoice(payload)}
      />

      {/* ---------------- approve confirmation (money house style) ---------------- */}
      <Dialog open={approveConfirm !== null} onOpenChange={(open) => { if (!open) setApproveConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Approve invoice</DialogTitle>
            <DialogDescription>
              {approveConfirm
                ? `This approves ${formatKes(approveConfirm.total)} to ${approveConfirm.supplierName ?? 'the supplier'} for ${approveConfirm.invoiceCode}. Payment is recorded separately, after this approval.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {approveConfirm && (reports.get(approveConfirm.id)?.mismatches.length ?? 0) > 0 && (
            <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              The 3-way match still shows {reports.get(approveConfirm.id)?.mismatches.length} open item(s). Approving is allowed — but paying will ask you to confirm you reviewed the discrepancy.
            </p>
          )}
          <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-500">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
            One deliberate click, not two accidental ones — the decision is recorded in the audit ledger and cannot be edited afterwards.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveConfirm(null)}>Cancel</Button>
            <Button
              onClick={() => { if (approveConfirm) void approveInvoice(approveConfirm) }}
              disabled={busy}
              className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Check className="h-4 w-4" aria-hidden /> Confirm approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- reject with note ---------------- */}
      <Dialog open={rejectTarget !== null} onOpenChange={(open) => { if (!open) setRejectTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Reject with a note</DialogTitle>
            <DialogDescription>
              {rejectTarget ? `Rejecting ${rejectTarget.invoiceCode} — the note is recorded in the decision history; the supplier can re-issue.` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="invoice-reject-note">Note to the site team (optional)</Label>
              <Textarea id="invoice-reject-note" rows={3} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="e.g. Qty billed exceeds the PO — request a corrected invoice" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button
              onClick={() => { if (rejectTarget) void rejectInvoice(rejectTarget) }}
              disabled={busy}
              variant="outline"
              className="min-h-11 gap-1.5 border-rose-300 bg-white text-rose-700 hover:bg-rose-50 hover:text-rose-800"
            >
              <X className="h-4 w-4" aria-hidden /> Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- dispute with note ---------------- */}
      <Dialog open={disputeTarget !== null} onOpenChange={(open) => { if (!open) setDisputeTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Dispute invoice</DialogTitle>
            <DialogDescription>
              {disputeTarget
                ? `Marks ${disputeTarget.invoiceCode} as disputed — reconciliation with the supplier before any payment. Filed via invoice.update { status: 'disputed' } (no separate dispute action in the tuple).`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="invoice-dispute-note">What is disputed (optional)</Label>
              <Textarea id="invoice-dispute-note" rows={3} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="e.g. Wrong product delivered, 2 bags missing, price differs from the quote…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisputeTarget(null)}>Cancel</Button>
            <Button
              onClick={() => { if (disputeTarget) void disputeInvoice(disputeTarget) }}
              disabled={busy}
              variant="outline"
              className="min-h-11 gap-1.5 border-orange-300 bg-white text-orange-700 hover:bg-orange-50 hover:text-orange-800"
            >
              <AlertTriangle className="h-4 w-4" aria-hidden /> File dispute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- print-only record ---------------- */}
      {printTarget && (
        <PrintableInvoice
          invoice={printTarget}
          projectName={data.project.name}
          clientName={data.project.client}
          location={data.project.location}
        />
      )}
    </section>
  )
}
