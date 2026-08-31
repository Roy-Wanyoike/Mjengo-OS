'use client'

// Land & Property — parcels section (agent 2-a). Parcel grid → inline detail
// (timeline, documents, registry searches with the consistency verdict,
// Property Passport) + the honest "what MjengoOS does NOT do" block.

import { useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Landmark, Plus, ScanSearch, X } from 'lucide-react'
import { ParcelCard } from './parcels/parcel-card'
import { ParcelDetail } from './parcels/parcel-detail'
import { NewParcelDialog } from './parcels/dialogs'

const NOT_DOING: { title: string; text: string }[] = [
  {
    title: 'Not a land registry.',
    text: 'The lands registry is the authority on ownership. MjengoOS organizes its outputs — it does not replace them.',
  },
  {
    title: 'Searches are recorded, not confirmed.',
    text: 'Official results are obtained by people and attached here. There is no live registry link, and we will not pretend otherwise.',
  },
  {
    title: 'A mismatch is a flag, never a verdict.',
    text: 'The consistency check is deterministic string comparison between the deed transcription and the recorded registry result. Humans decide what a difference means.',
  },
  {
    title: 'The advocate\u2019s review remains the legal step.',
    text: 'Their opinion becomes part of the record; it never originates from the platform. Legal advice stays licensed, human and accountable.',
  },
]

export function ParcelsSection() {
  const { data, viewMode } = useMjengo()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  if (!data) return null
  const isClient = viewMode === 'client'
  const parcels = data.land?.parcels ?? []
  const selected = parcels.find((p) => p.id === selectedId) ?? null
  const searching = parcels.filter((p) => p.status === 'searching').length
  const flagged = parcels.filter((p) => p.status === 'flagged').length

  return (
    <section aria-label="Land parcels" className="space-y-4">
      {/* section header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-stone-900 flex items-center gap-2">
            <Landmark className="h-5 w-5 text-stone-500" aria-hidden />
            Parcels &amp; title record
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            {parcels.length} parcel{parcels.length === 1 ? '' : 's'} on record
            {searching > 0 && ` · ${searching} searching`}
            {flagged > 0 && ` · ${flagged} flagged`}
            {' '}— honest record states, never government certification
          </p>
        </div>
        {!isClient && (
          <Button size="sm" className="gap-1.5 bg-stone-900 text-white hover:bg-stone-800" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Record parcel
          </Button>
        )}
      </div>

      {/* parcel grid */}
      {parcels.length ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 min-w-0">
          {parcels.map((parcel) => (
            <ParcelCard
              key={parcel.id}
              parcel={parcel}
              selected={parcel.id === selectedId}
              onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
            />
          ))}
        </div>
      ) : (
        <Card className="border-stone-200 shadow-sm">
          <CardContent className="p-6 min-h-48 flex flex-col items-center justify-center text-center gap-3">
            <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
              <ScanSearch className="w-7 h-7 text-stone-500" />
            </div>
            <div className="space-y-1.5 max-w-md">
              <h3 className="text-base font-semibold text-stone-900">No parcels recorded yet</h3>
              <p className="text-sm text-stone-500 leading-relaxed">
                Record the plot first — it starts in the honest SEARCHING state, then attach the title deed and request
                the registry search.
              </p>
            </div>
            {!isClient && (
              <Button size="sm" className="gap-1.5 bg-stone-900 text-white hover:bg-stone-800" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden /> Record parcel
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* inline detail panel (no routing) */}
      {selected && <ParcelDetail parcel={selected} canEdit={!isClient} onClose={() => setSelectedId(null)} />}

      {/* honesty block */}
      <Card className="border-stone-300 shadow-sm bg-stone-50" aria-label="What MjengoOS does NOT do">
        <CardContent className="p-5 sm:p-6">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-700" aria-hidden>
              <X className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-stone-900">What MjengoOS does NOT do</h3>
              <p className="text-xs text-stone-500">A land-truth workflow you can trust starts with what it cannot promise</p>
            </div>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {NOT_DOING.map((item) => (
              <li key={item.title} className="rounded-lg border border-stone-200 bg-white p-3.5 min-w-0">
                <h4 className="text-sm font-semibold text-stone-800">{item.title}</h4>
                <p className="mt-1 text-xs text-stone-500 leading-relaxed">{item.text}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-stone-500 leading-relaxed max-w-3xl">
            The registry remains authoritative. MjengoOS keeps the registry outputs, survey plans and legal opinions
            organized, attached to the parcel, and impossible to lose — that is the whole claim, and it is enough.
          </p>
        </CardContent>
      </Card>

      <NewParcelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => setSelectedId(id)}
      />
    </section>
  )
}
