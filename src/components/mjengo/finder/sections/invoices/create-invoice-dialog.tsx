'use client'

// Create-invoice dialog — drafts a supplier invoice, optionally linked to a
// purchase order (supplier + lines pre-filled from the PO, including its
// delivery fee as a line). Totals shown live are advisory only: the server
// recomputes every lineTotal/subtotal/tax/total (client sums never trusted).
// Result is a DRAFT — submit moves it into the client decision queue.

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Plus, ReceiptText, Trash2 } from 'lucide-react'
import type { ProjectPayload } from '@/lib/mjengo'
import { formatKes } from './invoice-bits'

type OrderRow = ProjectPayload['supply']['orders'][number]
type SupplierRow = ProjectPayload['supply']['suppliers'][number]

interface DraftLine {
  name: string
  qty: string
  unitPrice: string
}

interface Props {
  open: boolean
  orders: OrderRow[]
  suppliers: SupplierRow[]
  busy: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (payload: {
    orderId?: string
    supplierId?: string
    lines: { name: string; qty: number; unitPrice: number }[]
    tax?: number
    dueDate?: string
    note?: string
  }) => void
}

/** Billable POs — anything not cancelled (2-c's flow may keep them at any stage). */
const BILLABLE_ORDER_STATUSES = ['approved', 'sent', 'confirmed', 'delivering', 'delivered', 'closed']

export function CreateInvoiceDialog({ open, orders, suppliers, busy, onOpenChange, onCreate }: Props) {
  const billable = useMemo(() => orders.filter((o) => BILLABLE_ORDER_STATUSES.includes(o.status)), [orders])
  const [orderId, setOrderId] = useState<string>('none')
  const [supplierId, setSupplierId] = useState<string>('none')
  const [lines, setLines] = useState<DraftLine[]>([{ name: '', qty: '', unitPrice: '' }])
  const [tax, setTax] = useState('0')
  const [dueDate, setDueDate] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const selectedOrder = orderId === 'none' ? null : billable.find((o) => o.id === orderId) ?? null

  /** Pre-fill lines from a PO: material lines + its delivery fee as a line. */
  function prefillLines(value: string): DraftLine[] {
    const po = value === 'none' ? null : billable.find((o) => o.id === value) ?? null
    if (!po) return [{ name: '', qty: '', unitPrice: '' }]
    const pre: DraftLine[] = po.lines.map((l) => ({
      name: l.name,
      qty: String(l.qty),
      unitPrice: String(l.unitPrice),
    }))
    if (po.deliveryFee > 0) {
      pre.push({ name: `Delivery — ${po.supplierName} to site`, qty: '1', unitPrice: String(po.deliveryFee) })
    }
    return pre.length ? pre : [{ name: '', qty: '', unitPrice: '' }]
  }

  function handleOrderChange(value: string) {
    setOrderId(value)
    setLines(prefillLines(value))
    setError(null)
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next)
    if (!next) {
      setOrderId('none'); setSupplierId('none'); setTax('0'); setDueDate(''); setNote(''); setError(null)
      setLines([{ name: '', qty: '', unitPrice: '' }])
    }
  }

  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0)
  const total = subtotal + (Number(tax) || 0)

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  function submit() {
    setError(null)
    const payloadLines: { name: string; qty: number; unitPrice: number }[] = []
    for (const l of lines) {
      const name = l.name.trim()
      const qty = Number(l.qty)
      const price = Number(l.unitPrice)
      if (!name && !l.qty && !l.unitPrice) continue // skip fully-blank rows
      if (!name) { setError('Every line needs a name'); return }
      if (!Number.isFinite(qty) || qty <= 0) { setError(`Line "${name}": quantity must be greater than zero`); return }
      if (!Number.isFinite(price) || price < 0) { setError(`Line "${name}": unit price must be zero or more`); return }
      payloadLines.push({ name, qty, unitPrice: price })
    }
    if (!payloadLines.length) { setError('Add at least one invoice line'); return }
    const taxNum = Number(tax) || 0
    if (taxNum < 0) { setError('Tax must be zero or more'); return }

    onCreate({
      orderId: selectedOrder?.id,
      supplierId: selectedOrder ? undefined : supplierId === 'none' ? undefined : supplierId,
      lines: payloadLines,
      tax: taxNum || undefined,
      dueDate: dueDate || undefined,
      note: note.trim() || undefined,
    })
    // reset for the next open (the parent closes the dialog on success)
    setOrderId('none'); setSupplierId('none'); setTax('0'); setDueDate(''); setNote('')
    setLines([{ name: '', qty: '', unitPrice: '' }])
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { handleOpenChange(o) }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-stone-900">New supplier invoice</DialogTitle>
          <DialogDescription>
            Draft an invoice for the client to decide on. Link it to a purchase order to pre-fill the supplier, lines and delivery fee —
            the 3-way match then compares PO ↔ invoice ↔ delivery before any payment.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>From purchase order</Label>
              <Select value={orderId} onValueChange={handleOrderChange}>
                <SelectTrigger aria-label="Purchase order"><SelectValue placeholder="Choose a PO" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Standalone (no PO)</SelectItem>
                  {billable.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.orderCode} · {o.supplierName} · {formatKes(o.total)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-stone-400">
                {selectedOrder
                  ? `Pre-filled from ${selectedOrder.orderCode} — ${selectedOrder.status.replace('_', ' ')}. Server recomputes all totals.`
                  : 'No PO link → the invoice runs a 2-way check (invoice vs delivery records).'}
              </p>
            </div>

            {!selectedOrder && (
              <div className="space-y-2">
                <Label>Supplier</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger aria-label="Supplier"><SelectValue placeholder="Optional" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not recorded</SelectItem>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.businessName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-stone-400">Suppliers from the Finder network.</p>
              </div>
            )}

            {selectedOrder && (
              <div className="space-y-2">
                <Label>Supplier (from PO)</Label>
                <p className="min-h-11 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm text-stone-700">
                  {selectedOrder.supplierName}
                </p>
              </div>
            )}
          </div>

          {/* lines editor */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Lines</Label>
              <Button
                size="sm" variant="outline" className="h-8 min-h-8 gap-1 text-xs"
                onClick={() => setLines((prev) => [...prev, { name: '', qty: '', unitPrice: '' }])}
                aria-label="Add a line"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
              </Button>
            </div>
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1" role="region" aria-label="Invoice lines, scrollable">
              {lines.map((l, i) => {
                const lineTotal = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0)
                return (
                  <div key={i} className="grid grid-cols-[minmax(0,1fr)_76px_100px_84px] items-center gap-2">
                    <Input
                      value={l.name}
                      onChange={(e) => updateLine(i, { name: e.target.value })}
                      placeholder="e.g. Cement 50kg (32.5N)"
                      aria-label={`Line ${i + 1} name`}
                      className="text-sm"
                    />
                    <Input
                      type="number" min="0" value={l.qty}
                      onChange={(e) => updateLine(i, { qty: e.target.value })}
                      placeholder="Qty" inputMode="decimal"
                      aria-label={`Line ${i + 1} quantity`}
                      className="text-sm"
                    />
                    <Input
                      type="number" min="0" value={l.unitPrice}
                      onChange={(e) => updateLine(i, { unitPrice: e.target.value })}
                      placeholder="Unit KSh" inputMode="numeric"
                      aria-label={`Line ${i + 1} unit price`}
                      className="text-sm"
                    />
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-xs tabular-nums text-stone-500">{formatKes(lineTotal)}</span>
                      <Button
                        size="sm" variant="ghost" className="h-8 w-8 min-h-8 min-w-8 p-0 text-stone-400 hover:text-rose-600"
                        onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))}
                        aria-label={`Remove line ${i + 1}`}
                        disabled={lines.length <= 1}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="inv-tax">Tax / VAT (KSh)</Label>
              <Input id="inv-tax" type="number" min="0" value={tax} onChange={(e) => setTax(e.target.value)} inputMode="numeric" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-due">Due date</Label>
              <Input id="inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Totals (advisory)</Label>
              <p className="min-h-11 rounded-md bg-stone-50 px-3 py-2.5 text-sm tabular-nums text-stone-700">
                {formatKes(subtotal)} + {formatKes(Number(tax) || 0)} = <span className="font-semibold text-stone-900">{formatKes(total)}</span>
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="inv-note">Note (optional)</Label>
            <Textarea id="inv-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. For PO-2026-000012 — DN-8812 attached" />
          </div>

          {error && <p className="rounded-md bg-rose-50 p-2.5 text-xs text-rose-700">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => submit()}
            disabled={busy}
            className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
          >
            <ReceiptText className="h-4 w-4" aria-hidden /> Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
