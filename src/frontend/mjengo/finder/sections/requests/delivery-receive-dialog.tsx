'use client'

// Delivery receive dialog (Finder §13/§34 — the physical ground-truth moment).
// Per-line ordered vs received counts + INSPECTION (rejected qty, condition
// ok/damaged/partial, damage note), EVIDENCE PHOTOS, GPS capture via
// navigator.geolocation with a manual lat/lng fallback, and a note. ANY short
// line becomes a DISCREPANCY (flagged for review, never an accusation); the
// server writes the per-line OrderDeliveryLine rows, posts the Site Store
// ledger (net received → 'received' movement, rejected → 'damaged'/'returned')
// and notifies client + contractor.
//
// EVIDENCE PHOTOS (issue "Photo attachments on delivery verification") — the
// same flow site photos use, one step earlier: each file uploads NOW via
// POST /api/upload (document mode → Attachment row stamped entityType
// 'order_delivery' / entityId = this delivery; PNG or JPEG, 8 MB cap, category
// 'other' — none of the named document categories fits an evidence photo, so
// that is the honest label). The returned attachment ids ride the
// delivery.receive payload: whole-delivery photos in photoIds, a flagged
// line's photos in that line's photoIds — the server validates + links them
// (DeliveryPhoto rows; line photos become the discrepancy evidence) and
// photoCount becomes the honest count of links (the old typed-number field is
// gone — a number was never evidence). Offline, uploads wait for a connection
// (honest note below) while the counts + inspection still record.
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

/** One uploaded evidence photo — the /api/upload response (id + preview URL). */
interface UploadedPhoto {
  id: string
  fileName: string
  storageKey: string
}

/** Read a File as standard base64 (no data: prefix — the upload contract). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('Could not read the file'))
    reader.readAsDataURL(file)
  })
}

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
  const [photos, setPhotos] = useState<UploadedPhoto[]>([])
  const [linePhotos, setLinePhotos] = useState<Record<string, UploadedPhoto[]>>({})
  const [uploading, setUploading] = useState(false)
  const [gps, setGps] = useState('')
  const [locating, setLocating] = useState(false)
  const [saving, setSaving] = useState(false)
  const busy = actionBusy !== null || saving || uploading
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

  /**
   * Upload one evidence photo NOW via the existing /api/upload document mode
   * (files land under public/docs/, an Attachment row is stamped entityType
   * 'order_delivery' / entityId = this delivery). The returned id is submitted
   * with the verification — the server links it at receive time.
   */
  async function uploadPhoto(file: File, lineId?: string, lineName?: string) {
    if (!online) {
      toast.info('Photos need a connection to upload — record the delivery now; attach photos when you are back online')
      return
    }
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      toast.error('Evidence photos must be PNG or JPEG')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error('Photo is over the 8 MB upload limit')
      return
    }
    setUploading(true)
    try {
      const contentBase64 = await readAsBase64(file)
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'document',
          fileName: file.name,
          mimeType: file.type,
          contentBase64,
          // Honest category: an evidence photo is none of the named document
          // categories (contract/drawing/permit/receipt/boq/invoice/quote).
          category: 'other',
          title: lineName ? `${lineName} — delivery evidence (${order.orderCode})` : `${order.orderCode} — delivery evidence`,
          projectId: order.projectId,
          entityType: 'order_delivery',
          entityId: deliveryId,
        }),
      })
      const json = (await res.json().catch(() => null)) as {
        attachment?: { id: string; fileName: string; storageKey: string }
        error?: string
      } | null
      if (!res.ok || !json?.attachment) {
        toast.error(json?.error ?? 'Photo upload failed — nothing was recorded')
        return
      }
      const photo: UploadedPhoto = {
        id: json.attachment.id,
        fileName: json.attachment.fileName,
        storageKey: json.attachment.storageKey,
      }
      if (lineId) setLinePhotos((m) => ({ ...m, [lineId]: [...(m[lineId] ?? []), photo] }))
      else setPhotos((p) => [...p, photo])
    } finally {
      setUploading(false)
    }
  }

  function onFiles(files: FileList | null, lineId?: string, lineName?: string) {
    for (const file of Array.from(files ?? [])) void uploadPhoto(file, lineId, lineName)
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
    const photoIds = photos.map((p) => p.id)
    const linesWithPhotos = lines.map((l) => {
      const ids = linePhotos[l.orderLineId]?.map((p) => p.id) ?? []
      return ids.length > 0 ? { ...l, photoIds: ids } : l
    })
    setSaving(true)
    const ok = await dispatch('delivery.receive', {
      deliveryId,
      lines: linesWithPhotos,
      note: note.trim() || undefined,
      ...(photoIds.length > 0 ? { photoIds } : {}),
      ...(Number.isFinite(lat) && Number.isFinite(lng) ? { gpsLat: lat, gpsLng: lng } : {}),
    }, `Delivery received: ${order.orderCode}`)
    setSaving(false)
    if (ok) {
      const attachedPhotos = photoIds.length + Object.values(linePhotos).reduce((s, list) => s + list.length, 0)
      if (attachedPhotos > 0) {
        toast.success(`${attachedPhotos} evidence photo${attachedPhotos === 1 ? '' : 's'} attached to the delivery record`)
      }
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
                {/* Photo evidence for THIS line — shown when it is flagged
                    (damaged / rejected / short): these photos become the
                    discrepancy evidence tied to this line's count. */}
                {(damagedLine || short) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(linePhotos[line.id] ?? []).map((ph) => (
                      <span key={ph.id} className="relative h-10 w-14 overflow-hidden rounded-md border border-orange-200">
                        <img src={ph.storageKey} alt={ph.fileName} className="h-full w-full object-cover" />
                        <button
                          type="button"
                          className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-stone-950/60 text-[9px] font-medium text-white hover:bg-rose-600"
                          aria-label={`Remove ${ph.fileName} from this line`}
                          onClick={() => setLinePhotos((m) => ({ ...m, [line.id]: (m[line.id] ?? []).filter((x) => x.id !== ph.id) }))}
                        >
                          remove
                        </button>
                      </span>
                    ))}
                    <label className="flex h-10 cursor-pointer items-center gap-1 rounded-md border border-dashed border-orange-300 px-2 text-[10px] font-medium text-orange-700 hover:border-orange-400 hover:text-orange-800">
                      {uploading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Camera className="h-3 w-3" aria-hidden />}
                      photo evidence
                      <input
                        type="file"
                        accept="image/png,image/jpeg"
                        className="sr-only"
                        aria-label={`Add damage photo for ${line.name}`}
                        onChange={(e) => { onFiles(e.target.files, line.id, line.name); e.target.value = '' }}
                      />
                    </label>
                  </div>
                )}
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

        <div className="space-y-1.5">
          <Label>Evidence photos</Label>
          <div className="flex flex-wrap items-center gap-2">
            {photos.map((ph) => (
              <span key={ph.id} className="relative h-14 w-20 overflow-hidden rounded-lg border border-stone-200">
                <img src={ph.storageKey} alt={ph.fileName} className="h-full w-full object-cover" />
                <button
                  type="button"
                  className="absolute inset-x-0 bottom-0 bg-stone-950/60 py-0.5 text-[9px] font-medium text-white hover:bg-rose-600"
                  aria-label={`Remove ${ph.fileName}`}
                  onClick={() => setPhotos((p) => p.filter((x) => x.id !== ph.id))}
                >
                  remove
                </button>
              </span>
            ))}
            <label className="flex h-14 w-20 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-stone-300 text-[10px] font-medium text-stone-500 hover:border-amber-400 hover:text-amber-600">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Camera className="h-4 w-4" aria-hidden />}
              Add photo
              <input
                type="file"
                accept="image/png,image/jpeg"
                multiple
                className="sr-only"
                aria-label="Add whole-delivery evidence photos"
                onChange={(e) => { onFiles(e.target.files); e.target.value = '' }}
              />
            </label>
          </div>
          <p className="text-[11px] text-stone-500">
            {online
              ? 'Each photo uploads now and attaches when you record the delivery — a real file on the record, not a count.'
              : 'Offline — photos upload when you are back online; the counts and inspection still record now.'}
          </p>
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
