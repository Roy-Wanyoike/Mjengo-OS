'use client'

// Land & Property — parcel record timeline: every document, search and
// assignment event on one rail, oldest first (the due-diligence story).

import { BadgeCheck, FileCheck2, FileText, Landmark, MapPin, ScanSearch, UserCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { dateShort } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'
import type { TranslateFn } from '@/frontend/i18n/types'
import { assignRoleLabel, docKindLabel } from '@/frontend/mjengo/land/labels'
import type { ParcelDetail } from '@/backend/modules/land/types'

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

export function buildParcelTimeline(parcel: ParcelDetail, t: TranslateFn): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: `parcel-${parcel.id}`,
      date: parcel.createdAt,
      icon: Landmark,
      title: t('land.timeline.parcelRecorded'),
      detail: `${parcel.plotNumber} · ${parcel.county}`,
      tone: 'neutral',
    },
  ]

  for (const doc of parcel.documents) {
    events.push({
      id: doc.id,
      date: doc.createdAt,
      icon: docIcon(doc.kind),
      title: t('land.timeline.docAttached', { kind: docKindLabel(t, doc.kind) }),
      detail: doc.fileName,
      tone: 'neutral',
    })
  }

  for (const s of parcel.searches) {
    events.push({
      id: `req-${s.id}`,
      date: s.requestedAt,
      icon: ScanSearch,
      title: t('land.timeline.searchRequested'),
      detail: s.searchRef,
      tone: 'neutral',
    })
    if (s.receivedAt) {
      events.push({
        id: `rec-${s.id}`,
        date: s.receivedAt,
        icon: FileCheck2,
        title: t('land.timeline.resultReceived'),
        detail:
          s.transcriptionMatch === 'mismatch'
            ? t('land.timeline.detail.mismatch')
            : s.transcriptionMatch === 'consistent'
              ? t('land.timeline.detail.consistent')
              : t('land.timeline.detail.noDeed'),
        tone: s.transcriptionMatch === 'mismatch' ? 'bad' : s.transcriptionMatch === 'consistent' ? 'good' : 'neutral',
      })
    }
    if (s.reviewedAt) {
      events.push({
        id: `rev-${s.id}`,
        date: s.reviewedAt,
        icon: BadgeCheck,
        title: t('land.timeline.reviewed'),
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
      title: t('land.timeline.assigned', { role: assignRoleLabel(t, a.role) }),
      detail: `${a.professionalName}${a.status !== 'active' ? ` · ${a.status}` : ''}`,
      tone: 'neutral',
    })
  }

  return events.sort((x, y) => new Date(x.date).getTime() - new Date(y.date).getTime())
}

export function ParcelTimeline({ parcel }: { parcel: ParcelDetail }) {
  const t = useT()
  const events = buildParcelTimeline(parcel, t)
  return (
    <ol className="space-y-0" aria-label={t('land.timeline.aria', { plot: parcel.plotNumber })}>
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
