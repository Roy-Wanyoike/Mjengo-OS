'use client'

// Supplier directory (Finder §5/§31 — supplier inventory): every network
// supplier with contact channels (tel:/mailto: + operating hours), catalog
// rows timestamped "as of <date>" (CatalogItem.updatedAt — never invent
// freshness), and the project's save-supplier shortlist (spec §30 —
// supplier.save/unsave; saved suppliers sort first and carry a badge).
// Minimal catalog editing (price/stock) via catalog.upsert and new-supplier
// capture via supplier.upsert. Suppliers are network-global rows (no project
// scope); every edit lands in the Bias-Free Ledger on the dispatching project.
// Verification ladder language is honest: platform activity levels, never
// government certification claims.

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Bookmark, BookmarkCheck, ChevronDown, ChevronRight, Clock, Mail, MapPin, Pencil, Phone, Plus, Store } from 'lucide-react'
import { toast } from 'sonner'
import { dateShort } from '@/frontend/lib/format'
import type { SupplierWithCatalog } from '@/backend/modules/supply/types'
import { formatKes } from './bits'

const VERB_LABELS = ['Unverified', 'Registered', 'Identity verified', 'Business verified', 'Location verified', 'Transaction verified']

export function SupplierDirectory({ canManage }: { canManage: boolean }) {
  const { data, dispatch, online, outbox, actionBusy } = useMjengo()
  const suppliers = data?.supply.suppliers ?? []
  const savedIds = data?.supply.savedSupplierIds ?? []
  const [openId, setOpenId] = useState<string | null>(null)
  const [editItem, setEditItem] = useState<{ supplierId: string; id: string; name: string; unit: string; unitPrice: number; stockQty: number } | null>(null)
  const [priceDraft, setPriceDraft] = useState('')
  const [stockDraft, setStockDraft] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ businessName: '', county: '', town: '', phone: '', deliveryFeeBase: '', responseHours: '' })
  const busy = actionBusy !== null
  const offlineNote = `Saved on-device — queued (${outbox.length})`

  // Saved suppliers first (spec §30) — stable within each group
  const sorted = [...suppliers].sort(
    (a, b) => Number(savedIds.includes(b.id)) - Number(savedIds.includes(a.id)) || a.businessName.localeCompare(b.businessName),
  )

  if (!data) return null

  async function toggleSave(supplier: SupplierWithCatalog) {
    const saved = savedIds.includes(supplier.id)
    const ok = await dispatch(
      saved ? 'supplier.unsave' : 'supplier.save',
      { supplierId: supplier.id },
      saved ? `Supplier unsaved: ${supplier.businessName}` : `Supplier saved: ${supplier.businessName}`,
    )
    if (ok) {
      toast.success(online ? (saved ? `${supplier.businessName} removed from the shortlist` : `${supplier.businessName} saved to the shortlist`) : offlineNote)
    } else toast.error('Could not update the shortlist')
  }

  async function saveCatalogEdit() {
    if (!editItem) return
    const unitPrice = Number(priceDraft)
    const stockQty = Number(stockDraft)
    if (!Number.isFinite(unitPrice) || unitPrice < 0) { toast.error('Unit price must be zero or more'); return }
    if (!Number.isFinite(stockQty) || stockQty < 0) { toast.error('Stock must be zero or more'); return }
    const ok = await dispatch('catalog.upsert', {
      supplierId: editItem.supplierId, id: editItem.id, name: editItem.name, unit: editItem.unit,
      unitPrice, stockQty, minOrderQty: 1,
    }, `Catalog updated: ${editItem.name}`)
    if (ok) {
      toast.success(online ? `${editItem.name} updated — ${formatKes(unitPrice)} · stock ${stockQty}` : offlineNote)
      setEditItem(null)
    } else toast.error('Could not update the catalog item')
  }

  async function addSupplier() {
    if (!form.businessName.trim() || !form.county.trim()) { toast.error('Business name and county are required'); return }
    const ok = await dispatch('supplier.upsert', {
      businessName: form.businessName.trim(), county: form.county.trim(),
      town: form.town.trim() || undefined, phone: form.phone.trim() || undefined,
      deliveryFeeBase: Number(form.deliveryFeeBase) > 0 ? Number(form.deliveryFeeBase) : 2000,
      responseHours: Number(form.responseHours) > 0 ? Math.round(Number(form.responseHours)) : 24,
    }, `Supplier added: ${form.businessName.trim()}`)
    if (ok) {
      toast.success(online ? `${form.businessName.trim()} joined the network directory` : offlineNote)
      setAddOpen(false)
      setForm({ businessName: '', county: '', town: '', phone: '', deliveryFeeBase: '', responseHours: '' })
    } else toast.error('Could not add the supplier')
  }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <Store className="h-5 w-5 text-amber-600" aria-hidden /> Supplier directory
            <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{suppliers.length}</Badge>
          </CardTitle>
          <CardDescription>
            Network suppliers with catalogs, delivery zones and fees — the compare engine reads these live.
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" variant="outline" className="min-h-11 gap-1.5" onClick={() => setAddOpen(true)} aria-label="Add a supplier to the network">
            <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Add supplier</span>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-2 -mr-2" role="region" aria-label="Supplier directory, scrollable">
          {sorted.map((s) => {
            const saved = savedIds.includes(s.id)
            return (
            <div key={s.id} className={`rounded-lg border ${saved ? 'border-amber-300 bg-amber-50/40' : 'border-stone-200'}`}>
              <div className="flex items-center gap-2">
              <button
                className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2.5 text-left transition hover:bg-stone-50"
                onClick={() => setOpenId(openId === s.id ? null : s.id)}
                aria-expanded={openId === s.id}
                aria-label={`Toggle catalog for ${s.businessName}`}
              >
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {openId === s.id ? <ChevronDown className="h-4 w-4 shrink-0 text-stone-400" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-stone-400" aria-hidden />}
                  <span className="truncate font-medium text-stone-800">{s.businessName}</span>
                  {saved && (
                    <Badge className="shrink-0 border-0 gap-1 bg-amber-600 text-[10px] text-white hover:bg-amber-600">
                      <BookmarkCheck className="h-3 w-3" aria-hidden /> Saved
                    </Badge>
                  )}
                  <Badge variant="outline" className="shrink-0 text-[10px] text-stone-500">
                    <MapPin className="mr-1 h-3 w-3" aria-hidden /> {s.county}{s.town ? ` · ${s.town}` : ''}
                  </Badge>
                  <Badge className="shrink-0 border-0 bg-stone-100 text-[10px] text-stone-600 hover:bg-stone-100">
                    {VERB_LABELS[s.verificationState] ?? `Level ${s.verificationState}`}
                  </Badge>
                </span>
                <span className="hidden shrink-0 text-[11px] tabular-nums text-stone-500 sm:block">
                  {formatKes(s.deliveryFeeBase)} delivery · {s.responseHours}h response · {s.reliabilityScore}/100
                </span>
              </button>
              {canManage && (
                <Button
                  size="sm" variant="ghost"
                  className={`mr-2 h-9 w-9 min-h-9 shrink-0 p-0 ${saved ? 'text-amber-700 hover:text-amber-800' : 'text-stone-400 hover:text-amber-700'}`}
                  disabled={busy}
                  onClick={() => void toggleSave(s)}
                  aria-label={saved ? `Remove ${s.businessName} from the saved shortlist` : `Save ${s.businessName} to the shortlist`}
                  title={saved ? 'Remove from shortlist' : 'Save supplier (spec §30)'}
                >
                  {saved ? <BookmarkCheck className="h-4 w-4" aria-hidden /> : <Bookmark className="h-4 w-4" aria-hidden />}
                </Button>
              )}
              </div>
              {openId === s.id && (
                <div className="border-t border-stone-100 px-3 py-2">
                  <p className="pb-1.5 text-[11px] text-stone-400">
                    {s.warehouseLocation ?? 'Warehouse location not recorded'} · zones: {s.deliveryZones || '—'}
                    {s.freeDeliveryOver ? ` · free delivery over ${formatKes(s.freeDeliveryOver)}` : ''}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-2 text-xs text-stone-600">
                    {s.phone ? (
                      <a href={`tel:${s.phone.replace(/\s+/g, '')}`} className="flex items-center gap-1.5 rounded px-1 py-0.5 font-medium text-stone-700 underline decoration-stone-300 underline-offset-2 hover:text-amber-700" aria-label={`Call ${s.businessName} on ${s.phone}`}>
                        <Phone className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> {s.phone}
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5 text-stone-400"><Phone className="h-3.5 w-3.5" aria-hidden /> no phone on file</span>
                    )}
                    {s.email ? (
                      <a href={`mailto:${s.email}`} className="flex items-center gap-1.5 rounded px-1 py-0.5 font-medium text-stone-700 underline decoration-stone-300 underline-offset-2 hover:text-amber-700" aria-label={`Email ${s.businessName}`}>
                        <Mail className="h-3.5 w-3.5 text-sky-600" aria-hidden /> {s.email}
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5 text-stone-400"><Mail className="h-3.5 w-3.5" aria-hidden /> no email on file</span>
                    )}
                    <span className="flex items-center gap-1.5 text-stone-500" title="Operating hours (spec §31)">
                      <Clock className="h-3.5 w-3.5 text-amber-600" aria-hidden /> {s.operatingHours ?? '—'}
                    </span>
                  </div>
                  <div className="overflow-x-auto rounded-md border border-stone-200">
                    <table className="w-full min-w-[520px] text-sm">
                      <caption className="sr-only">{s.businessName} catalog</caption>
                      <thead>
                        <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                          <th scope="col" className="px-3 py-2 font-medium">Item</th>
                          <th scope="col" className="px-2 py-2 text-right font-medium">Unit price</th>
                          <th scope="col" className="px-2 py-2 text-right font-medium">Stock</th>
                          <th scope="col" className="px-2 py-2 text-right font-medium">Min order</th>
                          {/* relative anchors the sr-only span (see results-table.tsx note) */}
                          {canManage && <th scope="col" className="relative px-3 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {s.catalogItems.map((item) => (
                          <tr key={item.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                            <td className="px-3 py-2 text-stone-700">
                              {item.name} <span className="text-[10px] text-stone-400">per {item.unit}</span>
                              {(item.category || item.brand) && (
                                <span className="block text-[10px] text-stone-400">
                                  {[item.category, item.brand, item.specification].filter(Boolean).join(' · ')}
                                </span>
                              )}
                              <span className="block text-[10px] text-stone-400" title="Catalog listing last updated (spec §31 — availability is timestamped, never invented)">
                                stock as of {dateShort(item.updatedAt)}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-stone-800">{formatKes(item.unitPrice)}</td>
                            <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-stone-700">{item.stockQty}</td>
                            <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-stone-500">{item.minOrderQty}</td>
                            {canManage && (
                              <td className="whitespace-nowrap px-3 py-2 text-right">
                                <Button
                                  size="sm" variant="ghost" className="h-8 min-h-8 gap-1 px-2 text-xs"
                                  disabled={busy}
                                  onClick={() => {
                                    setEditItem({ supplierId: s.id, id: item.id, name: item.name, unit: item.unit, unitPrice: item.unitPrice, stockQty: item.stockQty })
                                    setPriceDraft(String(item.unitPrice))
                                    setStockDraft(String(item.stockQty))
                                  }}
                                  aria-label={`Edit ${item.name} price and stock`}
                                >
                                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                                </Button>
                              </td>
                            )}
                          </tr>
                        ))}
                        {!s.catalogItems.length && (
                          <tr><td colSpan={canManage ? 5 : 4} className="px-3 py-3 text-center text-xs text-stone-400">No catalog items yet</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
            )
          })}
        </div>
      </CardContent>

      {/* ---- catalog item edit ---- */}
      <Dialog open={Boolean(editItem)} onOpenChange={(v) => !v && setEditItem(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit catalog item</DialogTitle>
            <DialogDescription>
              {editItem?.name} — suppliers update price and stock (Finder §5); the ledger records every change.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="catalog-price">Unit price (KSh)</Label>
                <Input id="catalog-price" type="number" inputMode="decimal" min={0} value={priceDraft} onChange={(e) => setPriceDraft(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="catalog-stock">Stock qty</Label>
                <Input id="catalog-stock" type="number" inputMode="decimal" min={0} value={stockDraft} onChange={(e) => setStockDraft(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}>Cancel</Button>
            <Button className="bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void saveCatalogEdit()}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- add supplier ---- */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a supplier</DialogTitle>
            <DialogDescription>
              Capture a supplier into the network directory — catalogs fill in as they list items.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="sup-name">Business name</Label>
              <Input id="sup-name" value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} placeholder="e.g. Ruiru Steel Yard" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="sup-county">County</Label>
                <Input id="sup-county" value={form.county} onChange={(e) => setForm({ ...form, county: e.target.value })} placeholder="Kiambu" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sup-town">Town</Label>
                <Input id="sup-town" value={form.town} onChange={(e) => setForm({ ...form, town: e.target.value })} placeholder="Ruiru" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="sup-phone">Phone</Label>
                <Input id="sup-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="07…" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sup-fee">Delivery fee</Label>
                <Input id="sup-fee" type="number" inputMode="decimal" min={0} value={form.deliveryFeeBase} onChange={(e) => setForm({ ...form, deliveryFeeBase: e.target.value })} placeholder="2000" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sup-resp">Response (h)</Label>
                <Input id="sup-resp" type="number" inputMode="numeric" min={1} value={form.responseHours} onChange={(e) => setForm({ ...form, responseHours: e.target.value })} placeholder="24" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button className="bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void addSupplier()}>Add supplier</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
