'use client'

// Land & Property — mutation dialogs (contractor/admin surface; the client
// view never renders these). Every write goes through the registered LAND
// actions via the store's dispatch() so it is offline-queued + audited.

import { useEffect, useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
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
import { PARCEL_STATUSES, PARCEL_STATUS_LABELS, DOC_KIND_LABELS, type ParcelDetail } from '@/backend/modules/land/types'
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
    if (!plot.trim()) { toast.error('Plot number is required (e.g. "LR No. 2090/1234")'); return }
    if (!county.trim()) { toast.error('County is required'); return }
    const latitude = lat.trim() === '' ? undefined : Number(lat)
    const longitude = lng.trim() === '' ? undefined : Number(lng)
    if (latitude !== undefined && (Number.isNaN(latitude) || latitude < -90 || latitude > 90)) {
      toast.error('Latitude must be a number between -90 and 90'); return
    }
    if (longitude !== undefined && (Number.isNaN(longitude) || longitude < -180 || longitude > 180)) {
      toast.error('Longitude must be a number between -180 and 180'); return
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
    }, `Record parcel ${plot.trim()}`)
    setBusy(false)
    if (ok) {
      toast.success(online ? `Parcel ${plot.trim()} recorded — searching` : `Saved on-device — queued (${outbox.length + 1})`)
      onOpenChange(false)
      const created = useMjengo.getState().data?.land?.parcels?.find((p) => p.plotNumber === plot.trim())
      if (created) onCreated?.(created.id)
    } else {
      toast.error('Could not record the parcel — check the plot number is not already on file')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a new parcel</DialogTitle>
          <DialogDescription>
            Starts in the honest SEARCHING state — recording a parcel claims nothing until documents and a registry
            search are attached.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="np-plot">Plot number *</Label>
            <Input id="np-plot" value={plot} onChange={(e) => setPlot(e.target.value)} placeholder="LR No. 2090/1234" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="np-county">County *</Label>
              <Input id="np-county" value={county} onChange={(e) => setCounty(e.target.value)} placeholder="Nairobi" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-town">Town / area</Label>
              <Input id="np-town" value={town} onChange={(e) => setTown(e.target.value)} placeholder="Karen" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="np-area">Approx. area</Label>
              <Input id="np-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="0.25 ha (approx)" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-tenure">Tenure</Label>
              <Input id="np-tenure" value={tenure} onChange={(e) => setTenure(e.target.value)} placeholder="freehold · leasehold 99 years" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="np-lat">Latitude</Label>
              <Input id="np-lat" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="-1.3197" inputMode="decimal" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-lng">Longitude</Label>
              <Input id="np-lng" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="36.7798" inputMode="decimal" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? 'Recording…' : 'Record parcel'}
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
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<string>('title_deed')
  const [fileName, setFileName] = useState('')
  const [issuedOn, setIssuedOn] = useState('')
  const [text, setText] = useState('')

  useReset(open, () => {
    setKind('title_deed'); setFileName(''); setIssuedOn(''); setText('')
  })

  async function submit() {
    if (!fileName.trim()) { toast.error('File name is required'); return }
    setBusy(true)
    const ok = await dispatch('parcelDoc.attach', {
      parcelId: parcel.id,
      kind,
      fileName: fileName.trim(),
      extractedText: text.trim() || undefined,
      issuedOn: issuedOn || undefined,
    }, `Attach ${DOC_KIND_LABELS[kind as keyof typeof DOC_KIND_LABELS] ?? 'document'} to ${parcel.plotNumber}`)
    setBusy(false)
    if (ok) {
      toast.success(online ? 'Document attached to the parcel record' : `Saved on-device — queued (${outbox.length + 1})`)
      onOpenChange(false)
    } else {
      toast.error('Could not attach the document')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach a document</DialogTitle>
          <DialogDescription>
            v1 records the metadata + transcription — the PDF itself is not uploaded. The title-deed transcription
            powers the registry consistency check.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="doc-kind">Kind *</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="doc-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(DOC_KIND_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="doc-name">File name *</Label>
            <Input id="doc-name" value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="title-deed-2090-1234.pdf" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="doc-issued">Issued on</Label>
            <Input id="doc-issued" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="doc-text">Extracted text / transcription</Label>
            <Textarea
              id="doc-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the deed transcription — e.g. &quot;TITLE DEED — … Registered proprietor: …&quot;. Used by the registry consistency check."
              className="min-h-28"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? 'Attaching…' : 'Attach document'}
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
  const [busy, setBusy] = useState(false)
  const [searchRef, setSearchRef] = useState('')

  useReset(open, () => setSearchRef(''))

  async function submit() {
    setBusy(true)
    const ok = await dispatch('search.request', {
      parcelId: parcel.id,
      searchRef: searchRef.trim() || undefined,
    }, `Request registry search for ${parcel.plotNumber}`)
    setBusy(false)
    if (ok) {
      toast.success(online
        ? 'Registry search requested — record the official result when it arrives'
        : `Saved on-device — queued (${outbox.length + 1})`)
      onOpenChange(false)
    } else {
      toast.error('Could not request the search — one may already be open on this parcel')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request a registry search</DialogTitle>
          <DialogDescription>
            The request is <span className="font-medium">recorded</span>, not confirmed — MjengoOS has no live registry
            link. Attach the official search certificate / result summary when it arrives.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="rs-ref">Search reference (optional)</Label>
            <Input id="rs-ref" value={searchRef} onChange={(e) => setSearchRef(e.target.value)} placeholder="CS/2026/118842 — blank auto-generates" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? 'Requesting…' : 'Request search'}
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
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState('')

  useReset(open, () => setSummary(''))

  const deed = parcel.documents.find((d) => d.kind === 'title_deed' && d.extractedText)

  async function submit() {
    if (!summary.trim()) { toast.error('Paste what the registry returned — the result summary is required'); return }
    setBusy(true)
    const ok = await dispatch('search.receive', { id: search.id, resultSummary: summary.trim() }, `Receive registry result for ${parcel.plotNumber}`)
    setBusy(false)
    if (ok) {
      toast.success(online ? 'Result recorded — the consistency check ran' : `Saved on-device — queued (${outbox.length + 1})`)
      onOpenChange(false)
    } else {
      toast.error('Could not record the result')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Receive the registry result</DialogTitle>
          <DialogDescription>
            Search <span className="font-mono text-xs">{search.searchRef}</span> · the result is RECORDED as typed by a
            person, then compared against the deed transcription.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="rr-summary">Registry result summary *</Label>
            <Textarea
              id="rr-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="e.g. Registry record for LR No. 2090/1234: freehold, approx 0.25 ha … registered proprietor recorded as …"
              className="min-h-32"
            />
          </div>
          {deed ? (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 min-w-0">
              <p className="text-xs font-medium text-stone-600 mb-1.5">
                The consistency check will compare against this title-deed transcription:
              </p>
              <p className="text-xs text-stone-500 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                {deed.extractedText}
              </p>
            </div>
          ) : (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 leading-relaxed">
              No title-deed transcription on file — the check will record as PENDING until one is attached.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? 'Recording…' : 'Record result'}
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
    if (!plot.trim()) { toast.error('Plot number is required'); return }
    if (!county.trim()) { toast.error('County is required'); return }
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
    }, `Update parcel ${plot.trim()}`)
    setBusy(false)
    if (ok) {
      toast.success(online ? 'Parcel particulars updated' : `Saved on-device — queued (${outbox.length + 1})`)
      onOpenChange(false)
    } else {
      toast.error('Could not update the parcel — the plot number may already be on file')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit parcel particulars</DialogTitle>
          <DialogDescription>Identity fields only — the record status has its own audited action.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="ep-plot">Plot number *</Label>
            <Input id="ep-plot" value={plot} onChange={(e) => setPlot(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ep-county">County *</Label>
              <Input id="ep-county" value={county} onChange={(e) => setCounty(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ep-town">Town / area</Label>
              <Input id="ep-town" value={town} onChange={(e) => setTown(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ep-area">Approx. area</Label>
              <Input id="ep-area" value={area} onChange={(e) => setArea(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ep-tenure">Tenure</Label>
              <Input id="ep-tenure" value={tenure} onChange={(e) => setTenure(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ep-lat">Latitude</Label>
              <Input id="ep-lat" value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ep-lng">Longitude</Label>
              <Input id="ep-lng" value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? 'Saving…' : 'Save changes'}
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
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>(parcel.status)
  const [note, setNote] = useState('')

  useReset(open, () => {
    setStatus(parcel.status)
    setNote('')
  })

  async function submit() {
    setBusy(true)
    const ok = await dispatch('parcel.setStatus', {
      id: parcel.id,
      status,
      note: note.trim() || undefined,
    }, `Set ${parcel.plotNumber} record status to ${status}`)
    setBusy(false)
    if (ok) {
      toast.success(online ? `Record status set to ${status}` : `Saved on-device — queued (${outbox.length + 1})`)
      onOpenChange(false)
    } else {
      toast.error('Could not set the record status')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set record status</DialogTitle>
          <DialogDescription>
            Honest record states only: verified means documents + a reviewed, consistent search agree — never
            &quot;government verified&quot;. The note rides the notification trail.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="ps-status">Status *</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="ps-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PARCEL_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{PARCEL_STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ps-note">Note (why?)</Label>
            <Textarea id="ps-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Advocate advised re-checking the beacon plan before handover" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy} className="bg-stone-900 text-white hover:bg-stone-800">
            {busy ? 'Setting…' : 'Set status'}
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
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useReset(open, () => setNote(''))

  async function submit() {
    setBusy(true)
    const ok = await dispatch('search.review', {
      id: search.id,
      decision: 'flag',
      note: note.trim() || undefined,
    }, `Flag registry result for ${parcel.plotNumber}`)
    setBusy(false)
    if (ok) {
      toast.success(online
        ? 'Reviewed and flagged — parcel set to FLAGGED for follow-up'
        : `Saved on-device — queued (${outbox.length + 1})`)
      onOpenChange(false)
    } else {
      toast.error('Could not record the review')
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Flag this registry result for follow-up?</AlertDialogTitle>
          <AlertDialogDescription>
            {parcel.plotNumber} · search <span className="font-mono">{search.searchRef}</span>. Flagging records an
            anomaly for professional follow-up — it is a record state, never an accusation. The parcel will be marked
            FLAGGED.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-2 py-1">
          <Label htmlFor="fs-note">Note (optional)</Label>
          <Textarea id="fs-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Proprietor differs — advocate to obtain the certified official search" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={busy} className="bg-rose-600 text-white hover:bg-rose-700">
            {busy ? 'Flagging…' : 'Flag for follow-up'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
