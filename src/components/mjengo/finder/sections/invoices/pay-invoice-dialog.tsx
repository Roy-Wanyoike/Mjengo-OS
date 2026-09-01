'use client'

// Record-payment dialog (only APPROVED invoices, only the payer surface).
// Money mutations get deliberate confirmations (money-tab house style):
//   step 1 "form"   — method, reference (auto-suggested), mismatch banner +
//                     the reviewed-discrepancy checkbox (the human decision)
//   step 2 "confirm"— one deliberate click; the payment writes a permanent
//                     Transaction ledger entry (type 'invoice', never mutated)
// The 3-way check also runs SERVER-side on invoice.pay; a mismatched payment
// only lands when acknowledgeMismatch was set — the checkbox is that decision.

import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { AlertTriangle, Banknote, BookOpen, Check, ShieldCheck } from 'lucide-react'
import type { InvoiceWithLines, ThreeWayReport } from '@/modules/invoices/types'
import { PAYMENT_METHOD_LABELS, formatKes } from './invoice-bits'

/** Same auto-reference shape the server generates (money.ts helper). */
function previewReference(method: string): string {
  const prefix = method === 'bank' ? 'BANK' : method === 'card' ? 'CARD' : method === 'wallet' ? 'WALLET' : method === 'cash' ? 'CASH' : 'MPESA'
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let suffix = ''
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
  return `${prefix}-${suffix}`
}

interface Props {
  invoice: InvoiceWithLines | null
  report: ThreeWayReport | null
  walletBalance: number
  busy: boolean
  onConfirm: (payload: { method: string; reference: string; costCode: string | null; acknowledgeMismatch: boolean }) => void
  onClose: () => void
}

export function PayInvoiceDialog({ invoice, report, walletBalance, busy, onConfirm, onClose }: Props) {
  const [method, setMethod] = useState('mpesa')
  const [reference, setReference] = useState('')
  const [useAutoRef, setUseAutoRef] = useState(true)
  const [costCode, setCostCode] = useState('')
  const [ack, setAck] = useState(false)
  const [step, setStep] = useState<'form' | 'confirm'>('form')

  const autoRef = useMemo(() => previewReference(method), [method])
  const mismatches = report?.mismatches ?? []
  const hasMismatch = mismatches.length > 0
  const walletShort = method === 'wallet' && invoice ? walletBalance < invoice.total : false
  const finalReference = useAutoRef || !reference.trim() ? autoRef : reference.trim()

  function reset() {
    setMethod('mpesa')
    setReference('')
    setUseAutoRef(true)
    setCostCode('')
    setAck(false)
    setStep('form')
  }

  const formValid = invoice
    ? (!hasMismatch || ack) && !walletShort && (useAutoRef || reference.trim().length > 0)
    : false

  return (
    <Dialog
      open={invoice !== null}
      onOpenChange={(open) => {
        if (!open) { onClose(); reset() }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-stone-900">Record payment</DialogTitle>
          <DialogDescription>
            {invoice
              ? `${invoice.invoiceCode} — ${formatKes(invoice.total)} to ${invoice.supplierName ?? 'the supplier'}${invoice.orderCode ? ` (${invoice.orderCode})` : ''}. Payment writes a permanent ledger entry.`
              : ''}
          </DialogDescription>
        </DialogHeader>

        {invoice && step === 'form' && (
          <div className="grid gap-4 py-1">
            {/* method */}
            <div className="space-y-2">
              <Label>Payment method</Label>
              <RadioGroup value={method} onValueChange={setMethod} className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Payment method">
                {Object.entries(PAYMENT_METHOD_LABELS).map(([value, meta]) => (
                  <label
                    key={value}
                    htmlFor={`pay-method-${value}`}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-stone-200 px-3 text-sm text-stone-700 transition has-[[data-state=checked]]:border-amber-500 has-[[data-state=checked]]:bg-amber-50"
                  >
                    <RadioGroupItem value={value} id={`pay-method-${value}`} />
                    <span className="min-w-0">
                      <span className="block truncate">{meta.label}</span>
                      <span className="block text-[10px] text-stone-400">{meta.hint}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              {method === 'wallet' && (
                <p className={`rounded-md p-2.5 text-xs ${walletShort ? 'bg-rose-50 text-rose-700' : 'bg-stone-50 text-stone-500'}`}>
                  Escrow wallet holds <span className="font-semibold tabular-nums">{formatKes(walletBalance)}</span>
                  {walletShort ? ' — insufficient. Top up the wallet first or choose another method.' : ` · paying releases ${formatKes(invoice.total)} from escrow.`}
                </p>
              )}
            </div>

            {/* reference */}
            <div className="space-y-2">
              <Label htmlFor="pay-reference">Payment reference</Label>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="pay-auto-ref"
                  checked={useAutoRef}
                  onCheckedChange={(v) => setUseAutoRef(Boolean(v))}
                  aria-label="Use an auto-generated reference"
                />
                <label htmlFor="pay-auto-ref" className="cursor-pointer text-sm text-stone-700">
                  Auto <span className="font-mono text-xs text-stone-500">{autoRef}</span>
                </label>
              </div>
              {!useAutoRef && (
                <Input
                  id="pay-reference" value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="e.g. MPESA-8HKT4Q2A / cheque no." className="font-mono"
                  aria-label="Custom payment reference"
                />
              )}
              <p className="text-[11px] text-stone-400">Provider-agnostic record — never hard-coded to one rail.</p>
            </div>

            {/* cost code (optional, F-MONEY) — the finance dimension on the ledger row */}
            <div className="space-y-2">
              <Label htmlFor="pay-cost-code">Cost code (optional)</Label>
              <Input
                id="pay-cost-code"
                value={costCode}
                onChange={(e) => setCostCode(e.target.value)}
                placeholder="e.g. materials / transport / finishing — defaults to ‘invoice’"
                aria-label="Optional finance cost code for this payment"
              />
              <p className="text-[11px] text-stone-400">Tag the ledger row with a cost code so finance reports slice spend honestly.</p>
            </div>

            {/* mismatch banner + reviewed-discrepancy checkbox — the human decision */}
            {hasMismatch && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  3-way match — {mismatches.length} open item{mismatches.length === 1 ? '' : 's'} on this invoice
                </p>
                <ul className="space-y-1">
                  {mismatches.slice(0, 4).map((m, i) => (
                    <li key={i} className="text-[11px] leading-relaxed text-amber-800">• {m.name}: {m.issue}</li>
                  ))}
                  {mismatches.length > 4 && <li className="text-[11px] text-amber-700">+{mismatches.length - 4} more</li>}
                </ul>
                <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md border border-amber-300 bg-white p-2.5">
                  <Checkbox
                    checked={ack}
                    onCheckedChange={(v) => setAck(Boolean(v))}
                    aria-label="I have reviewed the discrepancy with the supplier"
                    className="mt-0.5"
                  />
                  <span className="text-xs leading-relaxed text-stone-700">
                    I have reviewed the discrepancy with the supplier and choose to pay {formatKes(invoice.total)} anyway.
                    This decision is recorded in the audit trail.
                  </span>
                </label>
                <p className="text-[10px] leading-relaxed text-amber-700">
                  The system recommends review — it never silently releases unmatched amounts, and it never decides for you.
                </p>
              </div>
            )}

            <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-[11px] leading-relaxed text-stone-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              Simulated rails — Daraja/bank sandbox wiring pending. The reference and method are recorded exactly as entered; one Transaction entry, never edited afterwards.
            </p>
          </div>
        )}

        {invoice && step === 'confirm' && (
          <div className="grid gap-4 py-1">
            <div className="space-y-1.5 rounded-md border border-stone-200 p-3 text-sm">
              <p className="flex items-center justify-between gap-3">
                <span className="text-stone-500">Amount</span>
                <span className="font-bold tabular-nums text-stone-900">{formatKes(invoice.total)}</span>
              </p>
              <p className="flex items-center justify-between gap-3">
                <span className="text-stone-500">Method</span>
                <span className="font-medium text-stone-800">{PAYMENT_METHOD_LABELS[method]?.label ?? method}</span>
              </p>
              <p className="flex items-center justify-between gap-3">
                <span className="text-stone-500">Reference</span>
                <span className="font-mono text-xs text-stone-800">{finalReference}</span>
              </p>
              <p className="flex items-center justify-between gap-3">
                <span className="text-stone-500">Cost code</span>
                <span className="font-mono text-xs text-stone-800">{costCode.trim() || 'invoice'}</span>
              </p>
              {method === 'wallet' && (
                <p className="flex items-center justify-between gap-3">
                  <span className="text-stone-500">Wallet after</span>
                  <span className="font-medium tabular-nums text-stone-800">{formatKes(Math.max(0, walletBalance - invoice.total))}</span>
                </p>
              )}
              {hasMismatch && (
                <p className="flex items-center justify-between gap-3">
                  <span className="text-stone-500">3-way items</span>
                  <span className="font-medium text-amber-800">{mismatches.length} reviewed &amp; acknowledged</span>
                </p>
              )}
            </div>
            <p className="flex items-start gap-1.5 rounded-md bg-stone-50 p-2.5 text-xs leading-relaxed text-stone-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              One deliberate click, not two accidental ones — the payment is recorded in the append-only ledger and cannot be edited afterwards.
            </p>
          </div>
        )}

        <DialogFooter>
          {step === 'form' ? (
            <>
              <Button variant="outline" onClick={() => { onClose(); reset() }} disabled={busy}>Cancel</Button>
              <Button
                onClick={() => setStep('confirm')}
                disabled={busy || !formValid}
                className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                <Banknote className="h-4 w-4" aria-hidden /> Continue
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep('form')} disabled={busy}>Back</Button>
              <Button
                onClick={() => {
                  onConfirm({ method, reference: finalReference, costCode: costCode.trim() || null, acknowledgeMismatch: hasMismatch })
                  reset()
                }}
                disabled={busy}
                className="min-h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              >
                <Check className="h-4 w-4" aria-hidden /> Confirm payment
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Paid-state chip shown in lists/details: method + reference (+ ledger ref). */
export function PaymentRecordBadge({ invoice, ledgerRef }: { invoice: InvoiceWithLines; ledgerRef?: string | null }) {
  if (invoice.status !== 'paid') return null
  return (
    <Badge variant="outline" className="gap-1 font-mono text-[10px] text-stone-600">
      <Banknote className="h-3 w-3" aria-hidden />
      {(invoice.paymentMethod ?? '').toUpperCase()}{invoice.paymentReference ? ` · ${invoice.paymentReference}` : ''}
      {ledgerRef && (
        <span className="flex items-center gap-0.5 text-stone-500" title="Double-entry ledger transaction">
          <BookOpen className="h-3 w-3" aria-hidden /> {ledgerRef}
        </span>
      )}
    </Badge>
  )
}
