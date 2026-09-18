'use client'

// Create-purchase-request dialog (Finder §2 — "don't immediately charge the
// wallet"). Multi-line material/unit/qty; prefillable from the search section's
// "Add to Project Order" and from a request-quote comparison. Creates a DRAFT
// (request.create) — submission is a separate, deliberate step so the approval
// engine's estimate is visible first.

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Button } from '@/frontend/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Textarea } from '@/frontend/ui/textarea'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import { materialMatches } from '@/backend/modules/supply/compare'
import type { SupplierWithCatalog } from '@/backend/modules/supply/types'
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
  const t = useT()
  // Fresh per mount — the parent keys this component by the dialog nonce so
  // each open starts clean (or prefilled from the search/BOQ hand-off).
  const [lines, setLines] = useState<DraftLine[]>(() =>
    prefill?.length ? prefill.map((l) => newLine({ materialName: l.materialName, unit: l.unit, qty: String(l.qty) })) : [newLine()],
  )
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const busy = actionBusy !== null || saving
  const offlineNote = t('field.savedQueued', { count: outbox.length })

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
    if (!clean.length) { toast.error(t('finder.req.create.toastLines')); return }
    for (const l of clean) {
      if (!Number.isFinite(l.qty) || l.qty <= 0) { toast.error(t('finder.inv.create.error.qty', { name: l.materialName })); return }
    }
    setSaving(true)
    const ok = await dispatch('request.create', {
      lines: clean,
      notes: notes.trim() || undefined,
    }, t('finder.req.create.auditDrafted', { lines: clean.map((l) => `${l.qty} ${l.materialName}`).join(', ') }))
    setSaving(false)
    if (ok) {
      toast.success(online ? t('finder.req.create.toastCreated') : offlineNote)
      onOpenChange(false)
    } else toast.error(t('finder.req.create.toastFailed'))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('finder.req.create.title')}</DialogTitle>
          <DialogDescription>
            {t('finder.req.create.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {lines.map((l, i) => (
            <div key={l.key} className="grid grid-cols-[1fr_5.5rem_5.5rem_auto] items-end gap-2" aria-label={t('finder.req.create.lineAria', { n: i + 1 })}>
              <div className="space-y-1.5">
                <Label htmlFor={`req-line-${l.key}`} className={i === 0 ? '' : 'sr-only'}>{t('finder.req.create.material')}</Label>
                <Input
                  id={`req-line-${l.key}`}
                  list="finder-catalog-names"
                  value={l.materialName}
                  onChange={(e) => suggestUnit(l.key, e.target.value)}
                  placeholder={t('finder.inv.create.namePh')}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`req-unit-${l.key}`} className="sr-only">{t('finder.req.create.unit')}</Label>
                <Input id={`req-unit-${l.key}`} value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} placeholder={t('finder.req.create.unitPh')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`req-qty-${l.key}`} className="sr-only">{t('finder.req.create.quantity')}</Label>
                <Input id={`req-qty-${l.key}`} type="number" inputMode="decimal" min={0} value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} placeholder={t('finder.req.create.qtyPh')} />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mb-0.5 h-9 min-h-9 w-9 p-0 text-stone-400 hover:text-rose-600"
                onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))}
                aria-label={lines.length > 1 ? t('finder.inv.create.removeLineAria', { n: i + 1 }) : t('finder.req.create.cannotRemove')}
                disabled={lines.length === 1}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="min-h-9 gap-1.5" onClick={() => setLines((ls) => [...ls, newLine()])}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> {t('finder.inv.create.addLine')}
          </Button>

          <div className="space-y-1.5 pt-1">
            <Label htmlFor="req-notes">{t('finder.req.create.notes')}</Label>
            <Textarea id="req-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('finder.req.create.notesPh')} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('dialog.expense.cancel')}</Button>
          <Button className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700" disabled={busy} onClick={() => void save()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} {t('finder.inv.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
