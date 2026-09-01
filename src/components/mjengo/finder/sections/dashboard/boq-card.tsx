'use client'

// BOQ entity card (spec §28 — the chain head: BOQ → Material Requirement →
// RFQ → …). Fed by data.boq (BoqSlice): versioned BOQs with lines and
// estimated totals, "New BOQ" with dynamic line rows, per-BOQ "Add line",
// "Approve" and "Generate material request" (boq.to_request → MR draft,
// toast shows the requestCode + points to the Requests section). The DERIVED
// per-material required-vs-purchased view ("BOQ-lite") stays below it in the
// dashboard — both views are useful and labeled separately.

import { useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Check, ClipboardList, FileStack, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { formatKes } from '../requests/bits'
import type { BoqRow } from '@/modules/inventory/types'

interface DraftLine {
  key: number
  materialName: string
  unit: string
  qty: string
  estUnitPrice: string
  category: string
}

let lineKey = 0
function newDraftLine(): DraftLine {
  lineKey += 1
  return { key: lineKey, materialName: '', unit: '', qty: '', estUnitPrice: '', category: '' }
}

function BoqStatusBadge({ status }: { status: string }) {
  if (status === 'approved') {
    return <Badge className="border-0 gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100"><Check className="h-3 w-3" aria-hidden /> Approved</Badge>
  }
  if (status === 'superseded') {
    return <Badge className="border-0 gap-1 bg-stone-200 text-stone-600 hover:bg-stone-200">Superseded</Badge>
  }
  return <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100">Draft</Badge>
}

export function BoqCard({ canManage }: { canManage: boolean }) {
  const { data, dispatch, online, outbox, actionBusy } = useMjengo()
  const [createOpen, setCreateOpen] = useState(false)
  const [boqName, setBoqName] = useState('')
  const [draftLines, setDraftLines] = useState<DraftLine[]>([newDraftLine()])
  const [addLineTarget, setAddLineTarget] = useState<BoqRow | null>(null)
  const [addLine, setAddLine] = useState({ materialName: '', unit: '', qty: '', estUnitPrice: '', category: '' })
  const busy = actionBusy !== null
  const offlineNote = `Saved on-device — queued (${outbox.length})`
  const boqs = data?.boq.boqs ?? []

  if (!data) return null

  function openCreate() {
    setBoqName('')
    setDraftLines([newDraftLine()])
    setCreateOpen(true)
  }

  async function createBoq() {
    const lines = draftLines
      .filter((l) => l.materialName.trim())
      .map((l) => ({
        materialName: l.materialName.trim(),
        unit: l.unit.trim() || 'unit',
        qty: Number(l.qty) > 0 ? Number(l.qty) : 1,
        estUnitPrice: Number(l.estUnitPrice) >= 0 ? Number(l.estUnitPrice) : 0,
        ...(l.category.trim() ? { category: l.category.trim() } : {}),
      }))
    if (!boqName.trim()) { toast.error('Give the BOQ a name'); return }
    if (!lines.length) { toast.error('Add at least one line — material name + quantity'); return }
    if (lines.some((l) => !(l.qty > 0))) { toast.error('Every line needs a quantity greater than zero'); return }
    const ok = await dispatch('boq.create', { name: boqName.trim(), lines }, `BOQ created: ${boqName.trim()}`)
    if (ok) {
      toast.success(online ? `${boqName.trim()} created — ${lines.length} line(s)` : offlineNote)
      setCreateOpen(false)
    } else toast.error('Could not create the BOQ')
  }

  async function saveAddLine() {
    if (!addLineTarget) return
    const qty = Number(addLine.qty)
    if (!addLine.materialName.trim()) { toast.error('Material name is required'); return }
    if (!(qty > 0)) { toast.error('Quantity must be greater than zero'); return }
    const ok = await dispatch('boq.line.upsert', {
      boqId: addLineTarget.id,
      materialName: addLine.materialName.trim(),
      unit: addLine.unit.trim() || 'unit',
      qty,
      estUnitPrice: Number(addLine.estUnitPrice) >= 0 ? Number(addLine.estUnitPrice) : 0,
      ...(addLine.category.trim() ? { category: addLine.category.trim() } : {}),
    }, `BOQ line added: ${addLine.materialName.trim()}`)
    if (ok) {
      toast.success(online ? `Line added to ${addLineTarget.name}` : offlineNote)
      setAddLineTarget(null)
    } else toast.error('Could not add the line')
  }

  async function approve(boq: BoqRow) {
    const ok = await dispatch('boq.approve', { id: boq.id }, `BOQ approved: ${boq.name}`)
    if (ok) toast.success(online ? `${boq.name} approved — ready to generate the material request` : offlineNote)
    else toast.error('Could not approve — it may already be approved')
  }

  async function generateRequest(boq: BoqRow) {
    const ok = await dispatch('boq.to_request', { id: boq.id }, `Material request generated from ${boq.name}`)
    if (ok) {
      // The store refreshed synchronously on dispatch — find the new draft MR
      // (its notes reference this BOQ) so the toast can show the requestCode.
      const fresh = useMjengo.getState().data
      const created = fresh?.supply.requests.find(
        (r) => r.status === 'draft' && (r.notes ?? '').includes(`From BOQ "${boq.name}"`),
      )
      toast.success(
        `${created?.requestCode ?? 'Material request'} generated from ${boq.name} — submit it from the Requests section below.`,
        { duration: 7000 },
      )
    } else toast.error('Could not generate the material request — the BOQ needs lines')
  }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <FileStack className="h-5 w-5 text-amber-600" aria-hidden /> BOQ — bill of quantities
            <Badge variant="outline" className="text-[10px] font-medium text-stone-500">{boqs.length}</Badge>
          </CardTitle>
          <CardDescription>
            Versioned estimates per material — approve one, then generate the material request (MR) that starts the
            procurement chain (spec §28).
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" className="min-h-11 gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={openCreate} aria-label="Create a new BOQ">
            <Plus className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">New BOQ</span>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {boqs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-xs text-stone-500">
            No BOQs yet — create one with estimated quantities and prices, approve it, and generate the material
            request from here.
          </p>
        ) : (
          <div className="space-y-3">
            {boqs.map((boq) => (
              <div key={boq.id} className="rounded-lg border border-stone-200">
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-stone-800">
                      <span className="truncate">{boq.name}</span>
                      <Badge variant="outline" className="text-[10px] text-stone-500">v{boq.version}</Badge>
                      <BoqStatusBadge status={boq.status} />
                    </p>
                    <p className="text-[11px] text-stone-500">
                      {boq.lines.length} line{boq.lines.length === 1 ? '' : 's'} · est. total{' '}
                      <span className="font-semibold tabular-nums text-stone-700">{formatKes(boq.total)}</span>
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Button
                        size="sm" variant="outline" className="h-8 min-h-8 gap-1 px-2 text-xs" disabled={busy}
                        onClick={() => { setAddLineTarget(boq); setAddLine({ materialName: '', unit: '', qty: '', estUnitPrice: '', category: '' }) }}
                        aria-label={`Add a line to ${boq.name}`}
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
                      </Button>
                      {boq.status === 'draft' && (
                        <Button
                          size="sm" className="h-8 min-h-8 gap-1 bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-700" disabled={busy}
                          onClick={() => void approve(boq)}
                          aria-label={`Approve ${boq.name}`}
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden /> Approve
                        </Button>
                      )}
                      <Button
                        size="sm" variant={boq.status === 'approved' ? 'default' : 'ghost'}
                        className={`h-8 min-h-8 gap-1 px-2 text-xs ${boq.status === 'approved' ? 'bg-amber-600 text-white hover:bg-amber-700' : 'text-stone-600'}`}
                        disabled={busy || boq.status !== 'approved' || boq.lines.length === 0}
                        onClick={() => void generateRequest(boq)}
                        aria-label={`Generate a material request from ${boq.name}`}
                        title={boq.status !== 'approved' ? 'Approve the BOQ first' : 'Creates a draft MR from every line'}
                      >
                        <ClipboardList className="h-3.5 w-3.5" aria-hidden /> Generate MR
                      </Button>
                    </div>
                  )}
                </div>
                {boq.lines.length > 0 && (
                  <div className="overflow-x-auto border-t border-stone-100">
                    <table className="w-full min-w-[480px] text-sm">
                      <caption className="sr-only">Lines of {boq.name}</caption>
                      <thead>
                        <tr className="bg-stone-50/70 text-left text-[11px] uppercase tracking-wide text-stone-400">
                          <th scope="col" className="px-3 py-1.5 font-medium">Material</th>
                          <th scope="col" className="px-2 py-1.5 text-right font-medium">Qty</th>
                          <th scope="col" className="px-2 py-1.5 text-right font-medium">Est. unit</th>
                          <th scope="col" className="px-3 py-1.5 text-right font-medium">Est. total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {boq.lines.map((line) => (
                          <tr key={line.id} className="border-t border-stone-100">
                            <td className="px-3 py-1.5 text-stone-700">
                              {line.materialName}
                              {line.category && <Badge variant="outline" className="ml-1.5 text-[9px] font-normal text-stone-400">{line.category}</Badge>}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-stone-700">{line.qty} <span className="text-[10px] text-stone-400">{line.unit}</span></td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-stone-600">{line.estUnitPrice > 0 ? formatKes(line.estUnitPrice) : '—'}</td>
                            <td className="px-3 py-1.5 text-right font-medium tabular-nums text-stone-800">{line.estUnitPrice > 0 ? formatKes(line.qty * line.estUnitPrice) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* ---- new BOQ dialog (name + dynamic lines) ---- */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New BOQ</DialogTitle>
            <DialogDescription>
              Bill of quantities with estimated quantities and prices (spec §28). Lines convert into a material
              request once the BOQ is approved.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="boq-name">BOQ name</Label>
              <Input id="boq-name" value={boqName} onChange={(e) => setBoqName(e.target.value)} placeholder="e.g. Nyumba Yangu — QS estimate v2" />
            </div>
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Lines</p>
              {draftLines.map((line, i) => (
                <div key={line.key} className="space-y-1.5 rounded-lg border border-stone-200 px-2 py-2">
                  <div className="grid grid-cols-[1fr_4rem_4.5rem_5.5rem_auto] items-center gap-1.5">
                    <Input
                      value={line.materialName}
                      onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, materialName: e.target.value } : l)))}
                      placeholder={`Material ${i + 1}`}
                      aria-label={`Material name for line ${i + 1}`}
                      className="h-8 text-xs"
                    />
                    <Input
                      value={line.unit}
                      onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, unit: e.target.value } : l)))}
                      placeholder="unit"
                      aria-label={`Unit for line ${i + 1}`}
                      className="h-8 text-xs"
                    />
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      value={line.qty}
                      onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, qty: e.target.value } : l)))}
                      placeholder="qty"
                      aria-label={`Quantity for line ${i + 1}`}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      value={line.estUnitPrice}
                      onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, estUnitPrice: e.target.value } : l)))}
                      placeholder="KSh/u"
                      aria-label={`Estimated unit price for line ${i + 1}`}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                    <Button
                      type="button" variant="ghost" size="sm"
                      className="h-8 w-8 min-h-8 p-0 text-stone-400 hover:text-rose-600"
                      onClick={() => setDraftLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== line.key) : ls))}
                      aria-label={`Remove line ${i + 1}`}
                      disabled={draftLines.length === 1}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                  <Input
                    value={line.category}
                    onChange={(e) => setDraftLines((ls) => ls.map((l) => (l.key === line.key ? { ...l, category: e.target.value } : l)))}
                    placeholder="Category (optional) — e.g. structural, finishes, plumbing"
                    aria-label={`Category for line ${i + 1}`}
                    className="h-8 text-xs"
                  />
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="h-8 min-h-8 gap-1 text-xs" onClick={() => setDraftLines((ls) => [...ls, newDraftLine()])}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void createBoq()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Create BOQ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- add line dialog ---- */}
      <Dialog open={Boolean(addLineTarget)} onOpenChange={(v) => !v && setAddLineTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add line — {addLineTarget?.name}</DialogTitle>
            <DialogDescription>One material estimate row (spec §28).</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="bl-material">Material</Label>
              <Input id="bl-material" value={addLine.materialName} onChange={(e) => setAddLine({ ...addLine, materialName: e.target.value })} placeholder="e.g. River sand" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bl-unit">Unit</Label>
                <Input id="bl-unit" value={addLine.unit} onChange={(e) => setAddLine({ ...addLine, unit: e.target.value })} placeholder="tonne" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bl-qty">Qty</Label>
                <Input id="bl-qty" type="number" inputMode="decimal" min={0} value={addLine.qty} onChange={(e) => setAddLine({ ...addLine, qty: e.target.value })} placeholder="5" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bl-price">Est. KSh/u</Label>
                <Input id="bl-price" type="number" inputMode="decimal" min={0} value={addLine.estUnitPrice} onChange={(e) => setAddLine({ ...addLine, estUnitPrice: e.target.value })} placeholder="2200" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bl-category">Category (optional)</Label>
              <Input id="bl-category" value={addLine.category} onChange={(e) => setAddLine({ ...addLine, category: e.target.value })} placeholder="e.g. structural / finishes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddLineTarget(null)}>Cancel</Button>
            <Button className="bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void saveAddLine()}>Add line</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
