'use client'

// Land & Property — parcel detail panel: particulars, actions, documents,
// registry searches with the consistency verdict, the full event timeline and
// the Property Passport. Rendered inline BELOW the parcel grid (no routing).

import { useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  FilePlus2,
  FileText,
  FileCheck2,
  Landmark,
  Map,
  MapPin,
  Pencil,
  ScanSearch,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { dateShort } from '@/lib/format'
import { DOC_KIND_LABELS, type ParcelDetail } from '@/modules/land/types'
import type { TitleSearch } from '@prisma/client'
import { MatchBadge, ParcelStatusBadge, SearchStatusBadge } from './badges'
import { ParcelTimeline } from './timeline'
import { PropertyPassport } from './property-passport'
import {
  AttachDocumentDialog,
  EditParcelDialog,
  FlagSearchConfirmDialog,
  ReceiveResultDialog,
  RequestSearchDialog,
  SetParcelStatusDialog,
} from './dialogs'

function docKindIcon(kind: string): LucideIcon {
  if (kind === 'survey_map') return Map
  if (kind === 'search_cert') return FileCheck2
  return FileText
}

function TranscriptionPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const preview = text.length > 180 ? `${text.slice(0, 180)}…` : text
  return (
    <div className="mt-1.5 rounded-md border border-stone-100 bg-stone-50 p-2 min-w-0" aria-label="Document transcription">
      <p className="text-xs text-stone-600 leading-relaxed whitespace-pre-wrap break-words">{expanded ? text : preview}</p>
      {text.length > 180 && (
        <button
          type="button"
          className="mt-1 text-[11px] font-medium text-stone-500 underline hover:text-stone-800"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show full transcription'}
        </button>
      )}
    </div>
  )
}

export function ParcelDetail({
  parcel,
  canEdit,
  onClose,
}: {
  parcel: ParcelDetail
  canEdit: boolean
  onClose: () => void
}) {
  const { dispatch, online, outbox } = useMjengo()
  const [attachOpen, setAttachOpen] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [receiveFor, setReceiveFor] = useState<TitleSearch | null>(null)
  const [flagFor, setFlagFor] = useState<TitleSearch | null>(null)
  const [reviewBusy, setReviewBusy] = useState<string | null>(null)

  const openSearch = parcel.searches.find((s) => s.status === 'requested')
  const receiveable = parcel.searches.find((s) => s.status === 'requested')

  async function markReviewed(search: TitleSearch) {
    setReviewBusy(search.id)
    const ok = await dispatch('search.review', { id: search.id, decision: 'accept' }, `Mark search ${search.searchRef} reviewed`)
    setReviewBusy(null)
    if (ok) {
      const status = useMjengo.getState().data?.land?.parcels?.find((p) => p.id === parcel.id)?.status
      toast.success(
        status === 'verified'
          ? online
            ? 'Reviewed — documents + consistent search agree: parcel record is now VERIFIED'
            : `Saved on-device — queued (${outbox.length + 1})`
          : online
            ? 'Search marked reviewed — a consistent result with documents on file would mark the parcel verified'
            : `Saved on-device — queued (${outbox.length + 1})`,
      )
    } else {
      toast.error('Could not record the review')
    }
  }

  const particulars: { label: string; value: string }[] = [
    { label: 'County', value: parcel.county },
    { label: 'Town / area', value: parcel.town ?? 'Not recorded' },
    { label: 'Approx. area', value: parcel.approxArea ?? 'Not recorded' },
    { label: 'Tenure', value: parcel.tenureType ?? 'Not recorded' },
    {
      label: 'Coordinates',
      value: parcel.lat !== null && parcel.lng !== null ? `${parcel.lat.toFixed(4)}, ${parcel.lng.toFixed(4)}` : 'Not recorded',
    },
    { label: 'Recorded', value: dateShort(parcel.createdAt) },
  ]

  return (
    <div className="space-y-4" aria-label={`Parcel record for ${parcel.plotNumber}`}>
      {/* identity + actions */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-2">
          <div className="min-w-0">
            <CardTitle className="text-lg text-stone-900 flex flex-wrap items-center gap-2">
              <Landmark className="h-5 w-5 text-stone-400 shrink-0" aria-hidden />
              <span className="truncate">{parcel.plotNumber}</span>
            </CardTitle>
            <CardDescription className="mt-1 flex items-center gap-1.5 min-w-0">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
              <span className="truncate">{parcel.town ? `${parcel.town}, ` : ''}{parcel.county}</span>
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ParcelStatusBadge status={parcel.status} />
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-stone-400 hover:text-stone-700"
              onClick={onClose}
              aria-label="Close parcel detail"
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3">
            {particulars.map((p) => (
              <div key={p.label} className="min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{p.label}</dt>
                <dd className="text-sm text-stone-800 truncate capitalize" title={p.value}>{p.value}</dd>
              </div>
            ))}
          </dl>

          {canEdit && (
            <div className="flex flex-wrap gap-2 pt-1 border-t border-stone-100">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAttachOpen(true)}>
                <FilePlus2 className="h-4 w-4" aria-hidden /> Attach document
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setRequestOpen(true)}
                disabled={Boolean(openSearch)}
                title={openSearch ? 'A registry search is already requested — receive its result first' : undefined}
              >
                <ScanSearch className="h-4 w-4" aria-hidden /> Request registry search
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" aria-hidden /> Edit particulars
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setStatusOpen(true)}>
                <SlidersHorizontal className="h-4 w-4" aria-hidden /> Set record status
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* documents */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-stone-900">Documents</CardTitle>
          <CardDescription>
            Metadata + transcriptions attached to the parcel — the title-deed text powers the consistency check
            {parcel.documents.length ? ` (${parcel.documents.length} on file)` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {parcel.documents.length ? (
            <ul className="space-y-3">
              {parcel.documents.map((doc) => {
                const Icon = docKindIcon(doc.kind)
                return (
                  <li key={doc.id} className="flex gap-3 items-start min-w-0">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-600" aria-hidden>
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-stone-800 truncate" title={doc.fileName}>{doc.fileName}</p>
                      <p className="text-xs text-stone-500">
                        {DOC_KIND_LABELS[doc.kind as keyof typeof DOC_KIND_LABELS] ?? 'Document'}
                        {' · '}attached {dateShort(doc.createdAt)}
                        {doc.issuedOn ? ` · issued ${dateShort(doc.issuedOn)}` : ''}
                      </p>
                      {doc.extractedText && <TranscriptionPreview text={doc.extractedText} />}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-stone-400 py-2">
              No documents attached yet — attach the title deed (with its transcription) to power the consistency check.
            </p>
          )}
        </CardContent>
      </Card>

      {/* registry searches */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-stone-900">Registry searches</CardTitle>
          <CardDescription>
            Requests are recorded, not confirmed — no live registry link. Results are typed by people and checked
            against the deed transcription.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {parcel.searches.length ? (
            <ul className="space-y-3">
              {parcel.searches.map((search) => (
                <li key={search.id} className="rounded-lg border border-stone-200 p-3 min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                    <span className="font-mono text-xs font-medium text-stone-700">{search.searchRef}</span>
                    <div className="flex flex-wrap gap-1.5">
                      <SearchStatusBadge status={search.status} />
                      {search.status !== 'requested' && <MatchBadge match={search.transcriptionMatch} />}
                    </div>
                  </div>
                  <p className="text-xs text-stone-500">
                    Requested {dateShort(search.requestedAt)}
                    {search.receivedAt ? ` · received ${dateShort(search.receivedAt)}` : ''}
                    {search.reviewedAt ? ` · reviewed ${dateShort(search.reviewedAt)}` : ''}
                  </p>
                  {search.resultSummary && (
                    <p className="text-sm text-stone-700 leading-relaxed min-w-0 break-words">{search.resultSummary}</p>
                  )}
                  {canEdit && search.status === 'requested' && (
                    <Button size="sm" className="gap-1.5 bg-stone-900 text-white hover:bg-stone-800" onClick={() => setReceiveFor(search)}>
                      <FileCheck2 className="h-4 w-4" aria-hidden /> Receive result
                    </Button>
                  )}
                  {canEdit && search.status === 'received' && (
                    <div className="flex flex-wrap gap-2 pt-1 border-t border-stone-100">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={reviewBusy === search.id}
                        onClick={() => void markReviewed(search)}
                        title="Record a human review — a CONSISTENT result with ≥1 document on file marks the parcel verified"
                      >
                        <FileCheck2 className="h-4 w-4" aria-hidden />
                        {reviewBusy === search.id ? 'Reviewing…' : 'Mark reviewed'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-rose-700 border-rose-200 hover:bg-rose-50 hover:text-rose-800"
                        onClick={() => setFlagFor(search)}
                      >
                        <ScanSearch className="h-4 w-4" aria-hidden /> Flag for follow-up
                      </Button>
                    </div>
                  )}
                  {search.status === 'reviewed' && (
                    <Badge className="border-0 bg-stone-100 text-stone-600 hover:bg-stone-100">
                      Reviewed by a human · decision on the timeline
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-400 py-2">No registry search requested yet.</p>
          )}
        </CardContent>
      </Card>

      {/* timeline */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-stone-900">Parcel record timeline</CardTitle>
          <CardDescription>Every document, search and professional assignment, oldest first</CardDescription>
        </CardHeader>
        <CardContent>
          <ParcelTimeline parcel={parcel} />
        </CardContent>
      </Card>

      {/* property passport */}
      <PropertyPassport parcel={parcel} />

      {/* dialogs */}
      <AttachDocumentDialog parcel={parcel} open={attachOpen} onOpenChange={setAttachOpen} />
      <RequestSearchDialog parcel={parcel} open={requestOpen} onOpenChange={setRequestOpen} />
      <EditParcelDialog parcel={parcel} open={editOpen} onOpenChange={setEditOpen} />
      <SetParcelStatusDialog parcel={parcel} open={statusOpen} onOpenChange={setStatusOpen} />
      {receiveable && (
        <ReceiveResultDialog parcel={parcel} search={receiveFor ?? receiveable} open={Boolean(receiveFor)} onOpenChange={(v) => !v && setReceiveFor(null)} />
      )}
      {flagFor && (
        <FlagSearchConfirmDialog parcel={parcel} search={flagFor} open onOpenChange={(v) => !v && setFlagFor(null)} />
      )}
    </div>
  )
}
