'use client'

// Quotes comparison card for one request (Finder §3-§4/§32): REQUESTED →
// RECEIVED (simulated supplier response — quote.receive) or DECLINED, with
// the best landed cost highlighted. Single-line requests keep the v1
// per-request form (unitPrice × first line qty + delivery + transport + fees
// = totalLanded); MULTI-LINE requests get one price row per request line
// (qty fixed from the request) — totalLanded = Σ(qty × price) + fees, stored
// as QuoteLine rows. Validity + terms (§32) are editable on received quotes
// via quote.update; a past validUntil greys the row and shows 'expired'.

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Switch } from '@/frontend/ui/switch'
import { Loader2, MessageSquareQuote, Trophy, X, CalendarClock, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import type { QuoteDetail, RequestWithLines, SupplierWithCatalog } from '@/backend/modules/supply/types'
import { formatKes } from './bits'

/** Whole days between now and a validity date (0 = today, negative = past). */
function daysLeft(validUntil: string | Date | null | undefined): number | null {
  if (!validUntil) return null
  const ms = new Date(validUntil).getTime() - Date.now()
  if (!Number.isFinite(ms)) return null
  return Math.ceil(ms / 86_400_000)
}

/** A received quote is expired when its validity MOMENT is past (date-first —
 *  ceil(−0.7) rounds to 0, which would otherwise read as "expires in 0d"). */
function isExpiredQuote(validUntil: string | Date | null | undefined): boolean {
  if (!validUntil) return false
  const t = new Date(validUntil).getTime()
  return Number.isFinite(t) && t < Date.now()
}

/** ISO yyyy-mm-dd for <input type="date"> defaults. */
function isoDay(d: string | Date | null | undefined): string {
  if (!d) return ''
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return ''
  return dt.toISOString().slice(0, 10)
}

export function QuotesCard({
  request, suppliers, canManage,
}: {
  request: RequestWithLines
  suppliers: SupplierWithCatalog[]
  canManage: boolean
}) {
  const { dispatch, online, outbox, actionBusy } = useMjengo()
  const [requestOpen, setRequestOpen] = useState(false)
  const [receiveTarget, setReceiveTarget] = useState<QuoteDetail | null>(null)
  const [editTarget, setEditTarget] = useState<QuoteDetail | null>(null)
  const [supplierPicks, setSupplierPicks] = useState<string[]>([])
  const [form, setForm] = useState({ unitPrice: '', deliveryFee: '', transportFee: '', fees: '', deliveryEta: 'next day', stockOk: true })
  const [validityForm, setValidityForm] = useState({ validUntil: '', terms: '' })
  const [linePrices, setLinePrices] = useState<Record<string, string>>({})
  const busy = actionBusy !== null
  const offlineNote = `Saved on-device — queued (${outbox.length})`

  const quotes = request.quotes
  const received = quotes.filter((q) => q.status === 'received' && q.totalLanded > 0)
  const best = received.length ? received.reduce((a, b) => (b.totalLanded < a.totalLanded ? b : a)) : null
  const firstLine = request.lines[0]
  const multiLine = request.lines.length > 1

  // Default quote-request picks: suppliers stocking the first line's material
  function openRequestDialog() {
    const stocking = suppliers.filter((s) =>
      s.catalogItems.some((c) => c.name.toLowerCase().includes(firstLine?.materialName.toLowerCase().split(' ')[0] ?? '')),
    )
    setSupplierPicks(stocking.length ? stocking.map((s) => s.id) : suppliers.slice(0, 2).map((s) => s.id))
    setRequestOpen(true)
  }

  async function sendQuoteRequests() {
    if (!supplierPicks.length) { toast.error('Pick at least one supplier'); return }
    const ok = await dispatch('quote.request', {
      requestId: request.id, supplierIds: supplierPicks,
    }, `Quotes requested: ${request.requestCode} → ${supplierPicks.length} suppliers`)
    if (ok) {
      toast.success(online ? `Quote requests sent to ${supplierPicks.length} supplier(s)` : offlineNote)
      setRequestOpen(false)
    } else toast.error('Could not request quotes — those suppliers may already hold one')
  }

  function openReceive(q: QuoteDetail) {
    setReceiveTarget(q)
    setForm({ unitPrice: '', deliveryFee: '', transportFee: '', fees: '', deliveryEta: 'next day', stockOk: true })
    setValidityForm({ validUntil: isoDay(new Date(Date.now() + 30 * 86_400_000)), terms: '' })
    const initial: Record<string, string> = {}
    for (const line of request.lines) initial[line.id] = ''
    setLinePrices(initial)
  }

  function openEdit(q: QuoteDetail) {
    setEditTarget(q)
    setValidityForm({ validUntil: isoDay(q.validUntil), terms: q.terms ?? '' })
  }

  /** Σ(qty × price) across the multi-line price inputs, null until every line is priced. */
  const multiLineProductCost = multiLine && request.lines.every((l) => Number(linePrices[l.id]) > 0)
    ? request.lines.reduce((s, l) => s + l.qty * (Number(linePrices[l.id]) || 0), 0)
    : null
  const feeTotal = (Number(form.deliveryFee) || 0) + (Number(form.transportFee) || 0) + (Number(form.fees) || 0)

  async function receive() {
    if (!receiveTarget || !firstLine) return
    if (multiLine) {
      if (request.lines.some((l) => !(Number(linePrices[l.id]) > 0))) {
        toast.error('Price every line — the quoted unit price must be greater than zero')
        return
      }
      const ok = await dispatch('quote.receive', {
        id: receiveTarget.id,
        deliveryFee: Number(form.deliveryFee) || 0,
        transportFee: Number(form.transportFee) || 0,
        fees: Number(form.fees) || 0,
        deliveryEta: form.deliveryEta,
        stockOk: form.stockOk,
        ...(validityForm.validUntil ? { validUntil: new Date(validityForm.validUntil).toISOString() } : {}),
        ...(validityForm.terms.trim() ? { terms: validityForm.terms.trim() } : {}),
        lines: request.lines.map((l) => ({ unitPrice: Number(linePrices[l.id]) })),
      }, `Quote received: ${receiveTarget.supplierName} for ${request.requestCode}`)
      if (ok) {
        toast.success(
          online
            ? `${receiveTarget.supplierName} quote recorded — ${request.lines.length} lines, landed ${formatKes((multiLineProductCost ?? 0) + feeTotal)}`
            : offlineNote,
        )
        setReceiveTarget(null)
      } else toast.error('Could not record the quote — every line needs a price greater than zero')
      return
    }
    const unitPrice = Number(form.unitPrice)
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) { toast.error('Quoted unit price must be greater than zero'); return }
    const ok = await dispatch('quote.receive', {
      id: receiveTarget.id,
      unitPrice,
      deliveryFee: Number(form.deliveryFee) || 0,
      transportFee: Number(form.transportFee) || 0,
      fees: Number(form.fees) || 0,
      deliveryEta: form.deliveryEta,
      stockOk: form.stockOk,
      ...(validityForm.validUntil ? { validUntil: new Date(validityForm.validUntil).toISOString() } : {}),
      ...(validityForm.terms.trim() ? { terms: validityForm.terms.trim() } : {}),
    }, `Quote received: ${receiveTarget.supplierName} for ${request.requestCode}`)
    if (ok) {
      toast.success(online ? `${receiveTarget.supplierName} quote recorded — landed ${formatKes(unitPrice * firstLine.qty + feeTotal)}` : offlineNote)
      setReceiveTarget(null)
    } else toast.error('Could not record the quote')
  }

  async function saveValidity() {
    if (!editTarget) return
    const ok = await dispatch('quote.update', {
      id: editTarget.id,
      validUntil: validityForm.validUntil ? new Date(validityForm.validUntil).toISOString() : null,
      terms: validityForm.terms.trim() || null,
    }, `Quote updated: ${editTarget.supplierName} for ${request.requestCode}`)
    if (ok) {
      toast.success(online ? 'Validity & terms updated' : offlineNote)
      setEditTarget(null)
    } else toast.error('Could not update the quote')
  }

  async function decline(quote: QuoteDetail) {
    const ok = await dispatch('quote.decline', { id: quote.id }, `Quote declined: ${quote.supplierName} for ${request.requestCode}`)
    if (ok) toast.success(`${quote.supplierName} declined — recorded`)
    else toast.error('Could not record the decline')
  }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base text-stone-900">
            <MessageSquareQuote className="h-4 w-4 text-amber-600" aria-hidden /> Supplier quotes
            <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{quotes.length}</Badge>
          </CardTitle>
          <CardDescription>
            {multiLine
              ? `Multi-line bid: one unit price per line of ${request.requestCode} (quantities fixed from the request), plus delivery + transport + fees.`
              : firstLine
                ? `Quotes are per-request: unit price × ${firstLine.qty} ${firstLine.unit} of ${firstLine.materialName}, plus delivery + transport + fees.`
                : 'Request quotes to compare landed costs.'}
          </CardDescription>
        </div>
        {canManage && ['submitted', 'approved', 'converted'].includes(request.status) && (
          <Button size="sm" variant="outline" className="min-h-11 gap-1.5" disabled={busy} onClick={openRequestDialog}>
            Request quotes
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {!quotes.length ? (
          <p className="rounded-lg border border-dashed border-stone-300 p-4 text-center text-xs text-stone-500">
            No quotes yet — request them from the suppliers stocking these materials.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-stone-200">
            <table className="w-full min-w-[680px] text-sm">
              <caption className="sr-only">Quotes for {request.requestCode}</caption>
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                  <th scope="col" className="px-3 py-2 font-medium">Supplier</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Unit</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Delivery</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Fees</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Landed</th>
                  <th scope="col" className="px-2 py-2 font-medium">ETA</th>
                  <th scope="col" className="px-2 py-2 font-medium">Validity</th>
                  {/* relative anchors the sr-only span (see results-table.tsx note) */}
                  <th scope="col" className="relative px-3 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => {
                  const isBest = best?.id === q.id
                  const left = daysLeft(q.validUntil)
                  const expired = q.status === 'received' && isExpiredQuote(q.validUntil)
                  return (
                    <tr key={q.id} className={`border-b border-stone-100 last:border-0 transition ${isBest ? 'bg-amber-50/80' : 'hover:bg-stone-50'} ${expired ? 'opacity-50' : ''}`}>
                      <td className="px-3 py-2.5">
                        <span className="font-medium text-stone-800">{q.supplierName}</span>
                        {isBest && <Badge className="ml-1.5 border-0 gap-1 bg-amber-600 text-[10px] text-white hover:bg-amber-600"><Trophy className="h-3 w-3" aria-hidden /> Best landed</Badge>}
                        {q.lines && q.lines.length > 1 && (
                          <Badge variant="outline" className="ml-1.5 text-[10px] font-normal text-stone-500" title={q.lines.map((l) => `${l.name}: ${formatKes(l.unitPrice)}`).join(' · ')}>
                            {q.lines.length} lines
                          </Badge>
                        )}
                        <span className="block pt-0.5 text-[10px] text-stone-400">
                          {q.status === 'received' ? (q.stockOk ? 'stock confirmed' : 'stock short') : q.status}
                          {q.terms ? ' · terms on file' : ''}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-stone-700">{q.status === 'received' ? formatKes(q.unitPrice) : '—'}</td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-stone-700">{q.status === 'received' ? formatKes(q.deliveryFee + q.transportFee) : '—'}</td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-stone-700">{q.status === 'received' ? formatKes(q.fees) : '—'}</td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-right font-semibold tabular-nums text-stone-900">{q.status === 'received' ? formatKes(q.totalLanded) : '—'}</td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-xs text-stone-600">{q.deliveryEta ?? '—'}</td>
                      <td className="whitespace-nowrap px-2 py-2.5">
                        {q.status !== 'received' ? (
                          <span className="text-xs text-stone-400">—</span>
                        ) : expired ? (
                          <Badge className="border-0 gap-1 bg-stone-200 text-[10px] text-stone-600 hover:bg-stone-200">expired</Badge>
                        ) : left === null ? (
                          <Button size="sm" variant="ghost" className="h-7 min-h-7 gap-1 px-2 text-[10px] text-stone-500" disabled={busy} onClick={() => openEdit(q)} aria-label={`Set validity and terms for ${q.supplierName}`}>
                            <Pencil className="h-3 w-3" aria-hidden /> set
                          </Button>
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <Badge variant="outline" className="gap-1 text-[10px] font-medium text-stone-500">
                              <CalendarClock className="h-3 w-3" aria-hidden /> {left === 0 ? 'expires today' : `expires in ${left}d`}
                            </Badge>
                            {canManage && (
                              <button
                                className="rounded-full p-1 text-stone-400 transition hover:text-amber-700"
                                disabled={busy}
                                onClick={() => openEdit(q)}
                                aria-label={`Edit validity and terms for ${q.supplierName}`}
                                title="Edit validity & terms"
                              >
                                <Pencil className="h-3 w-3" aria-hidden />
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right">
                        {canManage && q.status === 'requested' && (
                          <span className="flex justify-end gap-1.5">
                            <Button
                              size="sm" className="h-8 min-h-8 gap-1 bg-amber-600 px-2 text-xs text-white hover:bg-amber-700" disabled={busy}
                              onClick={() => openReceive(q)}
                              aria-label={`Simulate ${q.supplierName} quote response`}
                            >
                              Simulate response
                            </Button>
                            <Button
                              size="sm" variant="ghost" className="h-8 min-h-8 gap-1 px-2 text-xs text-stone-500 hover:text-rose-600" disabled={busy}
                              onClick={() => void decline(q)}
                              aria-label={`Mark ${q.supplierName} as declined`}
                            >
                              <X className="h-3.5 w-3.5" aria-hidden /> Decline
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      {/* ---- request quotes dialog ---- */}
      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Request quotes — {request.requestCode}</DialogTitle>
            <DialogDescription>Suppliers stocking these materials are pre-picked.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-2 max-h-72 overflow-y-auto pr-1" role="group" aria-label="Suppliers to request quotes from">
            {suppliers.map((s) => {
              const picked = supplierPicks.includes(s.id)
              return (
                <label key={s.id} className="flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded-lg border border-stone-200 px-3 py-2.5 text-sm transition hover:border-amber-300">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-stone-800">{s.businessName}</span>
                    <span className="block text-[10px] text-stone-400">{s.county} · responds ~{s.responseHours}h · {s.reliabilityScore}/100</span>
                  </span>
                  <input
                    type="checkbox"
                    className="h-5 w-5 shrink-0 accent-amber-600"
                    checked={picked}
                    onChange={() => setSupplierPicks((p) => (picked ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                    aria-label={`Request a quote from ${s.businessName}`}
                  />
                </label>
              )
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequestOpen(false)}>Cancel</Button>
            <Button className="bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void sendQuoteRequests()}>
              Request {supplierPicks.length || ''} quote{supplierPicks.length === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- receive (simulated) quote dialog ---- */}
      <Dialog open={Boolean(receiveTarget)} onOpenChange={(v) => !v && setReceiveTarget(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Supplier response — {receiveTarget?.supplierName}</DialogTitle>
            <DialogDescription>
              Simulated quote entry (no live supplier rail yet).{' '}
              {multiLine
                ? `One unit price per line of ${request.requestCode} — quantities are fixed from the request.`
                : firstLine
                  ? `The unit price applies to ${firstLine.qty} ${firstLine.unit} of ${firstLine.materialName}; fees land on top.`
                  : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            {multiLine ? (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Per-line prices</p>
                {request.lines.map((line) => (
                  <div key={line.id} className="grid grid-cols-[1fr_7rem] items-center gap-2 rounded-lg border border-stone-200 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-800">{line.materialName}</p>
                      <p className="text-[11px] text-stone-500">qty fixed · {line.qty} {line.unit}</p>
                    </div>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      value={linePrices[line.id] ?? ''}
                      onChange={(e) => setLinePrices((p) => ({ ...p, [line.id]: e.target.value }))}
                      placeholder="760"
                      aria-label={`Quoted unit price for ${line.materialName}`}
                      className="h-9 text-right tabular-nums"
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="q-unit">Unit price (KSh)</Label>
                  <Input id="q-unit" type="number" inputMode="decimal" min={0} value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} placeholder="760" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="q-eta">Delivery ETA</Label>
                  <Select value={form.deliveryEta} onValueChange={(v) => setForm({ ...form, deliveryEta: v })}>
                    <SelectTrigger id="q-eta"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['same day', 'next day', '2 days', '3 days', '1 week'].map((d) => (
                        <SelectItem key={d} value={d}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {multiLine && (
              <div className="space-y-1.5">
                <Label htmlFor="q-eta">Delivery ETA</Label>
                <Select value={form.deliveryEta} onValueChange={(v) => setForm({ ...form, deliveryEta: v })}>
                  <SelectTrigger id="q-eta"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['same day', 'next day', '2 days', '3 days', '1 week'].map((d) => (
                      <SelectItem key={d} value={d}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="q-delivery">Delivery fee</Label>
                <Input id="q-delivery" type="number" inputMode="decimal" min={0} value={form.deliveryFee} onChange={(e) => setForm({ ...form, deliveryFee: e.target.value })} placeholder="2500" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-transport">Transport</Label>
                <Input id="q-transport" type="number" inputMode="decimal" min={0} value={form.transportFee} onChange={(e) => setForm({ ...form, transportFee: e.target.value })} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-fees">Other fees</Label>
                <Input id="q-fees" type="number" inputMode="decimal" min={0} value={form.fees} onChange={(e) => setForm({ ...form, fees: e.target.value })} placeholder="0" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="q-valid">Valid until</Label>
                <Input id="q-valid" type="date" value={validityForm.validUntil} onChange={(e) => setValidityForm((v) => ({ ...v, validUntil: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-terms">Terms</Label>
                <Input id="q-terms" value={validityForm.terms} onChange={(e) => setValidityForm((v) => ({ ...v, terms: e.target.value }))} placeholder="50% on delivery, 50% after 14d" />
              </div>
            </div>
            <label className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2.5 text-sm">
              <span>
                <span className="block font-medium text-stone-800">Stock confirmed</span>
                <span className="block text-[10px] text-stone-400">Supplier confirms full quantity availability</span>
              </span>
              <Switch checked={form.stockOk} onCheckedChange={(v) => setForm({ ...form, stockOk: v })} aria-label="Stock confirmed" />
            </label>
            {(multiLine ? multiLineProductCost !== null : Number(form.unitPrice) > 0) && (
              <p className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
                Landed total:{' '}
                <span className="font-semibold tabular-nums text-stone-900">
                  {formatKes((multiLine ? (multiLineProductCost ?? 0) : Number(form.unitPrice) * (firstLine?.qty ?? 0)) + feeTotal)}
                </span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiveTarget(null)}>Cancel</Button>
            <Button className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void receive()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Record quote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- validity & terms edit (§32) via quote.update ---- */}
      <Dialog open={Boolean(editTarget)} onOpenChange={(v) => !v && setEditTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Validity &amp; terms — {editTarget?.supplierName}</DialogTitle>
            <DialogDescription>
              Spec §32: quotes carry a validity window and payment/delivery terms. A past date greys the quote and marks it expired.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="qe-valid">Valid until</Label>
              <Input id="qe-valid" type="date" value={validityForm.validUntil} onChange={(e) => setValidityForm((v) => ({ ...v, validUntil: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qe-terms">Terms</Label>
              <Input id="qe-terms" value={validityForm.terms} onChange={(e) => setValidityForm((v) => ({ ...v, terms: e.target.value }))} placeholder="e.g. 30 days validity · 50% on delivery" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button className="bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void saveValidity()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
