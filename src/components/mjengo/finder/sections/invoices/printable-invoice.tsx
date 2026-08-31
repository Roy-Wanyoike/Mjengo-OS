'use client'

// Printable invoice — a clean, print-only record of a platform transaction.
// Rendered in a hidden container; window.print() prints ONLY this block via
// the visibility technique (no shared-file changes needed). Explicitly NOT a
// tax document — the footer says so.

import { dateShort } from '@/lib/format'
import type { InvoiceWithLines } from '@/modules/invoices/types'
import { fmtQty } from './invoice-bits'

interface Props {
  invoice: InvoiceWithLines
  projectName: string
  clientName: string
  location: string | null
}

function money(n: number): string {
  return `KSh ${Math.round(n).toLocaleString('en-KE')}`
}

export function PrintableInvoice({ invoice, projectName, clientName, location }: Props) {
  return (
    <div id="mjengo-print-root" className="hidden print:block fixed inset-0 z-[999] bg-white p-8 text-stone-900">
      {/* header */}
      <div className="flex items-start justify-between border-b-2 border-stone-800 pb-4">
        <div>
          <p className="text-2xl font-black tracking-tight">Mjengo<span className="text-amber-600">OS</span></p>
          <p className="text-xs text-stone-500">Construction procurement &amp; site record</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-widest text-stone-400">Invoice record</p>
          <p className="font-mono text-lg font-bold">{invoice.invoiceCode}</p>
          <p className="text-xs text-stone-500">{invoice.status.toUpperCase()}</p>
        </div>
      </div>

      {/* parties */}
      <div className="grid grid-cols-2 gap-6 pt-4 text-xs">
        <div>
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">Supplier</p>
          <p className="font-medium">{invoice.supplierName ?? 'Not recorded'}</p>
          {invoice.createdBy && <p className="text-stone-500">Issued by {invoice.createdBy}</p>}
        </div>
        <div className="text-right">
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">Project / client</p>
          <p className="font-medium">{projectName}</p>
          <p className="text-stone-500">{clientName}{location ? ` · ${location}` : ''}</p>
        </div>
      </div>

      {/* meta */}
      <div className="grid grid-cols-3 gap-4 pt-4 text-xs">
        <div><span className="text-stone-400">Issued: </span><span className="font-medium">{invoice.issuedAt ? dateShort(invoice.issuedAt) : '—'}</span></div>
        <div><span className="text-stone-400">Due: </span><span className="font-medium">{invoice.dueDate ? dateShort(invoice.dueDate) : '—'}</span></div>
        <div><span className="text-stone-400">PO: </span><span className="font-mono font-medium">{invoice.orderCode ?? 'none'}</span></div>
      </div>

      {/* lines */}
      <table className="mt-6 w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-stone-300 text-left uppercase tracking-wide text-stone-400">
            <th className="py-2 font-medium">Item</th>
            <th className="py-2 text-right font-medium">Qty</th>
            <th className="py-2 text-right font-medium">Unit price</th>
            <th className="py-2 text-right font-medium">Line total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.id} className="border-b border-stone-100">
              <td className="py-2">{l.name}</td>
              <td className="py-2 text-right tabular-nums">{fmtQty(l.qty)}</td>
              <td className="py-2 text-right tabular-nums">{money(l.unitPrice)}</td>
              <td className="py-2 text-right tabular-nums">{money(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* totals */}
      <div className="mt-4 ml-auto w-56 text-xs">
        <div className="flex justify-between py-1"><span className="text-stone-500">Subtotal</span><span className="tabular-nums">{money(invoice.subtotal)}</span></div>
        <div className="flex justify-between py-1"><span className="text-stone-500">Tax</span><span className="tabular-nums">{money(invoice.tax)}</span></div>
        <div className="flex justify-between border-t border-stone-800 py-2 text-sm font-bold"><span>Total</span><span className="tabular-nums">{money(invoice.total)}</span></div>
      </div>

      {/* payment record */}
      {invoice.status === 'paid' && (
        <div className="mt-6 border border-stone-200 p-3 text-xs">
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">Payment record</p>
          <p>
            Paid {invoice.paidAt ? dateShort(invoice.paidAt) : ''} via {(invoice.paymentMethod ?? '').toUpperCase()}
            {invoice.paymentReference ? ` · reference ${invoice.paymentReference}` : ''}
            {invoice.paidByRole ? ` · recorded by ${invoice.paidByRole}` : ''} — ledgered as a platform Transaction.
          </p>
        </div>
      )}
      {invoice.status !== 'paid' && (
        <div className="mt-6 border border-stone-200 p-3 text-xs text-stone-500">
          <p className="pb-1 font-semibold uppercase tracking-wide text-stone-400">Payment record</p>
          <p>Not yet paid — this invoice is {invoice.status.toUpperCase()} on the platform.</p>
        </div>
      )}

      {invoice.note && <p className="mt-4 text-xs text-stone-500">Note: {invoice.note}</p>}

      {/* footer */}
      <p className="mt-8 border-t border-stone-200 pt-3 text-center text-[10px] text-stone-400">
        Generated by MjengoOS — record of a platform transaction (not a tax document). {new Date().toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })}
      </p>
    </div>
  )
}
