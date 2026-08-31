'use client'

// Professionals — directory card. Honest by construction: the licence chip
// names the body that ISSUES the licence (EBK/LSK/BORAQS), the ladder counts
// checks recorded INSIDE MjengoOS, and the latest finding is shown verbatim —
// including unfavourable ones ("licence expired — renewal pending").

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Building2,
  Calculator,
  ClipboardCheck,
  Compass,
  DraftingCompass,
  HardHat,
  MapPin,
  Phone,
  Scale,
  UserPlus,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { dateShort } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  CATEGORY_LABELS,
  CHECK_METHOD_LABELS,
  type CheckMethod,
  type ProfessionalCategory,
  type ProfessionalWithChecks,
} from '@/modules/professionals/types'
import { VerificationLadder } from './verification-ladder'

const CATEGORY_ICONS: Record<ProfessionalCategory, LucideIcon> = {
  surveyor: DraftingCompass,
  advocate: Scale,
  engineer: Wrench,
  qty_surveyor: Calculator,
  architect: Building2,
  contractor: HardHat,
}

function MethodBadge({ method }: { method: string }) {
  const label = CHECK_METHOD_LABELS[method as CheckMethod] ?? method
  return (
    <Badge variant="outline" className="text-[10px] font-normal text-stone-600 gap-1">
      <ClipboardCheck className="w-3 h-3" aria-hidden /> {label}
    </Badge>
  )
}

export function ProfessionalCard({
  professional,
  canEdit,
  onRecordCheck,
  onAssign,
}: {
  professional: ProfessionalWithChecks
  canEdit: boolean
  onRecordCheck: (p: ProfessionalWithChecks) => void
  onAssign: (p: ProfessionalWithChecks) => void
}) {
  const [showAllChecks, setShowAllChecks] = useState(false)
  const Icon = CATEGORY_ICONS[professional.category as ProfessionalCategory] ?? Compass
  const checks = professional.credentialChecks
  const latest = checks[0]
  const earlier = checks.slice(1)

  return (
    <Card className="border-stone-200 shadow-sm min-w-0">
      <CardContent className="p-4 sm:p-5 space-y-3.5">
        {/* header */}
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-stone-100 flex items-center justify-center shrink-0" aria-hidden>
            <Icon className="w-5 h-5 text-stone-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-stone-900 leading-tight truncate">{professional.name}</h3>
            {professional.organisation && (
              <p className="text-xs text-stone-500 truncate">{professional.organisation}</p>
            )}
            <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px] text-stone-500">
              <Badge variant="outline" className="text-[10px] font-medium text-stone-600 border-stone-300">
                {CATEGORY_LABELS[professional.category as ProfessionalCategory] ?? professional.category}
              </Badge>
              {professional.county && (
                <span className="inline-flex items-center gap-0.5">
                  <MapPin className="w-3 h-3" aria-hidden /> {professional.county}
                </span>
              )}
              {professional.phone && (
                <a
                  href={`tel:${professional.phone.replace(/\s+/g, '')}`}
                  className="inline-flex items-center gap-0.5 hover:text-stone-800 underline-offset-2 hover:underline"
                >
                  <Phone className="w-3 h-3" aria-hidden /> {professional.phone}
                </a>
              )}
            </div>
          </div>
        </div>

        {/* licence chip — the body named is the ISSUER, never MjengoOS */}
        {professional.licenceNumber || (professional.licenceBody && professional.licenceBody !== 'other') ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge className="bg-stone-800 text-white border-0 font-mono text-[11px] tracking-tight hover:bg-stone-800">
              {professional.licenceBody ?? 'OTHER'} · {professional.licenceNumber ?? 'no number on file'}
            </Badge>
          </div>
        ) : (
          <p className="text-[11px] text-stone-400">No licence number recorded</p>
        )}

        {/* the honest ladder */}
        <VerificationLadder state={professional.verificationState} checkCount={checks.length} />

        {/* reliability + assignment count */}
        <div className="flex items-center justify-between gap-3 text-[11px] text-stone-500">
          <span className="min-w-0">
            Reliability{' '}
            <span className="font-semibold text-stone-700 tabular-nums">{professional.reliabilityScore ?? 50}/100</span>
            <span className="text-stone-400"> · platform history</span>
          </span>
          {professional.assignmentCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-stone-600 shrink-0">
              {professional.assignmentCount} parcel assignment{professional.assignmentCount === 1 ? '' : 's'}
            </Badge>
          )}
        </div>
        <div className="h-1 rounded-full bg-stone-100 overflow-hidden" aria-hidden>
          <div
            className={cn(
              'h-full rounded-full',
              (professional.reliabilityScore ?? 50) >= 75 ? 'bg-amber-600' : 'bg-amber-400',
            )}
            style={{ width: `${Math.min(100, Math.max(0, professional.reliabilityScore ?? 50))}%` }}
          />
        </div>

        {/* latest recorded check — verbatim, including unfavourable findings */}
        {latest ? (
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <MethodBadge method={latest.method} />
              <span className="text-[10px] text-stone-500">
                by {latest.checkedBy} · {dateShort(latest.recordedAt)}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-stone-600 leading-relaxed line-clamp-3">{latest.finding}</p>
            {earlier.length > 0 && (
              <Collapsible open={showAllChecks} onOpenChange={setShowAllChecks}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="mt-2 text-[11px] font-medium text-stone-600 hover:text-stone-900 underline underline-offset-2"
                  >
                    {showAllChecks ? 'Hide' : `Show all ${checks.length} recorded checks`}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="mt-2 space-y-2 border-t border-stone-200 pt-2">
                    {earlier.map((c) => (
                      <li key={c.id} className="text-xs text-stone-600 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <MethodBadge method={c.method} />
                          <span className="text-[10px] text-stone-500">
                            by {c.checkedBy} · {dateShort(c.recordedAt)}
                          </span>
                        </div>
                        <p className="mt-1 leading-relaxed line-clamp-3">{c.finding}</p>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-stone-400 border border-dashed border-stone-200 rounded-lg p-2.5 leading-relaxed">
            No credential checks recorded yet — level 0 · Unverified.
          </p>
        )}

        {/* notes */}
        {professional.notes && (
          <p className="text-[11px] text-stone-500 leading-relaxed line-clamp-2">{professional.notes}</p>
        )}

        {/* actions — min-w-0 lets the pair shrink inside a 390px viewport
            (flex items refuse to shrink below content width by default, which
            pushed the Land tab to 407px; the spans truncate instead) */}
        {canEdit && (
          <div className="flex gap-2 pt-0.5 min-w-0">
            <Button
              size="sm"
              className="gap-1.5 flex-1 h-9 min-w-0 bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => onRecordCheck(professional)}
            >
              <ClipboardCheck className="w-4 h-4 shrink-0" aria-hidden />
              <span className="truncate">Record credential check</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 flex-1 h-9 min-w-0"
              onClick={() => onAssign(professional)}
            >
              <UserPlus className="w-4 h-4 shrink-0" aria-hidden />
              <span className="truncate">Assign to parcel</span>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
