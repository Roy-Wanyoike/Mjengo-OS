'use client'

import { useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Boxes, Truck, PackageMinus, Mic, Camera, Hand, Phone, Plus, PackageSearch, Download } from 'lucide-react'
import { toast } from 'sonner'
import { formatKES, dateShort } from '@/lib/format'
import { downloadCSV, materialsLedgerCSV, projectFilePrefix } from '@/components/mjengo/export-utils'

function SourceBadge({ source }: { source: string }) {
  if (source === 'voice') return <Badge className="gap-1 bg-violet-100 text-violet-800 border-0 hover:bg-violet-100"><Mic className="w-3 h-3" aria-hidden /> voice</Badge>
  if (source === 'photo') return <Badge className="gap-1 bg-sky-100 text-sky-800 border-0 hover:bg-sky-100"><Camera className="w-3 h-3" aria-hidden /> photo</Badge>
  if (source === 'mpesa') return <Badge className="gap-1 bg-emerald-100 text-emerald-800 border-0 hover:bg-emerald-100"><Phone className="w-3 h-3" aria-hidden /> M-Pesa</Badge>
  return <Badge className="gap-1 bg-stone-100 text-stone-600 border-0 hover:bg-stone-100"><Hand className="w-3 h-3" aria-hidden /> manual</Badge>
}

export function MaterialsTab() {
  const { data, dispatch, online, outbox, viewMode } = useMjengo()
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [consumptionOpen, setConsumptionOpen] = useState(false)
  const [materialOpen, setMaterialOpen] = useState(false)
  const [materialBusy, setMaterialBusy] = useState(false)

  const [dMaterial, setDMaterial] = useState('')
  const [dQty, setDQty] = useState('')
  const [dCost, setDCost] = useState('')
  const [dSupplier, setDSupplier] = useState('')
  const [cMaterial, setCMaterial] = useState('')
  const [cQty, setCQty] = useState('')
  const [cPhase, setCPhase] = useState('')
  const [cNote, setCNote] = useState('')
  const [mName, setMName] = useState('')
  const [mUnit, setMUnit] = useState('')
  const [mPrice, setMPrice] = useState('')

  if (!data) return null
  const isClient = viewMode === 'client'
  const stockValue = data.materials.reduce((s, m) => s + m.stockValue, 0)
  const mat = (id: string) => data.materials.find((m) => m.id === id)

  function exportLedger() {
    if (!data) return
    const filename = `${projectFilePrefix(data)}-materials-ledger.csv`
    downloadCSV(filename, materialsLedgerCSV(data))
    toast.success(`${filename} downloaded`)
  }

  async function addMaterial() {
    const unitPrice = Number(mPrice)
    if (!mName.trim() || !mUnit.trim()) { toast.error('Material name and unit are required'); return }
    if (!mPrice || Number.isNaN(unitPrice) || unitPrice < 0) { toast.error('Unit price must be 0 or more'); return }
    setMaterialBusy(true)
    const ok = await dispatch('material.create', {
      name: mName.trim(), unit: mUnit.trim(), unitPrice,
    }, `Add material ${mName.trim()}`)
    setMaterialBusy(false)
    if (ok) {
      toast.success(online ? `${mName.trim()} added to the catalog` : `Saved on-device — queued (${outbox.length})`)
      setMaterialOpen(false); setMName(''); setMUnit(''); setMPrice('')
    } else {
      toast.error('Could not add material — it may already exist')
    }
  }

  async function logDelivery() {
    const m = mat(dMaterial)
    const qty = Number(dQty)
    if (!m || !qty || qty <= 0) { toast.error('Pick a material and a valid quantity'); return }
    const ok = await dispatch('delivery.create', {
      materialId: m.id, quantity: qty,
      unitCost: Number(dCost) > 0 ? Number(dCost) : m.unitPrice,
      supplier: dSupplier.trim() || 'Unknown supplier', source: 'manual',
    }, `Delivery: ${qty} ${m.unit} ${m.name}`)
    if (ok) {
      toast.success(online
        ? `Logged ${qty} ${m.unit} of ${m.name} + auto M-Pesa entry`
        : `Saved on-device — queued (${outbox.length})`)
      setDeliveryOpen(false); setDQty(''); setDCost(''); setDSupplier('')
    } else toast.error('Failed to log delivery')
  }

  async function logConsumption() {
    const m = mat(cMaterial)
    const qty = Number(cQty)
    if (!m || !qty || qty <= 0) { toast.error('Pick a material and a valid quantity'); return }
    const ok = await dispatch('consumption.create', {
      materialId: m.id, quantity: qty,
      phaseName: data?.phases.find((p) => p.id === cPhase)?.name ?? null,
      note: cNote.trim() || null,
    }, `Used ${qty} ${m.unit} ${m.name}`)
    if (ok) {
      toast.success(online ? 'Consumption logged' : `Saved on-device — queued (${outbox.length})`)
      setConsumptionOpen(false); setCQty(''); setCNote('')
    } else toast.error('Failed to log consumption')
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-label="Material KPIs">
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Truck className="w-3.5 h-3.5" aria-hidden /> Material spend to date</CardDescription>
            <CardTitle className="text-2xl font-bold text-stone-900 tabular-nums">{formatKES(data.summary.materialSpend)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">{data.deliveries.length} deliveries logged across {data.materials.length} material types</p></CardContent>
        </Card>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><Boxes className="w-3.5 h-3.5" aria-hidden /> Stock value on site</CardDescription>
            <CardTitle className="text-2xl font-bold text-stone-900 tabular-nums">{formatKES(stockValue)}</CardTitle>
          </CardHeader>
          <CardContent><p className="text-xs text-stone-500">Delivered minus consumed · theft/variance monitored by AI</p></CardContent>
        </Card>
        <Card className="border-stone-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs"><PackageMinus className="w-3.5 h-3.5" aria-hidden /> Quick actions</CardDescription>
            <CardTitle className="text-base font-semibold text-stone-900 pt-1">{isClient ? 'Ledger tools' : 'Log field activity'}</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2 pt-1">
            {isClient ? (
              <p className="text-xs text-stone-400 py-2">Read-only client preview — logging is done by the site team.</p>
            ) : (
              <>
                <Button size="sm" className="gap-1.5 flex-1 bg-amber-600 hover:bg-amber-700 text-white" onClick={() => { setDMaterial(data.materials[0]?.id ?? ''); setDeliveryOpen(true) }}>
                  <Truck className="w-4 h-4" aria-hidden /> Delivery
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 flex-1" onClick={() => { setCMaterial(data.materials[0]?.id ?? ''); setConsumptionOpen(true) }}>
                  <PackageMinus className="w-4 h-4" aria-hidden /> Used
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Inventory */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-lg text-stone-900">Inventory ledger</CardTitle>
            <CardDescription>The shared, unbiased record of every bag, tonne &amp; stone</CardDescription>
          </div>
          <div className="flex gap-2 shrink-0">
            {!isClient && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setMaterialOpen(true)} aria-label="Add a material to the catalog">
                <Plus className="w-4 h-4" aria-hidden /> <span className="hidden sm:inline">Add material</span>
              </Button>
            )}
            <Button size="sm" variant="outline" className="gap-1.5" onClick={exportLedger} aria-label="Export materials ledger as CSV">
              <Download className="w-4 h-4" aria-hidden /> <span className="hidden sm:inline">Export ledger</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Material</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Consumed</TableHead>
                <TableHead className="text-right">On site</TableHead>
                <TableHead className="text-right">Stock value</TableHead>
                <TableHead className="text-right">Spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.materials.map((m) => {
                const lowStock = m.onSiteQty <= m.deliveredQty * 0.1 && m.deliveredQty > 0
                return (
                  <TableRow key={m.id} className={lowStock ? 'bg-amber-50/50' : undefined}>
                    <TableCell className="font-medium text-stone-800">
                      {m.name}
                      <span className="text-xs text-stone-400 ml-1">/ {m.unit}</span>
                      {lowStock && <Badge className="ml-2 bg-amber-100 text-amber-800 border-0 text-[10px] hover:bg-amber-100">running low</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{m.deliveredQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums text-stone-500">{m.consumedQty.toLocaleString()}</TableCell>
                    <TableCell className={`text-right tabular-nums font-semibold ${lowStock ? 'text-amber-700' : 'text-stone-800'}`}>{m.onSiteQty.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatKES(m.stockValue)}</TableCell>
                    <TableCell className="text-right tabular-nums text-stone-600">{formatKES(m.deliveredCost)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Delivery log */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900">Delivery log</CardTitle>
          <CardDescription>Voice notes &amp; photos become ledger entries — provenance on every line</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-y-auto pr-2 -mr-2 space-y-2" role="region" aria-label="Delivery log, scrollable">
            {data.deliveries.map((d) => {
              const m = data.materials.find((x) => x.id === d.materialId)
              return (
                <div key={d.id} className="flex items-center gap-3 rounded-lg border border-stone-200 bg-white p-3">
                  <div className="w-10 h-10 rounded-lg bg-stone-100 flex items-center justify-center shrink-0" aria-hidden>
                    <Truck className="w-5 h-5 text-stone-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-stone-800">
                        {d.quantity.toLocaleString()} {m?.unit} · {m?.name}
                      </span>
                      <SourceBadge source={d.source} />
                    </div>
                    <p className="text-xs text-stone-500 truncate">
                      {d.supplier} · {dateShort(d.date)}
                      {d.rawTranscript && <TooltipProvider><Tooltip><TooltipTrigger asChild><span className="italic text-stone-400 cursor-help"> “{d.rawTranscript.slice(0, 42)}{d.rawTranscript.length > 42 ? '…' : ''}”</span></TooltipTrigger><TooltipContent className="max-w-72 text-xs"><p className="italic">“{d.rawTranscript}”</p></TooltipContent></Tooltip></TooltipProvider>}
                    </p>
                  </div>
                  <span className="text-sm font-bold tabular-nums text-stone-700 shrink-0">{formatKES(d.totalCost)}</span>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Consumption recent */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg text-stone-900 flex items-center gap-2"><PackageSearch className="w-5 h-5 text-amber-600" aria-hidden /> Recent consumption</CardTitle>
          <CardDescription>What went where — feeds the AI anomaly reconciler</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-72 overflow-y-auto pr-2 -mr-2 space-y-1.5">
            {data.consumptions.slice(0, 20).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 text-sm border-b border-stone-100 pb-1.5">
                <div className="min-w-0">
                  <span className="font-medium text-stone-800">{c.quantity.toLocaleString()} {c.unit} {c.materialName}</span>
                  {c.phaseName && <Badge variant="outline" className="ml-2 text-[10px]">{c.phaseName}</Badge>}
                  {c.note && <p className="text-xs text-stone-400 truncate">{c.note}</p>}
                </div>
                <span className="text-xs text-stone-400 shrink-0">{dateShort(c.date)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Delivery dialog */}
      <Dialog open={deliveryOpen} onOpenChange={setDeliveryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Log material delivery</DialogTitle>
            <DialogDescription>Creates the ledger entry + auto-matched M-Pesa transaction. Works offline.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2 col-span-2">
                <Label>Material</Label>
                <Select value={dMaterial} onValueChange={(v) => { setDMaterial(v); const m = mat(v); if (m) setDCost(String(m.unitPrice)) }}>
                  <SelectTrigger><SelectValue placeholder="Choose material" /></SelectTrigger>
                  <SelectContent>
                    {data.materials.map((m) => <SelectItem key={m.id} value={m.id}>{m.name} (KSh {m.unitPrice}/{m.unit})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="qty">Quantity</Label>
                <Input id="qty" type="number" min="1" value={dQty} onChange={(e) => setDQty(e.target.value)} placeholder="e.g. 50" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cost">Unit cost (KSh)</Label>
                <Input id="cost" type="number" min="1" value={dCost} onChange={(e) => setDCost(e.target.value)} />
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="supplier">Supplier</Label>
                <Input id="supplier" value={dSupplier} onChange={(e) => setDSupplier(e.target.value)} placeholder="e.g. Karioke Hardware" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeliveryOpen(false)}>Cancel</Button>
            <Button onClick={() => void logDelivery()} className="bg-amber-600 hover:bg-amber-700 text-white gap-1"><Plus className="w-4 h-4" aria-hidden /> Log delivery</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Consumption dialog */}
      <Dialog open={consumptionOpen} onOpenChange={setConsumptionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Log material used on site</DialogTitle>
            <DialogDescription>Record what the fundis actually consumed — the ground truth for anomaly detection.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2 col-span-2">
                <Label>Material</Label>
                <Select value={cMaterial} onValueChange={setCMaterial}>
                  <SelectTrigger><SelectValue placeholder="Choose material" /></SelectTrigger>
                  <SelectContent>
                    {data.materials.map((m) => <SelectItem key={m.id} value={m.id}>{m.name} (on site: {m.onSiteQty})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cqty">Quantity used</Label>
                <Input id="cqty" type="number" min="0.5" step="0.5" value={cQty} onChange={(e) => setCQty(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Phase</Label>
                <Select value={cPhase} onValueChange={setCPhase}>
                  <SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                  <SelectContent>
                    {data.phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="note">Note</Label>
                <Input id="note" value={cNote} onChange={(e) => setCNote(e.target.value)} placeholder="e.g. Mortar for courses 13-14" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConsumptionOpen(false)}>Cancel</Button>
            <Button onClick={() => void logConsumption()} className="bg-amber-600 hover:bg-amber-700 text-white gap-1"><PackageMinus className="w-4 h-4" aria-hidden /> Log usage</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Add material dialog */}
      <Dialog open={materialOpen} onOpenChange={setMaterialOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-stone-900">Add material to catalog</DialogTitle>
            <DialogDescription>Global catalog shared across projects — matched by AI when parsing voice notes.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="mname">Material name</Label>
              <Input id="mname" value={mName} onChange={(e) => setMName(e.target.value)} placeholder="e.g. Binding Wire" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="munit">Unit</Label>
                <Input id="munit" value={mUnit} onChange={(e) => setMUnit(e.target.value)} placeholder="e.g. kg / bag / tonne" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mprice">Unit price (KSh)</Label>
                <Input id="mprice" type="number" min="0" value={mPrice} onChange={(e) => setMPrice(e.target.value)} placeholder="e.g. 250" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMaterialOpen(false)} disabled={materialBusy}>Cancel</Button>
            <Button onClick={() => void addMaterial()} disabled={materialBusy} className="bg-amber-600 hover:bg-amber-700 text-white gap-1">
              <Plus className="w-4 h-4" aria-hidden /> Add material
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
