'use client'

// Land & Property — parcels section. Parcel grid → inline detail
// (timeline, documents, registry searches with the consistency verdict,
// Property Passport) + the honest "what MjengoOS does NOT do" block.

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent } from '@/frontend/ui/card'
import { Landmark, Plus, ScanSearch, X } from 'lucide-react'
import { EmptyState } from '@/frontend/mjengo/uikit/empty-state'
import { useT } from '@/frontend/i18n/provider'
import { ParcelCard } from './parcels/parcel-card'
import { ParcelDetail } from './parcels/parcel-detail'
import { NewParcelDialog } from './parcels/dialogs'

// i18n (issue #107): keys rendered via t() — values stay verbatim.
const NOT_DOING_KEYS: { titleKey: string; textKey: string }[] = [
  { titleKey: 'land.notDoing.1.title', textKey: 'land.notDoing.1.text' },
  { titleKey: 'land.notDoing.2.title', textKey: 'land.notDoing.2.text' },
  { titleKey: 'land.notDoing.3.title', textKey: 'land.notDoing.3.text' },
  { titleKey: 'land.notDoing.4.title', textKey: 'land.notDoing.4.text' },
]

export function ParcelsSection() {
  const { data, viewMode } = useMjengo()
  const t = useT()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  if (!data) return null
  const isClient = viewMode === 'client'
  const parcels = data.land?.parcels ?? []
  const selected = parcels.find((p) => p.id === selectedId) ?? null
  const searching = parcels.filter((p) => p.status === 'searching').length
  const flagged = parcels.filter((p) => p.status === 'flagged').length

  return (
    <section aria-label={t('land.parcels.aria')} className="space-y-4">
      {/* section header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-stone-900 flex items-center gap-2">
            <Landmark className="h-5 w-5 text-stone-500" aria-hidden />
            {t('land.parcels.title')}
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            {t('land.parcels.desc', {
              count: parcels.length,
              parcels: parcels.length === 1 ? t('land.parcels.countOne') : t('land.parcels.countMany'),
              searching: searching > 0 ? t('land.parcels.searching', { count: searching }) : '',
              flagged: flagged > 0 ? t('land.parcels.flagged', { count: flagged }) : '',
            })}
          </p>
        </div>
        {!isClient && (
          <Button size="sm" className="gap-1.5 bg-stone-900 text-white hover:bg-stone-800" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden /> {t('land.parcels.record')}
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
          <CardContent className="p-6">
            <EmptyState
              icon={ScanSearch}
              title={t('land.parcels.emptyTitle')}
              description={t('land.parcels.emptyDesc')}
              action={!isClient && (
                <Button size="sm" className="gap-1.5 bg-stone-900 text-white hover:bg-stone-800" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden /> {t('land.parcels.record')}
                </Button>
              )}
            />
          </CardContent>
        </Card>
      )}

      {/* inline detail panel (no routing) */}
      {selected && <ParcelDetail parcel={selected} canEdit={!isClient} onClose={() => setSelectedId(null)} />}

      {/* honesty block */}
      <Card className="border-stone-300 shadow-sm bg-stone-50" aria-label={t('land.notDoing.aria')}>
        <CardContent className="p-5 sm:p-6">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-700" aria-hidden>
              <X className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-stone-900">{t('land.notDoing.title')}</h3>
              <p className="text-xs text-stone-500">{t('land.notDoing.subtitle')}</p>
            </div>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {NOT_DOING_KEYS.map((item) => (
              <li key={item.titleKey} className="rounded-lg border border-stone-200 bg-white p-3.5 min-w-0">
                <h4 className="text-sm font-semibold text-stone-800">{t(item.titleKey)}</h4>
                <p className="mt-1 text-xs text-stone-500 leading-relaxed">{t(item.textKey)}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-stone-500 leading-relaxed max-w-3xl">
            {t('land.notDoing.footer')}
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
