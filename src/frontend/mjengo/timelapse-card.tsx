'use client'

import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { useT } from '@/frontend/i18n/provider'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Slider } from '@/frontend/ui/slider'
import { Camera } from 'lucide-react'

const SCROLLBAR = '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

/** Day-of-build for a timestamp relative to the project start (Day 1 = ground break). */
function dayOfBuild(iso: string | Date, startDate: string | Date): number {
  const ms = new Date(iso).getTime() - new Date(startDate).getTime()
  return Math.max(1, Math.ceil(ms / 86400000))
}

/**
 * Digital twin time-lapse — scrub from Day 1 to today through the site photo record.
 * Self-contained: reads photos + startDate from the store.
 * All copy flows through useT() (tl.* — issue #125).
 */
export function TimelapseCard() {
  const t = useT()
  const { data } = useMjengo()
  const [index, setIndex] = useState(0)

  const photosAsc = useMemo(() => {
    if (!data) return []
    return [...data.photos].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [data])

  if (!data) return null
  const startDate = data.project.startDate

  if (photosAsc.length < 2) {
    return (
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-stone-900">
            <Camera className="w-5 h-5 text-amber-600" aria-hidden /> {t('tl.title')}
          </CardTitle>
          <CardDescription>{t('tl.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-200 bg-stone-50 py-12 text-center" role="status">
            <Camera className="w-8 h-8 text-stone-300" aria-hidden />
            <p className="text-sm text-stone-500">{t('tl.empty')}</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const safeIndex = Math.min(index, photosAsc.length - 1)
  const photo = photosAsc[safeIndex]
  const firstDay = dayOfBuild(photosAsc[0].createdAt, startDate)
  const lastDay = dayOfBuild(photosAsc[photosAsc.length - 1].createdAt, startDate)
  const day = dayOfBuild(photo.createdAt, startDate)

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-stone-900">
          <Camera className="w-5 h-5 text-amber-600" aria-hidden /> {t('tl.title')}
        </CardTitle>
        <CardDescription>{t('tl.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Main viewer with crossfade */}
        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-stone-200 bg-stone-100">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.img
              key={photo.id}
              src={photo.url}
              alt={t('tl.photoAlt', { caption: photo.caption ?? t('tl.sitePhoto'), day })}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="absolute inset-0 h-full w-full object-cover"
            />
          </AnimatePresence>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-stone-950/70 to-transparent p-3 pt-8">
            <p className="text-sm font-medium text-white">
              {t('tl.day', { day })}
              {photo.phaseName ? ` · ${photo.phaseName}` : ''}
              {photo.caption ? ` · ${photo.caption}` : ''}
              {typeof photo.progressPct === 'number' ? ` · ${photo.progressPct}%` : ''}
            </p>
          </div>
        </div>

        {/* Scrubber */}
        <div className="flex items-center gap-3 px-1">
          <span className="w-14 shrink-0 text-xs font-medium text-stone-500 tabular-nums">{t('tl.day', { day: firstDay })}</span>
          <Slider
            value={[safeIndex]}
            min={0}
            max={photosAsc.length - 1}
            step={1}
            onValueChange={(v) => setIndex(v[0] ?? 0)}
            aria-label={t('tl.scrubberAria')}
            className="flex-1 [&_[data-slot=slider-range]]:bg-amber-500 [&_[data-slot=slider-thumb]]:border-amber-500 [&_[data-slot=slider-thumb]]:bg-amber-50"
          />
          <span className="w-14 shrink-0 text-right text-xs font-medium text-stone-500 tabular-nums">{t('tl.day', { day: lastDay })}</span>
        </div>

        {/* Filmstrip */}
        <div className={`flex gap-2 overflow-x-auto pb-2 ${SCROLLBAR}`} role="listbox" aria-label={t('tl.filmstripAria')}>
          {photosAsc.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === safeIndex}
              aria-label={p.caption
                ? t('tl.jumpAriaCap', { day: dayOfBuild(p.createdAt, startDate), caption: p.caption })
                : t('tl.jumpAria', { day: dayOfBuild(p.createdAt, startDate) })}
              onClick={() => setIndex(i)}
              className={`relative h-14 w-24 shrink-0 overflow-hidden rounded-lg border-2 transition-all ${i === safeIndex ? 'border-amber-500 ring-2 ring-amber-500/30' : 'border-transparent opacity-70 hover:opacity-100'}`}
            >
              <img src={p.url} alt="" className="h-full w-full object-cover" />
              <span className="absolute bottom-0.5 left-1 rounded bg-stone-950/70 px-1 text-[9px] font-medium text-white tabular-nums">
                D{dayOfBuild(p.createdAt, startDate)}
              </span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
