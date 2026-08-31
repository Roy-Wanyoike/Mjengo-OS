'use client'

// Invoice detail dialog — full lines, tax and totals, decision/payment
// history, the 3-way match matrix (PO qty | invoice qty | delivered qty) and
// the printable view. Actions are role-honest: the client decides and pays,
// the site team submits drafts; the server enforces both.

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertTriangle, Check, FileText, Printer, ScanSearch, Send, Banknote, ShieldCheck, X } from 'lucide-react'
import { dateShort } from '@/lib/format'
import type { InvoiceWithLines, ThreeWayReport } from '@/modules/invoices/types'
import { InvoiceStatusBadge, PAYMENT_METHOD_LABELS, ThreeWayChip, formatKes, fmtQty } from './invoice-bits'

interface Props {
  invoice: InvoiceWithLines | null
  report: ThreeWayReport | null
  showMatch: boolean
  isDecider: boolean
  isSiteTeam: boolean
  busy: boolean
  onClose: () => void
  onRunCheck: (invoice: InvoiceWithLines) => void
  onSubmit: (invoice: InvoiceWithLines) => void
  onApprove: (invoice: InvoiceWithLines) => void
  onReject: (invoice: InvoiceWithLines) => void
  onDispute: (invoice: InvoiceWithLines) => void
  onPay: (invoice: InvoiceWithLines) => void
  onPrint: (invoice: InvoiceWithLines) => void
}

function MetaRow({ label, value }: { label: string; value: string | null }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-xs text-stone-400">{label}</span>
      <span className="truncate text-right text-xs font-medium text-stone-700">{value}</span>
    </div>
  )
}

export function InvoiceDetailDialog({
  invoice, report, showMatch, isDecider, isSiteTeam, busy,
  onClose, onRunCheck, onSubmit, onApprove, onReject, onDispute, onPay, onPrint,
}: Props) {
  return (
    <Dialog open={invoice !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        {invoice && (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2 pr-6">
                <DialogTitle className="font-mono text-stone-900">{invoice.invoiceCode}</DialogTitle>
                <InvoiceStatusBadge status={invoice.status} />
                {report && <ThreeWayChip report={report} />}
              </div>
              <DialogDescription>
                {invoice.supplierName ?? 'Supplier not recorded'}
                {invoice.orderCode ? ` · ${invoice.orderCode}` : ' · no purchase order linked'}
                {' '}· {formatKes(invoice.total)}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-1">
              {/* meta */}
              <div className="grid gap-x-6 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 sm:grid-cols-2">
                <MetaRow label="Issued" value={invoice.issuedAt ? dateShort(invoice.issuedAt) : '—'} />
                <MetaRow label="Submitted" value={invoice.submittedAt ? dateShort(invoice.submittedAt) : null} />
                <MetaRow label="Decided" value={invoice.decidedAt && invoice.decidedBy ? `${dateShort(invoice.decidedAt)} · ${invoice.decidedBy}` : null} />
                <MetaRow label="Due" value={invoice.dueDate ? dateShort(invoice.dueDate) : '—'} />
                <MetaRow label="Payment" value={invoice.status === 'paid'
                  ? `${PAYMENT_METHOD_LABELS[invoice.paymentMethod ?? '']?.label ?? invoice.paymentMethod ?? '—'}${invoice.paymentReference ? ` · ${invoice.paymentReference}` : ''}${invoice.paidAt ? ` · ${dateShort(invoice.paidAt)}` : ''}${invoice.paidByRole ? ` · by ${invoice.paidByRole}` : ''}`
                  : null} />
                <MetaRow label="Created by" value={invoice.createdBy} />
              </div>

              {/* lines */}
              <div>
                <p className="pb-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-400">Lines ({invoice.lines.length})</p>
                <div className="overflow-x-auto rounded-md border border-stone-200">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead>
                      <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                        <th scope="col" className="px-3 py-2 font-medium">Item</th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">Qty</th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">Unit</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoice.lines.map((l) => (
                        <tr key={l.id} className="border-b border-stone-100 last:border-0">
                          <td className="max-w-[220px] truncate px-3 py-2 text-stone-700">{l.name}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-stone-600">{fmtQty(l.qty)}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-stone-500">{formatKes(l.unitPrice)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-stone-800">{formatKes(l.lineTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-stone-50 text-sm">
                      <tr className="border-t border-stone-200">
                        <td colSpan={3} className="px-3 py-1.5 text-right text-xs text-stone-500">Subtotal</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-stone-700">{formatKes(invoice.subtotal)}</td>
                      </tr>
                      <tr>
                        <td colSpan={3} className="px-3 py-1.5 text-right text-xs text-stone-500">Tax</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-stone-700">{formatKes(invoice.tax)}</td>
                      </tr>
                      <tr className="border-t border-stone-200">
                        <td colSpan={3} className="px-3 py-2 text-right text-xs font-semibold text-stone-700">Total</td>
                        <td className="px-3 py-2 text-right text-base font-bold tabular-nums text-stone-900">{formatKes(invoice.total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {invoice.tax === 0 && (
                  <p className="pt-1 text-[11px] text-stone-400">VAT-inclusive supplier pricing (demo data) — tax line is zero.</p>
                )}
              </div>

              {/* decision/payment history */}
              {invoice.note && (
                <p className="rounded-md bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-500">Note: “{invoice.note}”</p>
              )}

              {/* 3-way match matrix */}
              {report && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">3-way match — PO ↔ invoice ↔ delivery</p>
                    <Button
                      size="sm" variant="outline" className="h-8 min-h-8 gap-1 text-xs"
                      onClick={() => onRunCheck(invoice)}
                      disabled={busy}
                      aria-label="Run the 3-way match check"
                    >
                      <ScanSearch className="h-3.5 w-3.5" aria-hidden /> Run 3-way match
                    </Button>
                  </div>
                  {showMatch ? (
                    <>
                      <div className="overflow-x-auto rounded-md border border-stone-200">
                        <table className="w-full min-w-[460px] text-sm">
                          <thead>
                            <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                              <th scope="col" className="px-3 py-2 font-medium">Line</th>
                              <th scope="col" className="px-2 py-2 text-right font-medium">PO qty</th>
                              <th scope="col" className="px-2 py-2 text-right font-medium">Invoice qty</th>
                              <th scope="col" className="px-3 py-2 text-right font-medium">Delivered</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.lines.map((l, i) => {
                              const flagged = report.mismatches.some((m) => m.name === l.name)
                              return (
                                <tr key={i} className={`border-b border-stone-100 last:border-0 ${flagged ? 'bg-amber-50' : ''}`}>
                                  <td className="max-w-[220px] truncate px-3 py-2 text-stone-700">
                                    {l.name}{l.feeLine && <span className="text-stone-400"> (fee)</span>}
                                  </td>
                                  <td className="px-2 py-2 text-right tabular-nums text-stone-600">{fmtQty(l.poQty)}</td>
                                  <td className="px-2 py-2 text-right tabular-nums text-stone-600">{fmtQty(l.invQty)}</td>
                                  <td className={`px-3 py-2 text-right tabular-nums ${flagged ? 'font-semibold text-amber-800' : 'text-stone-600'}`}>{fmtQty(l.deliveredQty)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                      {report.mismatches.length > 0 ? (
                        <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2.5">
                          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {report.mismatches.length} open item{report.mismatches.length === 1 ? '' : 's'} — review required
                          </p>
                          {report.mismatches.map((m, i) => (
                            <p key={i} className="text-[11px] leading-relaxed text-amber-800">• {m.name}: {m.issue}</p>
                          ))}
                          <p className="pt-0.5 text-[10px] text-amber-700">
                            The system recommends review — payment stays possible only with the payer&apos;s explicit reviewed-discrepancy confirmation.
                          </p>
                        </div>
                      ) : (
                        <p className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-800">
                          <Check className="h-3.5 w-3.5" aria-hidden /> All lines reconcile — ordered, billed and delivered counts match.
                        </p>
                      )}
                      <p className="text-[10px] text-stone-400">{report.note}</p>
                    </>
                  ) : (
                    <p className="rounded-md bg-stone-50 px-3 py-2 text-xs text-stone-500">
                      Run the check to compare every line across the purchase order, this invoice and the recorded delivery —
                      warn-only: a human still decides.
                    </p>
                  )}
                </div>
              )}
            </div>

            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
              <Button
                variant="outline" onClick={() => onPrint(invoice)}
                aria-label={`Print invoice ${invoice.invoiceCode}`}
              >
                <Printer className="h-4 w-4" aria-hidden /> Print record
              </Button>
              <div className="flex flex-wrap gap-2">
                {isSiteTeam && invoice.status === 'draft' && (
                  <Button
                    onClick={() => onSubmit(invoice)} disabled={busy}
                    className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
                    aria-label={`Submit invoice ${invoice.invoiceCode} to the client`}
                  >
                    <Send className="h-4 w-4" aria-hidden /> Submit to client
                  </Button>
                )}
                {isDecider && invoice.status === 'submitted' && (
                  <>
                    <Button
                      onClick={() => onApprove(invoice)} disabled={busy}
                      className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                      aria-label={`Approve invoice ${invoice.invoiceCode}`}
                    >
                      <Check className="h-4 w-4" aria-hidden /> Approve
                    </Button>
                    <Button
                      variant="outline" onClick={() => onReject(invoice)} disabled={busy}
                      className="min-h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                      aria-label={`Reject invoice ${invoice.invoiceCode} with a note`}
                    >
                      <X className="h-4 w-4" aria-hidden /> Reject
                    </Button>
                    <Button
                      variant="outline" onClick={() => onDispute(invoice)} disabled={busy}
                      className="min-h-11 gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-50 hover:text-orange-800"
                      aria-label={`Dispute invoice ${invoice.invoiceCode}`}
                    >
                      <AlertTriangle className="h-4 w-4" aria-hidden /> Dispute
                    </Button>
                  </>
                )}
                {isDecider && invoice.status === 'disputed' && (
                  <Button
                    onClick={() => onApprove(invoice)} disabled={busy}
                    className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                    aria-label={`Re-approve invoice ${invoice.invoiceCode} after dispute resolution`}
                  >
                    <Check className="h-4 w-4" aria-hidden /> Re-approve
                  </Button>
                )}
                {isDecider && invoice.status === 'approved' && (
                  <Button
                    onClick={() => onPay(invoice)} disabled={busy}
                    className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                    aria-label={`Record payment for invoice ${invoice.invoiceCode}`}
                  >
                    <Banknote className="h-4 w-4" aria-hidden /> Record payment
                  </Button>
                )}
                {invoice.status === 'approved' && !isDecider && (
                  <p className="flex items-center gap-1.5 text-xs text-stone-500">
                    <ShieldCheck className="h-3.5 w-3.5 text-stone-400" aria-hidden /> Awaiting payment — only the client records it
                  </p>
                )}
                {invoice.status === 'draft' && !isSiteTeam && (
                  <p className="flex items-center gap-1.5 text-xs text-stone-500">
                    <FileText className="h-3.5 w-3.5 text-stone-400" aria-hidden /> Draft — the site team submits it for your decision
                  </p>
                )}
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
