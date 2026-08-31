'use client'

import { useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MapPin, MapPinOff, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { SiteZone } from '@prisma/client'

const MAX_ZONES = 8
const DEFAULT_W = 20
const DEFAULT_H = 14

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

/**
 * Interactive site map — zones pinned over the aerial plan; tap a zone to browse
 * and tag its photos. Self-contained: reads zones/photos from the store.
 */
export function SiteMapCard() {
  const { data, dispatch, actionBusy, viewMode } = useMjengo()
  const [placing, setPlacing] = useState(false)
  const [zoneName, setZoneName] = useState('')
  const [openZoneId, setOpenZoneId] = useState<string | null>(null)
  const [deleteZone, setDeleteZone] = useState<SiteZone | null>(null)

  if (!data) return null
  const { zones, photos } = data
  const busy = actionBusy !== null
  const isClient = viewMode === 'client' // clients browse zones; only the site team edits them
  const openZone = zones.find((z) => z.id === openZoneId) ?? null
  const zonePhotos = openZone ? photos.filter((p) => p.zoneId === openZone.id) : []
  const taggablePhotos = openZone ? photos.filter((p) => !p.zoneId) : []

  function startPlacing() {
    if (zones.length >= MAX_ZONES) {
      toast.info(`Site map is full — up to ${MAX_ZONES} zones per plan`)
      return
    }
    setPlacing(true)
    setZoneName('')
  }

  async function placeZone(clientX: number, clientY: number, rect: DOMRect) {
    const name = zoneName.trim()
    if (!name) {
      toast.error('Type a zone name first')
      return
    }
    const px = ((clientX - rect.left) / rect.width) * 100
    const py = ((clientY - rect.top) / rect.height) * 100
    const x = clamp(px - DEFAULT_W / 2, 0, 100 - DEFAULT_W)
    const y = clamp(py - DEFAULT_H / 2, 0, 100 - DEFAULT_H)
    setPlacing(false)
    const ok = await dispatch('zone.create', { name, x, y }, `Add zone "${name}" to site map`)
    if (ok) setZoneName('')
  }

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-stone-900">
              <MapPin className="w-5 h-5 text-amber-600" aria-hidden /> Interactive site map
            </CardTitle>
            <CardDescription>Tap a zone on the plan to see its photos and pin evidence to locations.</CardDescription>
          </div>
          {/* Clients browse the map read-only — zone edits are site-team actions */}
          {!isClient && (
            <Button
              variant="outline"
              className="min-h-11 gap-1.5 border-dashed"
              onClick={startPlacing}
              disabled={busy || placing}
              aria-label="Add a zone to the site map"
            >
              <Plus className="w-4 h-4" aria-hidden /> Add zone
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {placing && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3" role="status">
            <Input
              autoFocus
              value={zoneName}
              onChange={(e) => setZoneName(e.target.value)}
              placeholder="Zone name — e.g. Kitchen"
              className="h-11 w-56 bg-white"
              aria-label="New zone name"
              onKeyDown={(e) => { if (e.key === 'Enter') toast.info('Now tap the plan to place the zone') }}
            />
            <p className="text-sm text-amber-800">
              Tap the plan to place <span className="font-medium">{zoneName.trim() || 'the zone'}</span>
            </p>
            <Button variant="ghost" size="sm" className="ml-auto h-11 gap-1" onClick={() => setPlacing(false)} aria-label="Cancel placing zone">
              <X className="w-4 h-4" aria-hidden /> Cancel
            </Button>
          </div>
        )}

        <div
          className={`relative aspect-[4/3] w-full select-none overflow-hidden rounded-xl border border-stone-200 bg-stone-100 ${placing ? 'cursor-crosshair' : ''}`}
          role="application"
          aria-label="Aerial site plan with zones"
          onClick={(e) => {
            if (!placing) return
            void placeZone(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect())
          }}
        >
          <img src="/photos/site-aerial.png" alt="Aerial site plan" className="pointer-events-none absolute inset-0 h-full w-full object-cover" draggable={false} />

          {zones.map((z) => (
            <button
              key={z.id}
              type="button"
              onClick={(e) => {
                // While placing a new zone the whole plan is the drop target — let the
                // click bubble to the plan container instead of opening this zone.
                if (placing) return
                e.stopPropagation()
                setOpenZoneId(z.id)
              }}
              className="absolute rounded-lg border-2 border-amber-500/70 bg-amber-500/10 transition hover:bg-amber-500/25 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none"
              style={{ left: `${z.x}%`, top: `${z.y}%`, width: `${z.w}%`, height: `${z.h}%` }}
              aria-label={`Open zone ${z.name} — ${photos.filter((p) => p.zoneId === z.id).length} photos`}
            >
              <span className="absolute inset-x-1 top-1 truncate text-left text-xs font-medium text-stone-900 drop-shadow-sm">{z.name}</span>
            </button>
          ))}

          {zones.length === 0 && !placing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-stone-950/30 p-4 text-center">
              <MapPin className="w-7 h-7 text-white/80" aria-hidden />
              <p className="text-sm font-medium text-white">{isClient ? 'The site team has not mapped zones yet' : 'Add zones to map photos to locations'}</p>
              {!isClient && (
                <Button size="sm" variant="outline" className="h-11 min-w-44 gap-1.5 border-dashed bg-white/90" onClick={startPlacing}>
                  <Plus className="w-4 h-4" aria-hidden /> Add first zone
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Zone detail dialog */}
        <Dialog open={Boolean(openZone)} onOpenChange={(o) => !o && setOpenZoneId(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-stone-900">
                <MapPin className="w-5 h-5 text-amber-600" aria-hidden /> {openZone?.name ?? ''}
              </DialogTitle>
              <DialogDescription>
                {zonePhotos.length} {zonePhotos.length === 1 ? 'photo' : 'photos'} pinned to this zone.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {zonePhotos.length === 0 ? (
                <p className="rounded-lg border border-dashed border-stone-200 bg-stone-50 p-4 text-center text-sm text-stone-500">
                  No photos pinned here yet — tag one below.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {zonePhotos.map((p) => (
                    <figure key={p.id} className="group relative overflow-hidden rounded-lg border border-stone-200">
                      <div className="aspect-video w-full overflow-hidden bg-stone-100">
                        <img src={p.url} alt={p.caption ?? 'Site photo'} className="h-full w-full object-cover" />
                      </div>
                      <figcaption className="truncate px-2 py-1.5 text-xs text-stone-500">{p.caption ?? 'Site photo'}</figcaption>
                      {!isClient && (
                        <Button
                          size="icon"
                          variant="secondary"
                          className="absolute right-1.5 top-1.5 h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          disabled={busy}
                          aria-label={`Unpin photo ${p.caption ?? ''} from ${openZone?.name}`}
                          onClick={() => openZone && void dispatch('photo.zone', { id: p.id, zoneId: null }, `Unpin photo from ${openZone.name}`)}
                        >
                          <MapPinOff className="w-4 h-4" aria-hidden />
                        </Button>
                      )}
                    </figure>
                  ))}
                </div>
              )}

              {!isClient && taggablePhotos.length > 0 && (
                <div className="space-y-1.5">
                  <label htmlFor="tag-photo-select" className="text-xs font-medium text-stone-500">Tag a photo to this zone</label>
                  <Select
                    key={openZoneId ?? 'zone'}
                    onValueChange={async (photoId) => {
                      if (!openZone || !photoId) return
                      await dispatch('photo.zone', { id: photoId, zoneId: openZone.id }, `Pin photo to ${openZone.name}`)
                    }}
                  >
                    <SelectTrigger id="tag-photo-select" className="min-h-11 w-full bg-white" disabled={busy} aria-label="Tag a photo to this zone">
                      <SelectValue placeholder="Choose an unpinned photo…" />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {taggablePhotos.map((p) => (
                        <SelectItem key={p.id} value={p.id} className="min-h-11">
                          {p.caption ?? 'Site photo'}{p.phaseName ? ` · ${p.phaseName}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {!isClient && (
                <Button
                  variant="destructive"
                  className="min-h-11 w-full gap-2 sm:w-auto"
                  disabled={busy}
                  onClick={() => openZone && setDeleteZone(openZone)}
                >
                  <Trash2 className="w-4 h-4" aria-hidden /> Delete zone
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation */}
        <AlertDialog open={Boolean(deleteZone)} onOpenChange={(o) => !o && setDeleteZone(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{deleteZone?.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                The zone is removed from the plan and its photos become unpinned. The ledger keeps a record of this change.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="min-h-11 bg-red-600 hover:bg-red-700"
                onClick={async () => {
                  if (deleteZone) {
                    await dispatch('zone.delete', { id: deleteZone.id }, `Delete zone "${deleteZone.name}"`)
                    setOpenZoneId(null)
                  }
                  setDeleteZone(null)
                }}
              >
                Delete zone
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}
