'use client'

// Create-purchase-request dialog (Finder §2 — "don't immediately charge the
// wallet"). Multi-line material/unit/qty; prefillable from the search section's
// "Add to Project Order" and from a request-quote comparison. Creates a DRAFT
// (request.create) — submission is a separate, deliberate step so the approval
// engine's estimate is visible first.

import { useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { materialMatches } from '@/modules/supply/compare'
import type { SupplierWithCatalog } from '@/modules/supply/types'
import type { RequestPrefillLine } from './finder-link'

interface DraftLine {
  key: number
  materialName: string
  unit: string
  qty: string
}

let lineKey = 1
function newLine(partial?: Partial<DraftLine>): DraftLine {
  return { key: lineKey++, materialName: partial?.materialName ?? '', unit: partial?.unit ?? '', qty: partial?.qty ?? '' }
}

export function CreateRequestDialog({
  open,
  onOpenChange,
  prefill,
  suppliers,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  prefill: RequestPrefillLine[] | null
  suppliers: SupplierWithCatalog[]
}) {
  const { dispatch, online, outbox, actionBusy } = useMjengo()
  // Fresh per mount — the parent keys this component by the dialog nonce so
  // each open starts clean (or prefilled from the search/BOQ hand-off).
  const [lines, setLines] = useState<DraftLine[]>(() =>
    prefill?.length ? prefill.map((l) => newLine({ materialName: l.materialName, unit: l.unit, qty: String(l.qty) })) : [newLine()],
  )
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = actionBusy !== null || saving
  const offlineNote = `Saved on-device — queued (${outbox.length})`

  function setLine(key: number, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  /** Suggest the unit from the catalogs when the material name matches one. */
  function suggestUnit(key: number, name: string) {
    if (!name.trim()) return
    for (const s of suppliers) {
      const hit = s.catalogItems.find((c) => materialMatches(c.name, name))
      if (hit) {
        setLine(key, { materialName: name, unit: hit.unit })
        return
      }
    }
    setLine(key, { materialName: name })
  }

  async function save() {
    const clean = lines
      .map((l) => ({ materialName: l.materialName.trim(), unit: l.unit.trim(), qty: Number(l.qty) }))
      .filter((l) => l.materialName)
    if (!clean.length) { toast.error('Add at least one material line'); return }
    for (const l of clean) {
      if (!Number.isFinite(l.qty) || l.qty <= 0) { toast.error(`Line "${l.materialName}": quantity must be greater than zero`); return }
    }
    setSaving(true)
    const ok = await dispatch('request.create', {
      lines: clean,
      notes: notes.trim() || undefined,
    }, `Request drafted: ${clean.map((l) => `${l.qty} ${l.materialName}`).join(', ')}`)
    setSaving(false)
    if (ok) {
      toast.success(online ? 'Draft request created — review the estimate, then submit for approval' : offlineNote)
      onOpenChange(false)
    } else toast.error('Could not create the request — check the lines')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New purchase request</DialogTitle>
          <DialogDescription>
            A request never charges the wallet — it routes through the approval rules first
            (under KSh 10k supervisor · 10–50k contractor · 50–250k client · over 250k client + finance).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {lines.map((l, i) => (
            <div key={l.key} className="grid grid-cols-[1fr_5.5rem_5.5rem_auto] items-end gap-2" aria-label={`Request line ${i + 1}`}>
              <div className="space-y-1.5">
                <Label htmlFor={`req-line-${l.key}`} className={i === 0 ? '' : 'sr-only'}>Material</Label>
                <Input
                  id={`req-line-${l.key}`}
                  list="finder-catalog-names"
                  value={l.materialName}
                  onChange={(e) => suggestUnit(l.key, e.target.value)}
                  placeholder="e.g. Cement 50kg (32.5N)"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`req-unit-${l.key}`} className="sr-only">Unit</Label>
                <Input id={`req-unit-${l.key}`} value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} placeholder="bag" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`req-qty-${l.key}`} className="sr-only">Quantity</Label>
                <Input id={`req-qty-${l.key}`} type="number" inputMode="decimal" min={0} value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} placeholder="50" />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mb-0.5 h-9 min-h-9 w-9 p-0 text-stone-400 hover:text-rose-600"
                onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))}
                aria-label={lines.length > 1 ? `Remove line ${i + 1}` : 'Cannot remove the only line'}
                disabled={lines.length === 1}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="min-h-9 gap-1.5" onClick={() => setLines((ls) => [...ls, newLine()])}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
          </Button>

          <div className="space-y-1.5 pt-1">
            <Label htmlFor="req-notes">Notes (optional)</Label>
            <Textarea id="req-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why the site needs this — phase, timing, constraints…" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
