'use client'

// Land & Property — honest-status badges (record states, never certifications).

import { Badge } from '@/components/ui/badge'
import { Check, CircleHelp, FileSearch, Hourglass, ScanSearch, TriangleAlert } from 'lucide-react'
import { MATCH_LABELS, SEARCH_STATUS_LABELS } from '@/modules/land/types'

export function ParcelStatusBadge({ status }: { status: string }) {
  if (status === 'verified')
    return (
      <Badge className="border-0 gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100" title="MjengoOS record state — documents + reviewed registry search agree. Not a government certification.">
        <Check className="h-3 w-3" aria-hidden /> Verified
      </Badge>
    )
  if (status === 'flagged')
    return (
      <Badge className="border-0 gap-1 bg-rose-100 text-rose-800 hover:bg-rose-100" title="Anomaly flag for human review — never an accusation.">
        <TriangleAlert className="h-3 w-3" aria-hidden /> Flagged
      </Badge>
    )
  return (
    <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100" title="Verification in progress — searches and documents are being gathered.">
      <Hourglass className="h-3 w-3" aria-hidden /> Searching
    </Badge>
  )
}

export function MatchBadge({ match }: { match: string }) {
  if (match === 'consistent')
    return (
      <Badge className="border-0 gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100" title="The registry result matches the deed transcription on plot number and proprietor.">
        <Check className="h-3 w-3" aria-hidden /> {MATCH_LABELS.consistent}
      </Badge>
    )
  if (match === 'mismatch')
    return (
      <Badge className="border-0 gap-1 bg-rose-100 text-rose-800 hover:bg-rose-100" title="The registry result differs from the deed transcription — an anomaly flag for human review, not an accusation.">
        <TriangleAlert className="h-3 w-3" aria-hidden /> {MATCH_LABELS.mismatch}
      </Badge>
    )
  return (
    <Badge className="border-0 gap-1 bg-stone-100 text-stone-600 hover:bg-stone-100" title="No title-deed transcription to compare against yet, or nothing comparable was extracted.">
      <CircleHelp className="h-3 w-3" aria-hidden /> {MATCH_LABELS.pending}
    </Badge>
  )
}

export function SearchStatusBadge({ status }: { status: string }) {
  if (status === 'reviewed')
    return (
      <Badge className="border-0 gap-1 bg-stone-800 text-stone-50 hover:bg-stone-800" title="A human reviewed the received result.">
        <Check className="h-3 w-3" aria-hidden /> {SEARCH_STATUS_LABELS.reviewed}
      </Badge>
    )
  if (status === 'received')
    return (
      <Badge className="border-0 gap-1 bg-stone-200 text-stone-700 hover:bg-stone-200" title="Result recorded — awaiting human review.">
        <FileSearch className="h-3 w-3" aria-hidden /> {SEARCH_STATUS_LABELS.received}
      </Badge>
    )
  return (
    <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100" title="Requested — the registry result has not been recorded yet.">
      <ScanSearch className="h-3 w-3" aria-hidden /> {SEARCH_STATUS_LABELS.requested}
    </Badge>
  )
}
