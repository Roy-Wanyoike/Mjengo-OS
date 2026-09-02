'use client'

// Land & Property — parcel summary card (grid item).

import { Card, CardContent } from '@/frontend/ui/card'
import { FileText, MapPin, ScanSearch, Users } from 'lucide-react'
import { dateShort } from '@/frontend/lib/format'
import type { ParcelDetail } from '@/backend/modules/land/types'
import { ParcelStatusBadge } from './badges'

export function ParcelCard({
  parcel,
  selected,
  onSelect,
}: {
  parcel: ParcelDetail
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(parcel.id)}
      aria-pressed={selected}
      aria-label={`Open parcel ${parcel.plotNumber}, ${parcel.county}`}
      className={`min-w-0 w-full text-left rounded-xl border shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-900 focus-visible:ring-offset-2 ${
        selected ? 'border-stone-900 ring-1 ring-stone-900 bg-stone-50' : 'border-stone-200 bg-white hover:border-stone-400'
      }`}
    >
      <Card className="border-0 shadow-none bg-transparent">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2 min-w-0">
            <h3 className="text-sm font-semibold text-stone-900 truncate leading-5">{parcel.plotNumber}</h3>
            <ParcelStatusBadge status={parcel.status} />
          </div>
          <p className="flex items-center gap-1.5 text-sm text-stone-600 min-w-0">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
            <span className="truncate">
              {parcel.town ? `${parcel.town}, ` : ''}
              {parcel.county}
            </span>
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
            <span className="truncate">{parcel.approxArea ?? 'Area not recorded'}</span>
            {parcel.tenureType && <span className="truncate capitalize">{parcel.tenureType}</span>}
            <span className="ml-auto shrink-0">recorded {dateShort(parcel.createdAt)}</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-stone-600 pt-1 border-t border-stone-100">
            <span className="flex items-center gap-1">
              <FileText className="h-3.5 w-3.5 text-stone-400" aria-hidden />
              {parcel.documents.length} doc{parcel.documents.length === 1 ? '' : 's'}
            </span>
            <span className="flex items-center gap-1">
              <ScanSearch className="h-3.5 w-3.5 text-stone-400" aria-hidden />
              {parcel.searches.length} search{parcel.searches.length === 1 ? '' : 'es'}
            </span>
            <span className="flex items-center gap-1">
              <Users className="h-3.5 w-3.5 text-stone-400" aria-hidden />
              {parcel.assignments.length} pro{parcel.assignments.length === 1 ? '' : 's'}
            </span>
          </div>
        </CardContent>
      </Card>
    </button>
  )
}
