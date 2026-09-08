'use client'

// One quote the supplier owns (W5-3): the RFQ context (buyer project, request
// code, requested lines — qty fixed by the buyer), their status on it, and
// the answer actions — quote.receive (the supplier's landed price, single-
// line or per-line like the buyer's QuotesCard §32 form) and quote.decline.
// Markup mirrors finder/sections/requests/quotes-card.tsx; the data + actions
// are supplier-scoped (the server re-pins the quote id to our link).

import { useState } from 'react'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent } from '@/frontend/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Textarea } from '@/frontend/ui/textarea'
import { Check, MessageSquareQuote, X } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import { dateShort } from '@/frontend/lib/format'
import { formatKes } from '@/frontend/mjengo/finder/sections/requests/bits'
import type { SupplierQuoteRow } from '@/backend/api/supplier'
import type { SupplierDispatch } from './supplier-portal'

export function SupplierQuoteCard({
  quote, dispatch, busy,
}: { quote: SupplierQuoteRow; dispatch: SupplierDispatch; busy: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [declineOpen, setDeclineOpen] = useState(false)
  const [reason, setReason] = useState('')
  // Single-line form (the v1 quote contract): unit price + fees.
  const [unitPrice, setUnitPrice] = useState('')
  // Multi-line form (§32): one price per request line, qty fixed by the buyer.
  const [linePrices, setLinePrices] = useState<string[]>(quote.requestLines.map(() => ''))
  const [deliveryFee, setDeliveryFee] = useState('0')
  const [transportFee, setTransportFee] = useState('0')
  const [fees, setFees] = useState('0')
  const [deliveryEta, setDeliveryEta] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [terms, setTerms] = useState('')

  const multiline = quote.requestLines.length > 1
  const expired =
    quote.status === 'received' && quote.validUntil ? new Date(quote.validUntil).getTime() < Date.now() : false

  function openForm() {
    setUnitPrice('')
    setLinePrices(quote.requestLines.map(() => ''))
    setDeliveryFee('0')
    setTransportFee('0')
    setFees('0')
    setDeliveryEta('')
    setValidUntil('')
    setTerms('')
    setOpen(true)
  }

  async function submit() {
    const num = (v: string): number | null => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : null
    }
    const dFee = num(deliveryFee) ?? 0
    const tFee = num(transportFee) ?? 0
    const oFee = num(fees) ?? 0
    let payload: Record<string, unknown>
    if (multiline) {
      const prices = linePrices.map((p) => num(p))
      if (prices.some((p) => p === null || p <= 0)) {
        toast.error(t('supplier.quotes.priceFirst'))
        return
      }
      payload = {
        id: quote.id,
        lines: quote.requestLines.map((l, i) => ({ unitPrice: prices[i] })),
        deliveryFee: dFee,
        transportFee: tFee,
        fees: oFee,
        deliveryEta: deliveryEta.trim() || undefined,
        validUntil: validUntil.trim() || undefined,
        terms: terms.trim() || undefined,
      }
    } else {
      const price = num(unitPrice)
      if (price === null || price <= 0) {
        toast.error(t('supplier.quotes.priceFirst'))
        return
      }
      payload = {
        id: quote.id,
        unitPrice: price,
        deliveryFee: dFee,
        transportFee: tFee,
        fees: oFee,
        deliveryEta: deliveryEta.trim() || undefined,
        validUntil: validUntil.trim() || undefined,
        terms: terms.trim() || undefined,
      }
    }
    const ok = await dispatch('quote.receive', payload, quote.projectId, `Quote submitted: ${quote.requestCode}`)
    if (ok) {
      toast.success(t('supplier.quotes.submitted', { total: formatKes(quote.totalLanded) }))
      setOpen(false)
    }
  }

  async function decline() {
    const ok = await dispatch(
      'quote.decline',
      { id: quote.id, reason: reason.trim() || undefined },
      quote.projectId,
      `Quote declined: ${quote.requestCode}`,
    )
    if (ok) {
      toast.success(t('supplier.quotes.declined'))
      setDeclineOpen(false)
    }
  }

  return (
    <Card className={`shadow-sm ${quote.status === 'requested' ? 'border-amber-300' : 'border-stone-200'}`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-stone-900">
              <span className="font-mono">{quote.requestCode}</span>
              {quote.status === 'requested' ? (
                <Badge className="border-0 bg-amber-100 text-amber-900 hover:bg-amber-100 gap-1">
                  <MessageSquareQuote className="h-3 w-3" aria-hidden /> {t('supplier.quotes.requested')}
                </Badge>
              ) : quote.status === 'received' ? (
                <Badge className={`border-0 gap-1 ${expired ? 'bg-stone-100 text-stone-500' : 'bg-emerald-100 text-emerald-800'}`}>
                  {t('supplier.quotes.receivedTag')}
                  {expired ? ` · ${t('supplier.quotes.expired')}` : ''}
                </Badge>
              ) : (
                <Badge className="border-0 bg-stone-200 text-stone-600">{t('supplier.quotes.declinedTag')}</Badge>
              )}
            </p>
            <p className="text-xs text-stone-500 pt-0.5">
              {t('supplier.quotes.from', { project: quote.projectName })} ·{' '}
              {t('supplier.quotes.by', { name: quote.requestedByName })} · {dateShort(quote.createdAt)}
            </p>
          </div>
          {quote.status === 'requested' && (
            <div className="flex flex-wrap justify-end gap-1.5">
              <Button
                size="sm"
                className="h-9 min-h-9 gap-1 bg-amber-600 text-xs text-white hover:bg-amber-700"
                disabled={busy}
                onClick={openForm}
                aria-label={t('supplier.quotes.submitAria', { request: quote.requestCode })}
              >
                <Check className="h-3.5 w-3.5" aria-hidden /> {t('supplier.quotes.submit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-9 min-h-9 gap-1 text-xs text-stone-500 hover:text-rose-600"
                disabled={busy}
                onClick={() => { setDeclineOpen(true); setReason('') }}
                aria-label={t('supplier.quotes.declineAria', { request: quote.requestCode })}
              >
                <X className="h-3.5 w-3.5" aria-hidden /> {t('supplier.quotes.decline')}
              </Button>
            </div>
          )}
        </div>

        {/* The requested lines — qty is the buyer's, the price is ours to answer. */}
        <div className="overflow-x-auto rounded-md border border-stone-200">
          <table className="w-full min-w-[360px] text-sm">
            <caption className="sr-only">{t('supplier.quotes.lines')}</caption>
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                <th scope="col" className="px-3 py-2 font-medium">{t('supplier.catalog.name')}</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Qty</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('supplier.catalog.unit')}</th>
                {quote.status !== 'requested' && (
                  <th scope="col" className="px-3 py-2 text-right font-medium">{t('supplier.quotes.unitPrice')}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {(quote.requestLines.length ? quote.requestLines : quote.lines?.map((l) => ({
                id: l.id, materialName: l.name, unit: l.unit, qty: l.qty,
              })) ?? []).map((l) => (
                <tr key={l.id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 text-stone-700">{l.materialName}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-stone-700">{l.qty}</td>
                  <td className="px-3 py-2 text-right text-[11px] text-stone-400">{l.unit}</td>
                  {quote.status !== 'requested' && (
                    <td className="px-3 py-2 text-right tabular-nums text-stone-700">
                      {formatKes(quote.lines?.find((ql) => ql.name === l.materialName)?.unitPrice ?? quote.unitPrice)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {quote.status === 'received' && (
          <p className="text-xs text-stone-500">
            {t('supplier.quotes.received', { total: formatKes(quote.totalLanded) })}
            {quote.deliveryEta ? ` · ETA ${quote.deliveryEta}` : ''}
            {quote.validUntil ? ` · ${t('supplier.quotes.validUntil')} ${dateShort(quote.validUntil)}` : ''}
            {quote.terms ? ` · ${quote.terms}` : ''}
          </p>
        )}
      </CardContent>

      {/* ---- submit-quote dialog ---- */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('supplier.quotes.submit')} · {quote.requestCode}
            </DialogTitle>
            <DialogDescription>
              {multiline
                ? t('supplier.quotes.multi', { count: quote.requestLines.length })
                : t('supplier.quotes.desc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            {multiline ? (
              quote.requestLines.map((l, i) => (
                <div key={l.id} className="grid grid-cols-[1fr_auto_130px] items-center gap-2">
                  <Label htmlFor={`qp-${quote.id}-${i}`} className="text-xs text-stone-600 truncate">
                    {l.materialName} · {l.qty} {l.unit}
                  </Label>
                  <span className="text-[10px] text-stone-400">KSh/</span>
                  <Input
                    id={`qp-${quote.id}-${i}`}
                    type="number"
                    inputMode="decimal"
                    min="1"
                    step="0.01"
                    className="h-10 tabular-nums"
                    value={linePrices[i] ?? ''}
                    onChange={(e) => setLinePrices((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))}
                    aria-label={`${l.materialName} — ${t('supplier.quotes.unitPrice')}`}
                  />
                </div>
              ))
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor={`qp-${quote.id}`} className="text-xs text-stone-600">
                  {t('supplier.quotes.unitPrice')}
                </Label>
                <Input
                  id={`qp-${quote.id}`}
                  type="number"
                  inputMode="decimal"
                  min="1"
                  step="0.01"
                  className="h-10 tabular-nums"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                />
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor={`qdf-${quote.id}`} className="text-xs text-stone-600">{t('supplier.quotes.deliveryFee')}</Label>
                <Input id={`qdf-${quote.id}`} type="number" inputMode="decimal" min="0" step="0.01" className="h-10 tabular-nums" value={deliveryFee} onChange={(e) => setDeliveryFee(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`qtf-${quote.id}`} className="text-xs text-stone-600">{t('supplier.quotes.transportFee')}</Label>
                <Input id={`qtf-${quote.id}`} type="number" inputMode="decimal" min="0" step="0.01" className="h-10 tabular-nums" value={transportFee} onChange={(e) => setTransportFee(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`qof-${quote.id}`} className="text-xs text-stone-600">{t('supplier.quotes.fees')}</Label>
                <Input id={`qof-${quote.id}`} type="number" inputMode="decimal" min="0" step="0.01" className="h-10 tabular-nums" value={fees} onChange={(e) => setFees(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor={`qeta-${quote.id}`} className="text-xs text-stone-600">{t('supplier.quotes.eta')}</Label>
                <Input id={`qeta-${quote.id}`} className="h-10" placeholder={t('supplier.quotes.etaPh')} value={deliveryEta} onChange={(e) => setDeliveryEta(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`qvu-${quote.id}`} className="text-xs text-stone-600">{t('supplier.quotes.validUntil')}</Label>
                <Input id={`qvu-${quote.id}`} type="date" className="h-10" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`qt-${quote.id}`} className="text-xs text-stone-600">{t('supplier.quotes.terms')}</Label>
              <Textarea id={`qt-${quote.id}`} rows={2} className="text-sm" placeholder={t('supplier.quotes.termsPh')} value={terms} onChange={(e) => setTerms(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('supplier.quotes.cancel')}</Button>
            <Button className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void submit()}>
              {t('supplier.quotes.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- decline dialog ---- */}
      <Dialog open={declineOpen} onOpenChange={setDeclineOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <X className="h-5 w-5 text-rose-600" aria-hidden /> {t('supplier.quotes.decline')} · {quote.requestCode}
            </DialogTitle>
            <DialogDescription>{t('supplier.quotes.declineDesc')}</DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('supplier.quotes.declinePh')} aria-label={t('supplier.quotes.declineReason')} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclineOpen(false)}>{t('supplier.quotes.cancel')}</Button>
            <Button className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700" disabled={busy} onClick={() => void decline()}>
              <X className="h-4 w-4" aria-hidden /> {t('supplier.quotes.decline')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
