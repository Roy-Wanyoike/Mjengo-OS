'use client'

// Land & Property — the Property Passport: one printable page summarizing the
// parcel identity + the verification ladder state. It is a MJENGOOS RECORD,
// never a government document — the lands registry remains the authority.

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { FileText, Landmark, Printer, ScanSearch, UserCheck, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useMjengo } from '@/hooks/use-mjengo'
import { dateShort } from '@/lib/format'
import { ASSIGNMENT_ROLE_LABELS, type ParcelDetail } from '@/modules/land/types'

type LadderState = 'done' | 'warn' | 'bad' | 'empty'

const LADDER_BADGE: Record<LadderState, { cls: string; title: string }> = {
  done: { cls: 'border-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100', title: 'On file' },
  warn: { cls: 'border-0 bg-amber-100 text-amber-900 hover:bg-amber-100', title: 'Pending' },
  bad: { cls: 'border-0 bg-rose-100 text-rose-800 hover:bg-rose-100', title: 'Review required' },
  empty: { cls: 'border-0 bg-stone-100 text-stone-600 hover:bg-stone-100', title: 'None' },
}

interface LadderRow {
  icon: LucideIcon
  field: string
  note: string
  state: LadderState
  stateLabel: string
}

function buildLadder(parcel: ParcelDetail): LadderRow[] {
  const deed = parcel.documents.find((d) => d.kind === 'title_deed')
  const latest = parcel.searches[0] // repository orders newest first
  const activeAssignments = parcel.assignments.filter((a) => a.status === 'active')

  const searchRow: LadderRow = !latest
    ? { icon: ScanSearch, field: 'Registry search', note: 'No search requested on record yet', state: 'empty', stateLabel: 'Not requested' }
    : latest.status === 'requested'
      ? { icon: ScanSearch, field: 'Registry search', note: `${latest.searchRef} — awaiting the registry result`, state: 'warn', stateLabel: 'Requested' }
      : latest.transcriptionMatch === 'mismatch'
        ? { icon: ScanSearch, field: 'Registry search', note: `${latest.searchRef} — result differs from the deed transcription`, state: 'bad', stateLabel: 'Mismatch' }
        : { icon: ScanSearch, field: 'Registry search', note: `${latest.searchRef} — result recorded${latest.transcriptionMatch === 'consistent' ? ' and consistent' : ''}`, state: 'done', stateLabel: 'Received' }

  const reviewRow: LadderRow = !latest || latest.status !== 'reviewed'
    ? { icon: UserCheck, field: 'Human review', note: latest?.status === 'received' ? 'Received result awaiting review' : 'Nothing to review yet', state: latest?.status === 'received' ? 'warn' : 'empty', stateLabel: latest?.status === 'received' ? 'Pending' : 'Not yet' }
    : { icon: UserCheck, field: 'Human review', note: latest.reviewedAt ? `Reviewed ${dateShort(latest.reviewedAt)}` : 'Reviewed', state: 'done', stateLabel: 'Reviewed' }

  return [
    deed
      ? { icon: FileText, field: 'Title deed', note: `${deed.fileName}${deed.issuedOn ? ` · issued ${dateShort(deed.issuedOn)}` : ''}`, state: 'done', stateLabel: 'On file' }
      : { icon: FileText, field: 'Title deed', note: 'No title-deed transcription attached yet', state: 'empty', stateLabel: 'None attached' },
    searchRow,
    reviewRow,
    {
      icon: FileText,
      field: 'Documents on file',
      note: parcel.documents.length
        ? `${parcel.documents.length} document${parcel.documents.length === 1 ? '' : 's'} attached to the parcel`
        : 'No documents attached yet',
      state: parcel.documents.length ? 'done' : 'empty',
      stateLabel: String(parcel.documents.length),
    },
    activeAssignments.length
      ? {
          icon: UserCheck,
          field: 'Professionals assigned',
          note: activeAssignments
            .map((a) => `${a.professionalName} (${ASSIGNMENT_ROLE_LABELS[a.role] ?? a.role})`)
            .join(' · '),
          state: 'done',
          stateLabel: String(activeAssignments.length),
        }
      : { icon: UserCheck, field: 'Professionals assigned', note: 'No surveyor/advocate assignment recorded', state: 'empty', stateLabel: 'None' },
  ]
}

export function PropertyPassport({ parcel }: { parcel: ParcelDetail }) {
  const { data } = useMjengo()
  const [printing, setPrinting] = useState(false)
  const ladder = buildLadder(parcel)
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
    toast.info('Preparing the Property Passport for print — MjengoOS record, not a government document')
  }

  const particulars: [string, string][] = [
    ['Plot', parcel.plotNumber],
    ['Location', parcel.town ? `${parcel.town}, ${parcel.county}` : parcel.county],
    ['Approx. area', parcel.approxArea ?? 'Not recorded'],
    ['Tenure', parcel.tenureType ?? 'Not recorded'],
    ['Coordinates', parcel.lat !== null && parcel.lng !== null ? `${parcel.lat.toFixed(4)}, ${parcel.lng.toFixed(4)}` : 'Not recorded'],
    ['Recorded', dateShort(parcel.createdAt)],
  ]

  return (
    <>
      <Card className="border-stone-300 shadow-sm overflow-hidden">
        <div className="bg-stone-900 px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">Property passport</p>
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
                <Badge className={LADDER_BADGE[row.state].cls} title={LADDER_BADGE[row.state].title}>
                  {row.stateLabel}
                </Badge>
              </li>
            ))}
          </ul>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-stone-100 px-5 py-4">
            <p className="text-xs text-stone-500 max-w-sm leading-relaxed">
              MjengoOS record — <span className="font-medium text-stone-700">not a government document</span>. The lands
              registry remains the authority on ownership; advocate review remains the legal step.
            </p>
            <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={handlePrint}>
              <Printer className="h-4 w-4" aria-hidden /> Print passport
            </Button>
          </div>
        </CardContent>
      </Card>

      {printing && (
        <div
          id="mj-passport-print"
          role="dialog"
          aria-label="Property Passport print preview"
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
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300 print:text-stone-600">MjengoOS · Property passport</p>
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
              MjengoOS record — <strong>not a government document</strong>. Searches and documents are recorded, not
              confirmed: official results are obtained by people and attached here. The lands registry remains the
              authority on ownership; the advocate&apos;s review remains the legal step. Generated {generated} ·{' '}
              {parcel.status === 'verified'
                ? 'Record state: documents + reviewed registry search agree.'
                : parcel.status === 'flagged'
                  ? 'Record state: flagged for human review (anomaly, not accusation).'
                  : 'Record state: verification in progress.'}
            </p>

            <div className="flex justify-end px-6 pb-5 print:hidden">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setPrinting(false)}>
                <X className="h-4 w-4" aria-hidden /> Cancel print
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
