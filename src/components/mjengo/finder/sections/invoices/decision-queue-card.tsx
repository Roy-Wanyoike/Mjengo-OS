'use client'

// Client decision queue card — the first thing in the invoices section when
// an invoice is SUBMITTED (or DISPUTED and awaiting re-approval). The client
// surface gets Approve / Reject-with-note / Dispute; the site team sees the
// same queue read-only ("awaiting client decision") — the server enforces the
// role, the UI never fakes the permission.

import { Button } from '@/components/ui/button'
import { AlertTriangle, Check, Eye, MoreHorizontal, ShieldCheck, X } from 'lucide-react'
import { dateShort } from '@/lib/format'
import type { InvoiceWithLines, ThreeWayReport } from '@/modules/invoices/types'
import { InvoiceStatusBadge, ThreeWayChip, formatKes, fmtQty } from './invoice-bits'

interface Props {
  invoice: InvoiceWithLines
  report: ThreeWayReport
  clientName: string
  isDecider: boolean
  busy: boolean
  onApprove: (invoice: InvoiceWithLines) => void
  onReject: (invoice: InvoiceWithLines) => void
  onDispute: (invoice: InvoiceWithLines) => void
  onOpen: (invoice: InvoiceWithLines) => void
}

export function DecisionQueueCard({
  invoice, report, clientName, isDecider, busy, onApprove, onReject, onDispute, onOpen,
}: Props) {
  const disputed = invoice.status === 'disputed'
  const preview = invoice.lines.slice(0, 3)
  const hidden = invoice.lines.length - preview.length

  return (
    <div className={`rounded-lg border bg-white p-4 ${disputed ? 'border-orange-300' : 'border-amber-300'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-mono text-sm font-semibold text-stone-900">{invoice.invoiceCode}</p>
            <InvoiceStatusBadge status={invoice.status} />
            <ThreeWayChip report={report} />
          </div>
          <p className="pt-1 text-sm text-stone-700">
            {invoice.supplierName ?? 'Supplier not recorded'}
            {invoice.orderCode && <span className="text-stone-400"> · {invoice.orderCode}</span>}
          </p>
          <p className="pt-0.5 text-xs text-stone-400">
            {invoice.submittedAt ? `submitted ${dateShort(invoice.submittedAt)}` : ''}
            {invoice.dueDate ? ` · due ${dateShort(invoice.dueDate)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="text-base font-bold tabular-nums text-stone-900">{formatKes(invoice.total)}</span>
          <Button size="sm" variant="ghost" className="h-8 min-h-8 gap-1 px-2 text-xs text-stone-500" onClick={() => onOpen(invoice)} aria-label={`Open invoice ${invoice.invoiceCode} details`}>
            <Eye className="h-3.5 w-3.5" aria-hidden /> Details
          </Button>
        </div>
      </div>

      {/* lines preview */}
      <div className="mt-3 rounded-md bg-stone-50 px-3 py-2">
        {preview.map((l) => (
          <p key={l.id} className="flex items-baseline justify-between gap-3 py-0.5 text-xs text-stone-600">
            <span className="min-w-0 truncate">{l.name} × {fmtQty(l.qty)}</span>
            <span className="shrink-0 tabular-nums text-stone-500">{formatKes(l.lineTotal)}</span>
          </p>
        ))}
        {hidden > 0 && (
          <p className="flex items-center gap-1 pt-0.5 text-[11px] text-stone-400">
            <MoreHorizontal className="h-3 w-3" aria-hidden /> {hidden} more line{hidden === 1 ? '' : 's'} — open details
          </p>
        )}
      </div>

      {/* open review items — honest, never an accusation */}
      {report.mismatches.length > 0 && (
        <div className="mt-3 space-y-1.5 rounded-md border border-amber-200 bg-amber-50 p-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> 3-way match — {report.mismatches.length} open item{report.mismatches.length === 1 ? '' : 's'}, review before paying
          </p>
          {report.mismatches.slice(0, 2).map((m, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-amber-800">• {m.name}: {m.issue}</p>
          ))}
          {report.mismatches.length > 2 && (
            <p className="text-[11px] text-amber-700">+{report.mismatches.length - 2} more in details</p>
          )}
        </div>
      )}

      {/* decision panel */}
      <div className={`mt-3 space-y-2 rounded-lg border p-3 ${disputed ? 'border-orange-200 bg-orange-50' : 'border-amber-200 bg-amber-50'}`}>
        <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          {isDecider
            ? disputed
              ? 'Disputed — re-approve after reconciling with the supplier, or reject'
              : `Client decision — ${clientName} approves, rejects or disputes`
            : disputed
              ? 'Disputed — awaiting reconciliation with the supplier, then a client re-approval'
              : `Awaiting client decision — ${clientName} decides from the client view`}
        </p>
        {isDecider && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm" className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={busy}
              onClick={() => onApprove(invoice)}
              aria-label={`Approve invoice ${invoice.invoiceCode}`}
            >
              <Check className="h-4 w-4" aria-hidden /> {disputed ? 'Re-approve' : 'Approve'}
            </Button>
            <Button
              size="sm" variant="outline" className="min-h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
              disabled={busy}
              onClick={() => onReject(invoice)}
              aria-label={`Reject invoice ${invoice.invoiceCode} with a note`}
            >
              <X className="h-4 w-4" aria-hidden /> Reject with note
            </Button>
            {!disputed && (
              <Button
                size="sm" variant="outline" className="min-h-11 gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-50 hover:text-orange-800"
                disabled={busy}
                onClick={() => onDispute(invoice)}
                aria-label={`Dispute invoice ${invoice.invoiceCode} with a note`}
              >
                <AlertTriangle className="h-4 w-4" aria-hidden /> Dispute
              </Button>
            )}
          </div>
        )}
        {!isDecider && (
          <p className="text-[11px] text-stone-500">
            Server-enforced: only the client role can record this decision — site-team attempts fail honestly.
          </p>
        )}
      </div>

      {/* dispute note */}
      {disputed && invoice.note && (
        <p className="mt-2 rounded-md bg-orange-50 px-2.5 py-1.5 text-xs text-orange-800">
          Dispute note: “{invoice.note}”{invoice.decidedBy ? ` — filed by ${invoice.decidedBy}` : ''}
        </p>
      )}
      {disputed && !invoice.note && invoice.decidedBy && (
        <p className="mt-2 text-[11px] text-stone-400">Disputed by {invoice.decidedBy}</p>
      )}
      {invoice.decidedBy && !disputed && (
        <p className="mt-2 rounded-md bg-stone-50 px-2.5 py-1.5 text-xs text-stone-500">
          Decided by <span className="font-medium">{invoice.decidedBy}</span>
          {invoice.decidedAt ? ` · ${dateShort(invoice.decidedAt)}` : ''}
        </p>
      )}
    </div>
  )
}
