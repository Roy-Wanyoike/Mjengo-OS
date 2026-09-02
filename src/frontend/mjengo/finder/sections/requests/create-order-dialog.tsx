'use client'

// Create-PO dialog (Finder §12): approved request + selected supplier →
// PO-YYYY-000NNN. Lines price from the supplier's catalog by name match
// (quote price fallback — the server re-prices authoritatively; this preview
// uses the same rules). The request's approval counts, so the PO is born
// approved and can be sent straight away.

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Button } from '@/frontend/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { materialMatches } from '@/backend/modules/supply/compare'
import { materialKey } from '@/backend/modules/supply/insights'
import type { QuoteDetail, RequestWithLines, SupplierWithCatalog } from '@/backend/modules/supply/types'
import { formatKes } from './bits'

const PAYMENT_SOURCES: Array<{ value: string; label: string }> = [
  { value: 'client', label: 'Client pays (invoice)' },
  { value: 'contractor', label: 'Contractor pays' },
  { value: 'project_wallet', label: 'Project wallet' },
  { value: 'finance', label: 'Finance' },
]

export function CreateOrderDialog({
  request, suppliers, open, onOpenChange,
}: {
  request: RequestWithLines | null
  suppliers: SupplierWithCatalog[]
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox, actionBusy } = useMjengo()
  const [supplierId, setSupplierId] = useState('')
  const [quoteId, setQuoteId] = useState('')
  const [paymentSource, setPaymentSource] = useState('client')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = actionBusy !== null || saving
  const offlineNote = `Saved on-device — queued (${outbox.length})`

  const receivedQuotes = (request?.quotes ?? []).filter((q) => q.status === 'received' && q.totalLanded > 0)
  const bestQuote = receivedQuotes.length
    ? receivedQuotes.reduce((a, b) => (b.totalLanded < a.totalLanded ? b : a))
    : null

  // Suppliers that can price every line (catalog stock by name), ranked:
  // quoted suppliers first (best landed first), then catalog-only suppliers.
  // Cheap to compute per render — no memoization needed.
  const eligible: Array<{ supplier: SupplierWithCatalog; quote: QuoteDetail | null; rank: number }> = []
  if (request) {
    for (const s of suppliers) {
      const covers = request.lines.every((line) =>
        s.catalogItems.some(
          (c) => materialKey(c.name) === materialKey(line.materialName) || materialMatches(c.name, line.materialName),
        ),
      )
      if (!covers) continue
      const quote = receivedQuotes.find((q) => q.supplierId === s.id) ?? null
      eligible.push({ supplier: s, quote, rank: quote ? quote.totalLanded : Number.MAX_SAFE_INTEGER })
    }
    eligible.sort((a, b) => a.rank - b.rank)
  }

  const selected = eligible.find((e) => e.supplier.id === supplierId) ?? null

  // Preview pricing — same rules as the server (catalog match, quote fallback);
  // computed per render (cheap, no memoization needed)
  let preview: { lines: Array<{ name: string; qty: number; unitPrice: number | null }>; subtotal: number; deliveryFee: number; total: number } | null = null
  if (request && selected) {
    const lines: Array<{ name: string; qty: number; unitPrice: number | null }> = request.lines.map((line) => {
      const item =
        selected.supplier.catalogItems.find((c) => materialKey(c.name) === materialKey(line.materialName)) ??
        selected.supplier.catalogItems.find((c) => materialMatches(c.name, line.materialName))
      let unitPrice: number | null = item?.unitPrice ?? null
      if (unitPrice === null && selected.quote && request.lines[0]?.id === line.id) unitPrice = selected.quote.unitPrice
      return { name: line.materialName, qty: line.qty, unitPrice }
    })
    const priced = lines.filter((l): l is { name: string; qty: number; unitPrice: number } => l.unitPrice !== null)
    const subtotal = Math.round(priced.reduce((s, l) => s + l.unitPrice * l.qty, 0) * 100) / 100
    const supplier = selected.supplier
    const deliveryFee =
      supplier.freeDeliveryOver !== null && subtotal >= supplier.freeDeliveryOver ? 0 : supplier.deliveryFeeBase
    preview = { lines, subtotal, deliveryFee, total: Math.round((subtotal + deliveryFee) * 100) / 100 }
  }

  async function create() {
    if (!request || !supplierId) { toast.error('Pick a supplier for the purchase order'); return }
    setSaving(true)
    const ok = await dispatch('order.create', {
      requestId: request.id,
      supplierId,
      quoteId: quoteId || undefined,
      paymentSource,
      note: note.trim() || undefined,
    }, `PO created from ${request.requestCode}`)
    setSaving(false)
    if (ok) {
      toast.success(online ? 'Purchase order created — it inherits the request approval, send it to the supplier' : offlineNote)
      onOpenChange(false)
      setSupplierId(''); setQuoteId(''); setNote('')
    } else toast.error('Could not create the PO — check the supplier stocks every line')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create purchase order — {request?.requestCode}</DialogTitle>
          <DialogDescription>
            The request is approved, so the PO is born approved. Lines price from the supplier&apos;s catalog (quote price as fallback).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="po-supplier">Supplier</Label>
            <Select value={supplierId} onValueChange={(v) => { setSupplierId(v); const hit = eligible.find((e) => e.supplier.id === v); setQuoteId(hit?.quote?.id ?? '') }}>
              <SelectTrigger id="po-supplier"><SelectValue placeholder="Pick a supplier" /></SelectTrigger>
              <SelectContent>
                {eligible.map(({ supplier, quote }) => (
                  <SelectItem key={supplier.id} value={supplier.id}>
                    {supplier.businessName}
                    {quote ? ` — quote ${formatKes(quote.totalLanded)}` : ' — catalog prices'}
                  </SelectItem>
                ))}
                {!eligible.length && <p className="px-3 py-2 text-xs text-stone-500">No supplier stocks every line — request quotes first.</p>}
              </SelectContent>
            </Select>
            {bestQuote && !quoteId && (
              <p className="text-[11px] text-stone-500">Best quote so far: {bestQuote.supplierName} at {formatKes(bestQuote.totalLanded)}.</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="po-payment">Payment source</Label>
            <Select value={paymentSource} onValueChange={setPaymentSource}>
              <SelectTrigger id="po-payment"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_SOURCES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="po-note">Note (optional)</Label>
            <Input id="po-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Deliver before the ring-beam pour" />
          </div>

          {preview && (
            <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
              <p className="pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">Preview (server re-prices)</p>
              <ul className="space-y-1 text-sm">
                {preview.lines.map((l) => (
                  <li key={l.name} className="flex justify-between gap-2 tabular-nums">
                    <span className="min-w-0 truncate text-stone-600">{l.name}</span>
                    <span className="shrink-0 text-stone-800">
                      {l.unitPrice === null ? <span className="text-rose-600">cannot price</span> : `${formatKes(l.unitPrice)} × ${l.qty}`}
                    </span>
                  </li>
                ))}
              </ul>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 border-t border-stone-200 pt-2 text-sm tabular-nums">
                <dt className="text-stone-500">Subtotal</dt><dd className="text-right text-stone-800">{formatKes(preview.subtotal)}</dd>
                <dt className="text-stone-500">Delivery fee{preview.deliveryFee === 0 ? ' (waived)' : ''}</dt><dd className="text-right text-stone-800">{formatKes(preview.deliveryFee)}</dd>
                <dt className="border-t border-stone-200 pt-1 font-medium text-stone-700">Total</dt>
                <dd className="border-t border-stone-200 pt-1 text-right text-base font-bold text-stone-900">{formatKes(preview.total)}</dd>
              </dl>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy || !supplierId} onClick={() => void create()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Create PO
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
