'use client'

// Land & Property — parcel record timeline: every document, search and
// assignment event on one rail, oldest first (the due-diligence story).

import { BadgeCheck, FileCheck2, FileText, Landmark, MapPin, ScanSearch, UserCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { dateShort } from '@/frontend/lib/format'
import { ASSIGNMENT_ROLE_LABELS, DOC_KIND_LABELS, type ParcelDetail } from '@/backend/modules/land/types'

type Tone = 'neutral' | 'good' | 'bad'

interface TimelineEvent {
  id: string
  // Payload dates arrive as ISO strings after the fetch JSON round-trip,
  // while offline optimistic writes carry real Dates — accept both.
  date: string | Date
  icon: LucideIcon
  title: string
  detail?: string | null
  tone: Tone
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-600',
  good: 'bg-emerald-100 text-emerald-700',
  bad: 'bg-rose-100 text-rose-700',
}

function docIcon(kind: string): LucideIcon {
  if (kind === 'title_deed') return FileText
  if (kind === 'survey_map') return MapPin
  return FileCheck2
}

export function buildParcelTimeline(parcel: ParcelDetail): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: `parcel-${parcel.id}`,
      date: parcel.createdAt,
      icon: Landmark,
      title: 'Parcel recorded',
      detail: `${parcel.plotNumber} · ${parcel.county}`,
      tone: 'neutral',
    },
  ]

  for (const doc of parcel.documents) {
    events.push({
      id: doc.id,
      date: doc.createdAt,
      icon: docIcon(doc.kind),
      title: `${DOC_KIND_LABELS[doc.kind as keyof typeof DOC_KIND_LABELS] ?? 'Document'} attached`,
      detail: doc.fileName,
      tone: 'neutral',
    })
  }

  for (const s of parcel.searches) {
    events.push({
      id: `req-${s.id}`,
      date: s.requestedAt,
      icon: ScanSearch,
      title: 'Registry search requested',
      detail: s.searchRef,
      tone: 'neutral',
    })
    if (s.receivedAt) {
      events.push({
        id: `rec-${s.id}`,
        date: s.receivedAt,
        icon: FileCheck2,
        title: 'Registry result received',
        detail:
          s.transcriptionMatch === 'mismatch'
            ? 'Transcription mismatch — review required'
            : s.transcriptionMatch === 'consistent'
              ? 'Transcription consistent with the deed'
              : 'No deed transcription to compare against',
        tone: s.transcriptionMatch === 'mismatch' ? 'bad' : s.transcriptionMatch === 'consistent' ? 'good' : 'neutral',
      })
    }
    if (s.reviewedAt) {
      events.push({
        id: `rev-${s.id}`,
        date: s.reviewedAt,
        icon: BadgeCheck,
        title: 'Result reviewed by a human',
        detail: s.searchRef,
        tone: 'neutral',
      })
    }
  }

  for (const a of parcel.assignments) {
    events.push({
      id: a.id,
      date: a.createdAt,
      icon: UserCheck,
      title: `${ASSIGNMENT_ROLE_LABELS[a.role] ?? 'Professional'} assigned`,
      detail: `${a.professionalName}${a.status !== 'active' ? ` · ${a.status}` : ''}`,
      tone: 'neutral',
    })
  }

  return events.sort((x, y) => new Date(x.date).getTime() - new Date(y.date).getTime())
}

export function ParcelTimeline({ parcel }: { parcel: ParcelDetail }) {
  const events = buildParcelTimeline(parcel)
  return (
    <ol className="space-y-0" aria-label={`Parcel record timeline for ${parcel.plotNumber}`}>
      {events.map((e, i) => (
        <li key={e.id} className="flex gap-3 min-w-0">
          <div className="flex flex-col items-center" aria-hidden>
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${TONE_CLASS[e.tone]}`}>
              <e.icon className="h-3.5 w-3.5" />
            </span>
            {i < events.length - 1 && <span className="w-0.5 flex-1 min-h-5 bg-stone-200" />}
          </div>
          <div className="pb-5 min-w-0">
            <p className="text-sm font-medium text-stone-800 leading-7">
              {e.title} <span className="text-xs font-normal text-stone-400">· {dateShort(e.date)}</span>
            </p>
            {e.detail && <p className="text-xs text-stone-500 truncate leading-5">{e.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}
