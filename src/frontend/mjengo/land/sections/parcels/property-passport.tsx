'use client'

// Land & Property — the Property Passport: one printable page summarizing the
// parcel identity + the verification ladder state. It is a MJENGOOS RECORD,
// never a government document — the lands registry remains the authority.

import { useEffect, useState } from 'react'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent } from '@/frontend/ui/card'
import { FileText, Landmark, Printer, ScanSearch, UserCheck, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { dateShort } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'
import type { TranslateFn } from '@/frontend/i18n/types'
import { assignRoleLabel } from '@/frontend/mjengo/land/labels'
import type { ParcelDetail } from '@/backend/modules/land/types'

type LadderState = 'done' | 'warn' | 'bad' | 'empty'

// i18n (issue #107): badge title carries a DICT KEY rendered via t().
const LADDER_BADGE: Record<LadderState, { cls: string; titleKey: string }> = {
  done: { cls: 'border-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100', titleKey: 'land.passport.state.onFile' },
  warn: { cls: 'border-0 bg-amber-100 text-amber-900 hover:bg-amber-100', titleKey: 'land.passport.state.pending' },
  bad: { cls: 'border-0 bg-rose-100 text-rose-800 hover:bg-rose-100', titleKey: 'land.passport.state.reviewRequired' },
  empty: { cls: 'border-0 bg-stone-100 text-stone-600 hover:bg-stone-100', titleKey: 'land.passport.state.none' },
}

interface LadderRow {
  icon: LucideIcon
  field: string
  note: string
  state: LadderState
  stateLabel: string
}

function buildLadder(parcel: ParcelDetail, t: TranslateFn): LadderRow[] {
  const deed = parcel.documents.find((d) => d.kind === 'title_deed')
  const latest = parcel.searches[0] // repository orders newest first
  const activeAssignments = parcel.assignments.filter((a) => a.status === 'active')

  const searchRow: LadderRow = !latest
    ? { icon: ScanSearch, field: t('land.passport.row.search'), note: t('land.passport.note.noSearch'), state: 'empty', stateLabel: t('land.passport.state.notRequested') }
    : latest.status === 'requested'
      ? { icon: ScanSearch, field: t('land.passport.row.search'), note: t('land.passport.note.awaitingResult', { ref: latest.searchRef }), state: 'warn', stateLabel: t('land.passport.state.requested') }
      : latest.transcriptionMatch === 'mismatch'
        ? { icon: ScanSearch, field: t('land.passport.row.search'), note: t('land.passport.note.differs', { ref: latest.searchRef }), state: 'bad', stateLabel: t('land.passport.state.mismatch') }
        : { icon: ScanSearch, field: t('land.passport.row.search'), note: t('land.passport.note.recorded', { ref: latest.searchRef, consistent: latest.transcriptionMatch === 'consistent' ? t('land.passport.note.andConsistent') : '' }), state: 'done', stateLabel: t('land.passport.state.received') }

  const reviewRow: LadderRow = !latest || latest.status !== 'reviewed'
    ? { icon: UserCheck, field: t('land.passport.row.review'), note: latest?.status === 'received' ? t('land.passport.note.awaitingReview') : t('land.passport.note.nothingToReview'), state: latest?.status === 'received' ? 'warn' : 'empty', stateLabel: latest?.status === 'received' ? t('land.passport.state.pending') : t('land.passport.state.notYet') }
    : { icon: UserCheck, field: t('land.passport.row.review'), note: latest.reviewedAt ? t('land.passport.note.reviewed', { date: dateShort(latest.reviewedAt) }) : t('land.passport.state.reviewed'), state: 'done', stateLabel: t('land.passport.state.reviewed') }

  return [
    deed
      ? { icon: FileText, field: t('land.passport.row.deed'), note: `${deed.fileName}${deed.issuedOn ? ` · ${t('land.passport.note.issued', { date: dateShort(deed.issuedOn) })}` : ''}`, state: 'done', stateLabel: t('land.passport.state.onFile') }
      : { icon: FileText, field: t('land.passport.row.deed'), note: t('land.passport.note.noDeed'), state: 'empty', stateLabel: t('land.passport.state.noneAttached') },
    searchRow,
    reviewRow,
    {
      icon: FileText,
      field: t('land.passport.row.docs'),
      note: parcel.documents.length
        ? t(parcel.documents.length === 1 ? 'land.passport.note.docOne' : 'land.passport.note.docMany', { count: parcel.documents.length })
        : t('land.passport.note.noDocs'),
      state: parcel.documents.length ? 'done' : 'empty',
      stateLabel: String(parcel.documents.length),
    },
    activeAssignments.length
      ? {
          icon: UserCheck,
          field: t('land.passport.row.pros'),
          note: activeAssignments
            .map((a) => `${a.professionalName} (${assignRoleLabel(t, a.role)})`)
            .join(' · '),
          state: 'done',
          stateLabel: String(activeAssignments.length),
        }
      : { icon: UserCheck, field: t('land.passport.row.pros'), note: t('land.passport.note.noPros'), state: 'empty', stateLabel: t('land.passport.state.none') },
  ]
}

export function PropertyPassport({ parcel }: { parcel: ParcelDetail }) {
  const { data } = useMjengo()
  const t = useT()
  const [printing, setPrinting] = useState(false)
  const ladder = buildLadder(parcel, t)
  const projectName = data?.project?.name ?? 'Project'
  const generated = dateShort(new Date())

  // Print flow: mount the print page + its print-only stylesheet, then open
  // the browser print dialog; afterprint (or cancel) tears it down.
  useEffect(() => {
    if (!printing) return
    const done = () => setPrinting(false)
    window.addEventListener('afterprint', done)
    const t = window.setTimeout(() => window.print(), 250)
    const safety = window.setTimeout(() => setPrinting(false), 60_000)
    return () => {
      window.removeEventListener('afterprint', done)
      window.clearTimeout(t)
      window.clearTimeout(safety)
    }
  }, [printing])

  function handlePrint() {
    setPrinting(true)
    toast.info(t('land.passport.printToast'))
  }

  const particulars: [string, string][] = [
    [t('land.passport.particulars.plot'), parcel.plotNumber],
    [t('land.passport.particulars.location'), parcel.town ? `${parcel.town}, ${parcel.county}` : parcel.county],
    [t('land.passport.particulars.area'), parcel.approxArea ?? t('land.particulars.notRecorded')],
    [t('land.passport.particulars.tenure'), parcel.tenureType ?? t('land.particulars.notRecorded')],
    [t('land.passport.particulars.coordinates'), parcel.lat !== null && parcel.lng !== null ? `${parcel.lat.toFixed(4)}, ${parcel.lng.toFixed(4)}` : t('land.particulars.notRecorded')],
    [t('land.passport.particulars.recorded'), dateShort(parcel.createdAt)],
  ]

  return (
    <>
      <Card className="border-stone-300 shadow-sm overflow-hidden">
        <div className="bg-stone-900 px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">{t('land.passport.title')}</p>
            <p className="text-lg font-semibold text-stone-50 truncate">{parcel.plotNumber}</p>
            <p className="text-xs text-stone-300">{parcel.town ? `${parcel.town}, ` : ''}{parcel.county} · {projectName}</p>
          </div>
          <Landmark className="h-7 w-7 shrink-0 text-stone-400" aria-hidden />
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1.5 border-b border-stone-200 bg-stone-50 px-5 py-3 font-mono text-[11px] text-stone-600">
          {particulars.map(([k, v]) => (
            <span key={k} className="whitespace-nowrap">
              <span className="text-stone-400">{k}:</span> {v}
            </span>
          ))}
        </div>

        <CardContent className="p-0">
          <ul className="divide-y divide-stone-100">
            {ladder.map((row) => (
              <li key={row.field} className="flex items-center gap-3 px-5 py-3 min-w-0">
                <row.icon className="h-4 w-4 shrink-0 text-stone-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-stone-800 leading-5">{row.field}</p>
                  <p className="text-xs text-stone-500 truncate leading-5">{row.note}</p>
                </div>
                <Badge className={LADDER_BADGE[row.state].cls} title={t(LADDER_BADGE[row.state].titleKey)}>
                  {row.stateLabel}
                </Badge>
              </li>
            ))}
          </ul>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-stone-100 px-5 py-4">
            <p className="text-xs text-stone-500 max-w-sm leading-relaxed">
              {t('land.passport.footer')}
            </p>
            <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={handlePrint}>
              <Printer className="h-4 w-4" aria-hidden /> {t('land.passport.print')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {printing && (
        <div
          id="mj-passport-print"
          role="dialog"
          aria-label={t('land.passport.printPreviewAria')}
          className="fixed inset-0 z-[60] overflow-y-auto bg-stone-900/70 p-4 print:static print:bg-white print:p-0"
        >
          {/* Print-only stylesheet — mounted ONLY while the print page exists, so a
              regular Ctrl+P elsewhere is never hijacked. */}
          <style>{`
            @media print {
              body * { visibility: hidden !important; }
              #mj-passport-print, #mj-passport-print * { visibility: visible !important; }
              #mj-passport-print { position: fixed !important; inset: 0 !important; overflow: visible !important; background: #fff !important; }
              @page { margin: 14mm; }
            }
          `}</style>

          <div className="mx-auto max-w-[720px] bg-white rounded-xl shadow-2xl print:shadow-none print:rounded-none">
            <div className="flex items-center justify-between border-b border-stone-200 bg-stone-900 px-6 py-4 print:bg-white print:border-b print:border-stone-900">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300 print:text-stone-600">{t('land.passport.printHeader')}</p>
                <p className="text-xl font-bold text-stone-50 print:text-stone-900">{parcel.plotNumber}</p>
                <p className="text-xs text-stone-300 print:text-stone-600">
                  {parcel.town ? `${parcel.town}, ` : ''}{parcel.county} · {projectName}
                </p>
              </div>
              <Landmark className="h-8 w-8 text-stone-400 print:text-stone-900" aria-hidden />
            </div>

            <div className="grid grid-cols-2 gap-x-8 gap-y-2 px-6 py-4 text-[12px] text-stone-700">
              {particulars.map(([k, v]) => (
                <p key={k} className="min-w-0">
                  <span className="text-stone-400">{k}:</span> <span className="break-words">{v}</span>
                </p>
              ))}
            </div>

            <ul className="divide-y divide-stone-100 px-6">
              {ladder.map((row) => (
                <li key={row.field} className="flex items-center gap-3 py-2.5 min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-400 w-36 shrink-0">{row.field}</span>
                  <span className="text-xs text-stone-700 flex-1 min-w-0 break-words">{row.note}</span>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wide shrink-0 ${
                      row.state === 'done' ? 'text-emerald-700' : row.state === 'bad' ? 'text-rose-700' : row.state === 'warn' ? 'text-amber-700' : 'text-stone-500'
                    }`}
                  >
                    {row.stateLabel}
                  </span>
                </li>
              ))}
            </ul>

            <p className="px-6 py-4 text-[11px] leading-relaxed text-stone-600 border-t border-stone-100">
              {t('land.passport.printFooter', {
                generated,
                status: parcel.status === 'verified'
                  ? t('land.passport.stateNote.verified')
                  : parcel.status === 'flagged'
                    ? t('land.passport.stateNote.flagged')
                    : t('land.passport.stateNote.searching'),
              })}
            </p>

            <div className="flex justify-end px-6 pb-5 print:hidden">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setPrinting(false)}>
                <X className="h-4 w-4" aria-hidden /> {t('land.passport.cancelPrint')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
