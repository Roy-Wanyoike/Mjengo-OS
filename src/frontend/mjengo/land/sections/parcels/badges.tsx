'use client'

// Land & Property — honest-status badges (record states, never certifications).

import { Badge } from '@/frontend/ui/badge'
import { Check, CircleHelp, FileSearch, Hourglass, ScanSearch, TriangleAlert } from 'lucide-react'
import { useT } from '@/frontend/i18n/provider'
import { matchLabel, searchStatusLabel, parcelStatusLabel } from '@/frontend/mjengo/land/labels'

export function ParcelStatusBadge({ status }: { status: string }) {
  const t = useT()
  if (status === 'verified')
    return (
      <Badge className="border-0 gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100" title={t('land.parcelStatus.verified.title')}>
        <Check className="h-3 w-3" aria-hidden /> {parcelStatusLabel(t, 'verified')}
      </Badge>
    )
  if (status === 'flagged')
    return (
      <Badge className="border-0 gap-1 bg-rose-100 text-rose-800 hover:bg-rose-100" title={t('land.parcelStatus.flagged.title')}>
        <TriangleAlert className="h-3 w-3" aria-hidden /> {parcelStatusLabel(t, 'flagged')}
      </Badge>
    )
  return (
    <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100" title={t('land.parcelStatus.searching.title')}>
      <Hourglass className="h-3 w-3" aria-hidden /> {parcelStatusLabel(t, 'searching')}
    </Badge>
  )
}

export function MatchBadge({ match }: { match: string }) {
  const t = useT()
  if (match === 'consistent')
    return (
      <Badge className="border-0 gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100" title={t('land.match.consistent.title')}>
        <Check className="h-3 w-3" aria-hidden /> {matchLabel(t, 'consistent')}
      </Badge>
    )
  if (match === 'mismatch')
    return (
      <Badge className="border-0 gap-1 bg-rose-100 text-rose-800 hover:bg-rose-100" title={t('land.match.mismatch.title')}>
        <TriangleAlert className="h-3 w-3" aria-hidden /> {matchLabel(t, 'mismatch')}
      </Badge>
    )
  return (
    <Badge className="border-0 gap-1 bg-stone-100 text-stone-600 hover:bg-stone-100" title={t('land.match.pending.title')}>
      <CircleHelp className="h-3 w-3" aria-hidden /> {matchLabel(t, 'pending')}
    </Badge>
  )
}

export function SearchStatusBadge({ status }: { status: string }) {
  const t = useT()
  if (status === 'reviewed')
    return (
      <Badge className="border-0 gap-1 bg-stone-800 text-stone-50 hover:bg-stone-800" title={t('land.searchStatus.reviewed.title')}>
        <Check className="h-3 w-3" aria-hidden /> {searchStatusLabel(t, 'reviewed')}
      </Badge>
    )
  if (status === 'received')
    return (
      <Badge className="border-0 gap-1 bg-stone-200 text-stone-700 hover:bg-stone-200" title={t('land.searchStatus.received.title')}>
        <FileSearch className="h-3 w-3" aria-hidden /> {searchStatusLabel(t, 'received')}
      </Badge>
    )
  return (
    <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100" title={t('land.searchStatus.requested.title')}>
      <ScanSearch className="h-3 w-3" aria-hidden /> {searchStatusLabel(t, 'requested')}
    </Badge>
  )
}
