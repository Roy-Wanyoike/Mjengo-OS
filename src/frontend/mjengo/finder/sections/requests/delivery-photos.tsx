'use client'

// Delivery evidence photos — the REPLAY side of issue "Photo attachments on
// delivery verification". Renders EXACTLY like the site-photo strip in
// overview-tab.tsx (same grid / thumbnail / dialog markup and classes — the
// site-photo rendering is inline there, so this delivery-owned component
// mirrors it instead of importing it; keep the two visually in sync):
//   · DeliveryPhotos — the whole-delivery photo grid + the full-photo dialog
//     (Attachment provenance: file, uploaded by, attached by, review state).
//   · LinePhotoThumbs — the same thumbnails, compact, for the DISCREPANCY
//     banner: the photos scoped to one inspected line (DeliveryPhoto.
//     deliveryLineId) sit next to that line's short/damage counts.
// Both feed one shared dialog. src is attachment.storageKey — /docs/<file>
// served by the app exactly like site-photo URLs (/photos/<file>).

import { useState } from 'react'
import { Badge } from '@/frontend/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Camera } from 'lucide-react'
import type { DeliveryPhotoWithAttachment } from '@/backend/modules/supply/types'

/** Full-photo dialog shared by the grid and the line thumbs. */
function DeliveryPhotoDialog({
  photo, open, onOpenChange,
}: {
  photo: DeliveryPhotoWithAttachment
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const a = photo.attachment
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-stone-900">
            <Camera className="h-5 w-5 text-amber-600" aria-hidden /> Delivery evidence photo
          </DialogTitle>
          <DialogDescription>
            {photo.deliveryLineId
              ? 'Scoped to one inspected line — the discrepancy evidence for that count.'
              : 'Whole-delivery evidence, recorded with the ground-truth verification.'}
          </DialogDescription>
        </DialogHeader>
        <img
          src={a.storageKey}
          alt={a.fileName}
          className="w-full rounded-lg border border-stone-200"
        />
        <div className="space-y-1.5 text-xs text-stone-600">
          <p className="font-medium text-stone-800">{a.title ?? a.fileName}</p>
          <p>Uploaded by {a.uploadedBy || 'site team'} · attached by {photo.attachedBy} at verification</p>
          <p className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={
                a.reviewStatus === 'approved'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-amber-200 bg-amber-50 text-amber-700'
              }
            >
              {a.reviewStatus === 'approved' ? 'reviewed' : 'unreviewed'}
            </Badge>
            {a.sizeBytes != null && <span className="text-stone-400">{(a.sizeBytes / 1024).toFixed(0)} KB</span>}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Whole-delivery evidence grid — mirrors the site-photo strip markup. */
export function DeliveryPhotos({ photos }: { photos: DeliveryPhotoWithAttachment[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  if (photos.length === 0) return null
  const open = openId ? (photos.find((p) => p.id === openId) ?? null) : null
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
        <Camera className="h-3 w-3" aria-hidden /> Evidence photos · {photos.length}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {photos.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setOpenId(p.id)}
            className="group relative aspect-[4/3] rounded-lg overflow-hidden border border-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
            aria-label={`Open delivery evidence photo: ${p.attachment.fileName}`}
          >
            <img
              src={p.attachment.storageKey}
              alt={p.attachment.fileName}
              className="w-full h-full object-cover transition-transform group-hover:scale-105"
            />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1">
              <p className="text-[9px] text-white font-medium truncate">{p.attachment.fileName}</p>
            </div>
            {p.deliveryLineId && (
              <span className="absolute top-1 left-1 bg-orange-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">line</span>
            )}
          </button>
        ))}
      </div>
      {open && <DeliveryPhotoDialog photo={open} open onOpenChange={(v) => !v && setOpenId(null)} />}
    </div>
  )
}

/**
 * Compact thumbnails for the DISCREPANCY banner — the photos scoped to one
 * inspected line (deliveryLineId), rendered like the site-photo filmstrip
 * cells. Clicking opens the same full-photo dialog.
 */
export function LinePhotoThumbs({ photos, lineName }: { photos: DeliveryPhotoWithAttachment[]; lineName: string }) {
  const [openId, setOpenId] = useState<string | null>(null)
  if (photos.length === 0) return null
  const open = openId ? (photos.find((p) => p.id === openId) ?? null) : null
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="flex items-center gap-1 text-[11px] font-medium text-orange-800">
        <Camera className="h-3 w-3" aria-hidden /> evidence:
      </span>
      {photos.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => setOpenId(p.id)}
          className="relative h-10 w-14 shrink-0 overflow-hidden rounded-md border border-orange-200 focus:outline-none focus:ring-2 focus:ring-amber-500"
          aria-label={`Open evidence photo for ${lineName}: ${p.attachment.fileName}`}
        >
          <img src={p.attachment.storageKey} alt={p.attachment.fileName} className="h-full w-full object-cover" />
        </button>
      ))}
      {open && <DeliveryPhotoDialog photo={open} open onOpenChange={(v) => !v && setOpenId(null)} />}
    </div>
  )
}
