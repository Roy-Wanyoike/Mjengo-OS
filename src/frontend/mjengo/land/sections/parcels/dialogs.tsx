'use client'

// Land & Property — mutation dialogs (contractor/admin surface; the client
// view never renders these). Every write goes through the registered LAND
// actions via the store's dispatch() so it is offline-queued + audited.
// All copy flows through useT() (land.dlg.* — issue #125); enum labels reuse
// the land.parcelStatus.* / land.docKind.* families resolved by land/labels.ts.

import { useEffect, useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { useT } from '@/frontend/i18n/provider'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/frontend/ui/alert-dialog'
import { Button } from '@/frontend/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/frontend/ui/dialog'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Textarea } from '@/frontend/ui/textarea'
import { PARCEL_STATUSES, type ParcelDetail } from '@/backend/modules/land/types'
import type { TitleSearch } from '@prisma/client'
import { toast } from 'sonner'

/** Reset a dialog's fields whenever it (re)opens. */
function useReset(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset()
  }, [open])
}

// ---------------- record a new parcel ----------------

export function NewParcelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated?: (parcelId: string) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [plot, setPlot] = useState('')
  const [county, setCounty] = useState('')
  const [town, setTown] = useState('')
  const [area, setArea] = useState('')
  const [tenure, setTenure] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')

  useReset(open, () => {
    setPlot(''); setCounty(''); setTown(''); setArea(''); setTenure(''); setLat(''); setLng('')
  })

  async function submit() {
    if (!plot.trim()) { toast.error(t('land.dlg.np.toast.plotRequired')); return }
    if (!county.trim()) { toast.error(t('land.dlg.np.toast.countyRequired')); return }
    const latitude = lat.trim() === '' ? undefined : Number(lat)
    const longitude = lng.trim() === '' ? undefined : Number(lng)
    if (latitude !== undefined && (Number.isNaN(latitude) || latitude < -90 || latitude > 90)) {
      toast.error(t('land.dlg.np.toast.latRange')); return
    }
    if (longitude !== undefined && (Number.isNaN(longitude) || longitude < -180 || longitude > 180)) {
      toast.error(t('land.dlg.np.toast.lngRange')); return
    }
    setBusy(true)
    const ok = await dispatch('parcel.create', {
      plotNumber: plot.trim(),
      county: county.trim(),
      town: town.trim() || undefined,
      approxArea: area.trim() || undefined,
      tenureType: tenure.trim() || undefined,
      latitude,
      longitude,
    }, t('land.dlg.np.audit.record', { plot: plot.trim() }))
    setBusy(false)
    if (ok) {
      toast.success(online
        ? t('land.dlg.np.toast.recorded', { plot: plot.trim() })
        : t('field.savedQueued', { count: outbox.length + 1 }))
      onOpenChange(false)
      const created = useMjengo.getState().data?.land?.parcels?.find((p) => p.plotNumber === plot.trim())
      if (created) onCreated?.(created.id)
    } else {
      toast.error(t('land.dlg.np.toast.recordFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('land.dlg.np.title')}</DialogTitle>
          <DialogDescription>
            {t('land.dlg.np.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="np-plot">{t('land.dlg.np.plot')}</Label>
            <Input id="np-plot" value={plot} onChange={(e) => setPlot(e.target.value)} placeholder={t('land.dlg.np.plotPh')} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="np-county">{t('land.dlg.np.county')}</Label>
              <Input id="np-county" value={county} onChange={(e) => setCounty(e.target.value)} placeholder={t('land.dlg.np.countyPh')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-town">{t('land.dlg.np.town')}</Label>
              <Input id="np-town" value={town} onChange={(e) => setTown(e.target.value)} placeholder={t('land.dlg.np.townPh')} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="np-area">{t('land.dlg.np.area')}</Label>
              <Input id="np-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder={t('land.dlg.np.areaPh')} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-tenure">{t('land.dlg.np.tenure')}</Label>
              <Input id="np-tenure" value={tenure} onChange={(e) => setTenure(e.target.value)} placeholder={t('land.dlg.np.tenurePh')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="np-lat">{t('land.dlg.np.lat')}</Label>
              <Input id="np-lat" value={lat} onChange={(e) => setLat(e.target.value)} placeholder={t('land.dlg.np.latPh')} inputMode="decimal" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-lng">{t('land.dlg.np.lng')}</Label>
              <Input id="np-lng" value={lng} onChange={(e) => setLng(e.target.value)} placeholder={t('land.dlg.np.lngPh')} inputMode="decimal" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('land.dlg.cancel')}</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? t('land.dlg.np.recording') : t('land.dlg.np.record')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- attach a document ----------------

export function AttachDocumentDialog({
  parcel,
  open,
  onOpenChange,
}: {
  parcel: ParcelDetail
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<string>('title_deed')
  const [fileName, setFileName] = useState('')
  const [issuedOn, setIssuedOn] = useState('')
  const [text, setText] = useState('')

  useReset(open, () => {
    setKind('title_deed'); setFileName(''); setIssuedOn(''); setText('')
  })

  async function submit() {
    if (!fileName.trim()) { toast.error(t('land.dlg.doc.toast.nameRequired')); return }
    setBusy(true)
    const kindLabel = t(`land.docKind.${kind}`)
    const ok = await dispatch('parcelDoc.attach', {
      parcelId: parcel.id,
      kind,
      fileName: fileName.trim(),
      extractedText: text.trim() || undefined,
      issuedOn: issuedOn || undefined,
    }, t('land.dlg.doc.audit.attach', { kind: kindLabel, plot: parcel.plotNumber }))
    setBusy(false)
    if (ok) {
      toast.success(online ? t('land.dlg.doc.toast.attached') : t('field.savedQueued', { count: outbox.length + 1 }))
      onOpenChange(false)
    } else {
      toast.error(t('land.dlg.doc.toast.failed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('land.dlg.doc.title')}</DialogTitle>
          <DialogDescription>
            {t('land.dlg.doc.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="doc-kind">{t('land.dlg.doc.kind')}</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="doc-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(['title_deed', 'search_cert', 'survey_map', 'other'] as const).map((value) => (
                  <SelectItem key={value} value={value}>{t(`land.docKind.${value}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="doc-name">{t('land.dlg.doc.name')}</Label>
            <Input id="doc-name" value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder={t('land.dlg.doc.namePh')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="doc-issued">{t('land.dlg.doc.issued')}</Label>
            <Input id="doc-issued" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="doc-text">{t('land.dlg.doc.text')}</Label>
            <Textarea
              id="doc-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('land.dlg.doc.textPh')}
              className="min-h-28"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('land.dlg.cancel')}</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? t('land.dlg.doc.attaching') : t('land.dlg.doc.attach')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- request a registry search ----------------

export function RequestSearchDialog({
  parcel,
  open,
  onOpenChange,
}: {
  parcel: ParcelDetail
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [searchRef, setSearchRef] = useState('')

  useReset(open, () => setSearchRef(''))

  async function submit() {
    setBusy(true)
    const ok = await dispatch('search.request', {
      parcelId: parcel.id,
      searchRef: searchRef.trim() || undefined,
    }, t('land.dlg.rs.audit.request', { plot: parcel.plotNumber }))
    setBusy(false)
    if (ok) {
      toast.success(online
        ? t('land.dlg.rs.toast.requested')
        : t('field.savedQueued', { count: outbox.length + 1 }))
      onOpenChange(false)
    } else {
      toast.error(t('land.dlg.rs.toast.failed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('land.dlg.rs.title')}</DialogTitle>
          <DialogDescription>
            {t('land.dlg.rs.descA')}<span className="font-medium">{t('land.dlg.rs.recorded')}</span>{t('land.dlg.rs.descB')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="rs-ref">{t('land.dlg.rs.ref')}</Label>
            <Input id="rs-ref" value={searchRef} onChange={(e) => setSearchRef(e.target.value)} placeholder={t('land.dlg.rs.refPh')} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('land.dlg.cancel')}</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? t('land.dlg.rs.requesting') : t('land.dlg.rs.request')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- receive the registry result ----------------

export function ReceiveResultDialog({
  parcel,
  search,
  open,
  onOpenChange,
}: {
  parcel: ParcelDetail
  search: TitleSearch
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState('')

  useReset(open, () => setSummary(''))

  const deed = parcel.documents.find((d) => d.kind === 'title_deed' && d.extractedText)

  async function submit() {
    if (!summary.trim()) { toast.error(t('land.dlg.rr.toast.summaryRequired')); return }
    setBusy(true)
    const ok = await dispatch('search.receive', { id: search.id, resultSummary: summary.trim() }, t('land.dlg.rr.audit.receive', { plot: parcel.plotNumber }))
    setBusy(false)
    if (ok) {
      toast.success(online ? t('land.dlg.rr.toast.recorded') : t('field.savedQueued', { count: outbox.length + 1 }))
      onOpenChange(false)
    } else {
      toast.error(t('land.dlg.rr.toast.failed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('land.dlg.rr.title')}</DialogTitle>
          <DialogDescription>
            {t('land.dlg.rr.descA')}<span className="font-mono text-xs">{search.searchRef}</span>{t('land.dlg.rr.descB')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="rr-summary">{t('land.dlg.rr.summary')}</Label>
            <Textarea
              id="rr-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t('land.dlg.rr.summaryPh')}
              className="min-h-32"
            />
          </div>
          {deed ? (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 min-w-0">
              <p className="text-xs font-medium text-stone-600 mb-1.5">
                {t('land.dlg.rr.compare')}
              </p>
              <p className="text-xs text-stone-500 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                {deed.extractedText}
              </p>
            </div>
          ) : (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed">
              {t('land.dlg.rr.noDeed')}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('land.dlg.cancel')}</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? t('land.dlg.rr.recording') : t('land.dlg.rr.record')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- edit parcel particulars ----------------

export function EditParcelDialog({
  parcel,
  open,
  onOpenChange,
}: {
  parcel: ParcelDetail
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [plot, setPlot] = useState('')
  const [county, setCounty] = useState('')
  const [town, setTown] = useState('')
  const [area, setArea] = useState('')
  const [tenure, setTenure] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')

  useReset(open, () => {
    setPlot(parcel.plotNumber)
    setCounty(parcel.county)
    setTown(parcel.town ?? '')
    setArea(parcel.approxArea ?? '')
    setTenure(parcel.tenureType ?? '')
    setLat(parcel.lat !== null ? String(parcel.lat) : '')
    setLng(parcel.lng !== null ? String(parcel.lng) : '')
  })

  async function submit() {
    if (!plot.trim()) { toast.error(t('land.dlg.np.toast.plotRequired')); return }
    if (!county.trim()) { toast.error(t('land.dlg.np.toast.countyRequired')); return }
    setBusy(true)
    const ok = await dispatch('parcel.update', {
      id: parcel.id,
      plotNumber: plot.trim(),
      county: county.trim(),
      town: town.trim(),
      approxArea: area.trim(),
      tenureType: tenure.trim(),
      latitude: lat.trim() === '' ? undefined : Number(lat),
      longitude: lng.trim() === '' ? undefined : Number(lng),
    }, t('land.dlg.ep.audit.update', { plot: plot.trim() }))
    setBusy(false)
    if (ok) {
      toast.success(online ? t('land.dlg.ep.toast.updated') : t('field.savedQueued', { count: outbox.length + 1 }))
      onOpenChange(false)
    } else {
      toast.error(t('land.dlg.ep.toast.failed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('land.dlg.ep.title')}</DialogTitle>
          <DialogDescription>{t('land.dlg.ep.desc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="ep-plot">{t('land.dlg.np.plot')}</Label>
            <Input id="ep-plot" value={plot} onChange={(e) => setPlot(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ep-county">{t('land.dlg.np.county')}</Label>
              <Input id="ep-county" value={county} onChange={(e) => setCounty(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ep-town">{t('land.dlg.np.town')}</Label>
              <Input id="ep-town" value={town} onChange={(e) => setTown(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ep-area">{t('land.dlg.np.area')}</Label>
              <Input id="ep-area" value={area} onChange={(e) => setArea(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ep-tenure">{t('land.dlg.np.tenure')}</Label>
              <Input id="ep-tenure" value={tenure} onChange={(e) => setTenure(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ep-lat">{t('land.dlg.np.lat')}</Label>
              <Input id="ep-lat" value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ep-lng">{t('land.dlg.np.lng')}</Label>
              <Input id="ep-lng" value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('land.dlg.cancel')}</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? t('land.dlg.ep.saving') : t('land.dlg.ep.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- set record status ----------------

export function SetParcelStatusDialog({
  parcel,
  open,
  onOpenChange,
}: {
  parcel: ParcelDetail
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>(parcel.status)
  const [note, setNote] = useState('')

  useReset(open, () => {
    setStatus(parcel.status)
    setNote('')
  })

  async function submit() {
    setBusy(true)
    const statusLabel = t(`land.parcelStatus.${status}`)
    const ok = await dispatch('parcel.setStatus', {
      id: parcel.id,
      status,
      note: note.trim() || undefined,
    }, t('land.dlg.ps.audit.setStatus', { plot: parcel.plotNumber, status: statusLabel }))
    setBusy(false)
    if (ok) {
      toast.success(online
        ? t('land.dlg.ps.toast.set', { status: statusLabel })
        : t('field.savedQueued', { count: outbox.length + 1 }))
      onOpenChange(false)
    } else {
      toast.error(t('land.dlg.ps.toast.failed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('land.dlg.ps.title')}</DialogTitle>
          <DialogDescription>
            {t('land.dlg.ps.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="ps-status">{t('land.dlg.ps.status')}</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="ps-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PARCEL_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{t(`land.parcelStatus.${s}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ps-note">{t('land.dlg.ps.note')}</Label>
            <Textarea id="ps-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('land.dlg.ps.notePh')} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('land.dlg.cancel')}</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? t('land.dlg.ps.setting') : t('land.dlg.ps.set')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------- flag a reviewed search (confirm) ----------------

export function FlagSearchConfirmDialog({
  parcel,
  search,
  open,
  onOpenChange,
}: {
  parcel: ParcelDetail
  search: TitleSearch
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useReset(open, () => setNote(''))

  async function submit() {
    setBusy(true)
    const ok = await dispatch('search.review', {
      id: search.id,
      decision: 'flag',
      note: note.trim() || undefined,
    }, t('land.dlg.flag.audit.flag', { plot: parcel.plotNumber }))
    setBusy(false)
    if (ok) {
      toast.success(online
        ? t('land.dlg.flag.toast.flagged')
        : t('field.savedQueued', { count: outbox.length + 1 }))
      onOpenChange(false)
    } else {
      toast.error(t('land.dlg.flag.toast.failed'))
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('land.dlg.flag.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('land.dlg.flag.desc', { plot: parcel.plotNumber, ref: search.searchRef })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2 py-1">
          <Label htmlFor="fs-note">{t('land.dlg.flag.note')}</Label>
          <Textarea id="fs-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('land.dlg.flag.notePh')} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('land.dlg.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={busy} className="bg-rose-600 text-white hover:bg-rose-700">
            {busy ? t('land.dlg.flag.flagging') : t('land.dlg.flag.flag')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
