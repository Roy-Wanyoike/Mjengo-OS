'use client'

// Delivery receive dialog (Finder §13/§34 — the physical ground-truth moment).
// Per-line ordered vs received counts + INSPECTION (rejected qty, condition
// ok/damaged/partial, damage note), photo count, GPS capture via
// navigator.geolocation with a manual lat/lng fallback, and a note. ANY short
// line becomes a DISCREPANCY (flagged for review, never an accusation); the
// server writes the per-line OrderDeliveryLine rows, posts the Site Store
// ledger (net received → 'received' movement, rejected → 'damaged'/'returned')
// and notifies client + contractor. TODO(photos): v1 records a count — real
// photo attach lands with object storage (roadmap A-5).
//
// The form body is a keyed inner component: fresh per-line counts initialize
// from the PO lines each time a delivery is opened (no prop-syncing effects).

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Button } from '@/frontend/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Textarea } from '@/frontend/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Camera, Loader2, Locate, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import type { OrderWithDetail } from '@/backend/modules/supply/types'
import { fmtQty, formatKes } from './bits'

const CONDITIONS = [
  { value: 'ok', label: 'OK' },
  { value: 'partial', label: 'Partial' },
  { value: 'damaged', label: 'Damaged' },
] as const

export function DeliveryReceiveDialog({
  order, deliveryId, open, onOpenChange,
}: {
  order: OrderWithDetail | null
  deliveryId: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  if (!order || !deliveryId) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DeliveryReceiveForm key={`${order.id}:${deliveryId}`} order={order} deliveryId={deliveryId} onDone={() => onOpenChange(false)} />
    </Dialog>
  )
}

function DeliveryReceiveForm({
  order, deliveryId, onDone,
}: {
  order: OrderWithDetail
  deliveryId: string
  onDone: () => void
}) {
  const { dispatch, online, outbox, actionBusy } = useMjengo()
  const [counts, setCounts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const line of order.lines) initial[line.id] = String(line.qty)
    return initial
  })
  const [rejected, setRejected] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const line of order.lines) initial[line.id] = '0'
    return initial
  })
  const [conditions, setConditions] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const line of order.lines) initial[line.id] = 'ok'
    return initial
  })
  const [damageNotes, setDamageNotes] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const line of order.lines) initial[line.id] = ''
    return initial
  })
  const [note, setNote] = useState('')
  const [photoCount, setPhotoCount] = useState('2')
  const [gps, setGps] = useState('')
  const [locating, setLocating] = useState(false)
  const [saving, setSaving] = useState(false)
  const busy = actionBusy !== null || saving
  const offlineNote = `Saved on-device — queued (${outbox.length})`

  const shortPreview = order.lines.filter((l) => {
    const received = Number(counts[l.id])
    return Number.isFinite(received) && received < l.qty
  })
  const rejectedTotal = order.lines.reduce((s, l) => s + (Number(rejected[l.id]) || 0), 0)

  function captureLocation() {
    if (!('geolocation' in navigator)) {
      toast.info('Geolocation is unavailable on this device — enter coordinates manually')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`)
        setLocating(false)
        toast.success('GPS captured on the ground')
      },
      () => {
        setLocating(false)
        toast.info('GPS denied or unavailable — enter the coordinates manually')
      },
      { enableHighAccuracy: true, timeout: 8000 },
    )
  }

  async function save() {
    const lines = order.lines.map((l) => ({
      orderLineId: l.id,
      qtyReceived: Number(counts[l.id]),
      qtyRejected: Number(rejected[l.id]) || 0,
      damageNote: damageNotes[l.id]?.trim() || undefined,
      condition: conditions[l.id] ?? 'ok',
    }))
    if (lines.some((l) => !Number.isFinite(l.qtyReceived) || l.qtyReceived < 0)) {
      toast.error('Every line needs a received count (zero or more)')
      return
    }
    if (lines.some((l) => l.qtyRejected < 0 || l.qtyReceived - l.qtyRejected < 0)) {
      toast.error('A rejected count cannot exceed what arrived on that line')
      return
    }
    const [lat, lng] = gps
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))
    setSaving(true)
    const ok = await dispatch('delivery.receive', {
      deliveryId,
      lines,
      note: note.trim() || undefined,
      photoCount: Number(photoCount) > 0 ? Math.round(Number(photoCount)) : 0,
      ...(Number.isFinite(lat) && Number.isFinite(lng) ? { gpsLat: lat, gpsLng: lng } : {}),
    }, `Delivery received: ${order.orderCode}`)
    setSaving(false)
    if (ok) {
      const anyShort = shortPreview.length > 0
      if (anyShort) {
        toast.warning(
          online
            ? `Discrepancy recorded — ${shortPreview.length} line(s) short. Flagged for review; client + contractor notified.`
            : `Discrepancy recorded on-device — queued (${outbox.length}). It syncs with notifications when back online.`,
        )
      } else {
        toast.success(online ? `${order.orderCode} received in full — verified on the ground` : offlineNote)
      }
      if (rejectedTotal > 0 || lines.some((l) => l.condition !== 'ok')) {
        toast.info(
          `Site Store updated — ${rejectedTotal > 0 ? `${fmtQty(rejectedTotal)} rejected (damaged/return movements posted), ` : ''}net quantities received into stock`,
          { duration: 6000 },
        )
      }
      onDone()
    } else toast.error('Could not record the delivery — it may already be received')
  }

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Camera className="h-5 w-5 text-amber-600" aria-hidden /> Receive delivery — {order.orderCode}
        </DialogTitle>
        <DialogDescription>
          The physical count is ground truth: count what actually arrived, line by line, and record what was rejected
          on inspection. Short counts are flagged for review — never accusations; payment stays gated by the 3-way
          match. Net quantities (received − rejected) post into the Site Store.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
            Ordered vs received vs rejected — {order.supplierName}
          </p>
          {order.lines.map((line) => {
            const received = Number(counts[line.id])
            const rejectedQty = Number(rejected[line.id]) || 0
            const short = Number.isFinite(received) && received < line.qty
            const damagedLine = conditions[line.id] === 'damaged' || rejectedQty > 0
            return (
              <div key={line.id} className={`space-y-2 rounded-lg border px-3 py-2 ${damagedLine ? 'border-orange-200 bg-orange-50/50' : 'border-stone-200'}`}>
                <div className="grid grid-cols-[1fr_6.5rem] items-center gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-stone-800">{line.name}</p>
                    <p className="text-[11px] text-stone-500">
                      ordered {fmtQty(line.qty)} {line.unit} · {formatKes(line.lineTotal)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={line.qty}
                      value={counts[line.id] ?? ''}
                      onChange={(e) => setCounts((c) => ({ ...c, [line.id]: e.target.value }))}
                      aria-label={`Received count for ${line.name}`}
                      className={`h-9 text-right tabular-nums ${short ? 'border-orange-300 bg-orange-50 focus-visible:ring-orange-400' : ''}`}
                    />
                    <span className="text-[11px] text-stone-400">/ {fmtQty(line.qty)}</span>
                  </div>
                </div>
                <div className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={Number(counts[line.id]) || 0}
                      value={rejected[line.id] ?? '0'}
                      onChange={(e) => setRejected((r) => ({ ...r, [line.id]: e.target.value }))}
                      aria-label={`Rejected count for ${line.name}`}
                      className="h-8 text-right tabular-nums"
                    />
                    <span className="text-[11px] text-stone-400">rej.</span>
                  </div>
                  <Select
                    value={conditions[line.id] ?? 'ok'}
                    onValueChange={(v) => setConditions((c) => ({ ...c, [line.id]: v }))}
                  >
                    <SelectTrigger className="h-8 text-xs" aria-label={`Inspection condition for ${line.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONDITIONS.map((c) => (
                        <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  value={damageNotes[line.id] ?? ''}
                  onChange={(e) => setDamageNotes((n) => ({ ...n, [line.id]: e.target.value }))}
                  placeholder="Damage note (e.g. 4 bags set by rain) — optional"
                  aria-label={`Damage note for ${line.name}`}
                  className="h-8 text-xs"
                />
              </div>
            )
          })}
        </div>

        {shortPreview.length > 0 && (
          <div role="alert" className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-xs text-orange-900">
            {shortPreview.map((l) => {
              const received = Number(counts[l.id])
              return (
                <p key={l.id} className="font-medium">
                  {l.name}: ordered {fmtQty(l.qty)} · received {fmtQty(received)} — {fmtQty(l.qty - received)} missing, flagged for review
                </p>
              )
            })}
            <p className="pt-1 font-normal">Reconcile with {order.supplierName} before releasing payment — the invoices 3-way match will flag it too.</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="recv-photos">Evidence photos</Label>
            <Input id="recv-photos" type="number" inputMode="numeric" min={0} value={photoCount} onChange={(e) => setPhotoCount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recv-gps">GPS coordinates</Label>
            <div className="flex gap-1.5">
              <Input id="recv-gps" value={gps} onChange={(e) => setGps(e.target.value)} placeholder="-1.2921, 36.8219" className="tabular-nums" />
              <Button
                type="button" variant="outline" className="h-9 w-10 shrink-0 p-0"
                onClick={captureLocation} disabled={locating}
                aria-label="Capture current GPS location"
                title="Capture current GPS location"
              >
                {locating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Locate className="h-4 w-4" aria-hidden />}
              </Button>
            </div>
          </div>
        </div>
        {gps && (
          <p className="flex items-center gap-1.5 text-[11px] text-stone-500">
            <MapPin className="h-3 w-3 shrink-0 text-emerald-600" aria-hidden /> GPS captured: {gps} — timestamped on save
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="recv-note">Delivery note (optional)</Label>
          <Textarea id="recv-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Condition on arrival, driver, delivery note number…" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button
          className={`gap-1.5 text-white ${shortPreview.length > 0 ? 'bg-orange-600 hover:bg-orange-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {shortPreview.length > 0 ? 'Record delivery + discrepancy' : 'Record full delivery'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
