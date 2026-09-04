'use client'

// Land & Property — professionals directory section.
//
// The trusted-directory workflow: filter the global directory (category /
// county / verification level / name), record honest credential checks (who
// checked, how, what they found), and invite professionals onto project
// parcels. Every write goes through the registered PROFESSIONALS_ACTIONS via
// the store's dispatch() — audited + offline-queued like every MjengoOS
// mutation.
//
// HONESTY RULE (module-wide): verificationState counts checks recorded INSIDE
// MjengoOS. LSK / EBK / BORAQS remain the authoritative registries. The
// platform does not issue licences and never claims registry confirmation.

import { useMemo, useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent } from '@/frontend/ui/card'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Search, UserCog, UserPlus, X } from 'lucide-react'
import {
  CATEGORY_LABELS,
  PROFESSIONAL_CATEGORIES,
  VERIFICATION_LADDER,
  type ProfessionalCategory,
  type ProfessionalWithChecks,
} from '@/backend/modules/professionals/types'
import { ProfessionalCard } from './professionals/professional-card'
import { AssignmentsSummary } from './professionals/assignments-summary'
import { AddProfessionalDialog, AssignDialog, RecordCheckDialog } from './professionals/dialogs'

export function ProfessionalsSection() {
  const { data, viewMode } = useMjengo()
  const [category, setCategory] = useState('all')
  const [county, setCounty] = useState('all')
  const [level, setLevel] = useState('all')
  const [search, setSearch] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [checkFor, setCheckFor] = useState<ProfessionalWithChecks | null>(null)
  const [assignFor, setAssignFor] = useState<ProfessionalWithChecks | null>(null)

  const professionals = data?.professionals?.professionals ?? []
  const assignments = data?.professionals?.assignments ?? []
  const parcels = data?.land?.parcels ?? []

  const counties = useMemo(
    () => Array.from(new Set(professionals.map((p) => p.county).filter((c): c is string => !!c))).sort(),
    [professionals],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return professionals.filter((p) => {
      if (category !== 'all' && p.category !== category) return false
      if (county !== 'all' && p.county !== county) return false
      if (level !== 'all' && p.verificationState !== Number(level)) return false
      if (q && !p.name.toLowerCase().includes(q) && !(p.organisation ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [professionals, category, county, level, search])

  if (!data) return null
  const isClient = viewMode === 'client'

  const filtersActive = category !== 'all' || county !== 'all' || level !== 'all' || search.trim() !== ''
  const checksTotal = professionals.reduce((s, p) => s + p.credentialChecks.length, 0)

  function clearFilters() {
    setCategory('all'); setCounty('all'); setLevel('all'); setSearch('')
  }

  return (
    <section aria-label="Professionals directory" className="space-y-4">
      {/* section header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-stone-900 flex items-center gap-2">
            <UserCog className="h-5 w-5 text-stone-500" aria-hidden />
            Professionals directory
          </h2>
          <p className="text-sm text-stone-500 mt-0.5">
            {professionals.length} built-environment professionals
            {checksTotal > 0 && ` · ${checksTotal} credential check${checksTotal === 1 ? '' : 's'} recorded`}
            {' '}— checks are platform records, not registry confirmations
          </p>
        </div>
        {!isClient && (
          <Button size="sm" className="gap-1.5 bg-stone-900 text-white hover:bg-stone-800" onClick={() => setAddOpen(true)}>
            <UserPlus className="h-4 w-4" aria-hidden /> Add professional
          </Button>
        )}
      </div>

      {/* project assignments */}
      <AssignmentsSummary assignments={assignments} canEdit={!isClient} />

      {/* filter bar */}
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="pf-category" className="text-[11px] text-stone-500">Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="pf-category" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {PROFESSIONAL_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="pf-county" className="text-[11px] text-stone-500">County</Label>
              <Select value={county} onValueChange={setCounty}>
                <SelectTrigger id="pf-county" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All counties</SelectItem>
                  {counties.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="pf-level" className="text-[11px] text-stone-500">Verification level</Label>
              <Select value={level} onValueChange={setLevel}>
                <SelectTrigger id="pf-level" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All levels</SelectItem>
                  {VERIFICATION_LADDER.map((r) => (
                    <SelectItem key={r.level} value={String(r.level)}>
                      Level {r.level} · {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 min-w-0 col-span-2 lg:col-span-1">
              <Label htmlFor="pf-search" className="text-[11px] text-stone-500">Search by name</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" aria-hidden />
                <Input
                  id="pf-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="e.g. Wanjiru"
                  className="h-9 pl-8 text-xs"
                />
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="text-xs text-stone-500" aria-live="polite">
              Showing <span className="font-semibold text-stone-700">{filtered.length}</span> of {professionals.length}
            </p>
            {filtersActive && (
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-stone-500" onClick={clearFilters}>
                <X className="w-3 h-3" aria-hidden /> Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* directory grid */}
      {filtered.length ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 min-w-0">
          {filtered.map((p) => (
            <ProfessionalCard
              key={p.id}
              professional={p}
              canEdit={!isClient}
              onRecordCheck={(pro) => setCheckFor(pro)}
              onAssign={(pro) => setAssignFor(pro)}
            />
          ))}
        </div>
      ) : (
        <Card className="border-stone-200 shadow-sm">
          <CardContent className="p-6 min-h-40 flex flex-col items-center justify-center text-center gap-2">
            <div className="w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center" aria-hidden>
              <Search className="w-6 h-6 text-stone-400" />
            </div>
            <h3 className="text-sm font-semibold text-stone-900">
              {professionals.length ? 'No professionals match these filters' : 'The directory is empty'}
            </h3>
            <p className="text-sm text-stone-500 max-w-sm leading-relaxed">
              {professionals.length
                ? 'Try a different category, county, level or name — or clear the filters.'
                : 'Add the surveyors, advocates and engineers you work with. Entries start unverified and earn their record as checks are recorded.'}
            </p>
            {filtersActive && professionals.length > 0 && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={clearFilters}>
                <X className="w-3.5 h-3.5" aria-hidden /> Clear filters
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* honesty note — the whole claim, stated plainly */}
      <Card className="border-stone-300 shadow-sm bg-stone-50" aria-label="What the verification levels actually mean">
        <CardContent className="p-5 sm:p-6">
          <div className="flex items-center gap-2.5 mb-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-200 text-stone-700" aria-hidden>
              <UserCog className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-stone-900">What the verification levels actually mean</h3>
              <p className="text-xs text-stone-500">Platform records, plainly labelled</p>
            </div>
          </div>
          <p className="text-xs text-stone-600 leading-relaxed max-w-3xl">
            Verification levels reflect the checks recorded <span className="font-medium">inside MjengoOS</span> —
            document reviews, reference calls and lookups performed by the people using this platform, with their
            findings kept verbatim. The registries remain the authoritative sources:{' '}
            <span className="font-medium">LSK</span> for advocates, <span className="font-medium">EBK</span> for
            engineers and surveyors, <span className="font-medium">BORAQS</span> for architects and quantity
            surveyors. MjengoOS does not issue licences, confirm registrations, or replace a call to the registry
            before you contract.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="text-[10px] text-stone-600">LSK · advocates</Badge>
            <Badge variant="outline" className="text-[10px] text-stone-600">EBK · engineers &amp; surveyors</Badge>
            <Badge variant="outline" className="text-[10px] text-stone-600">BORAQS · architects &amp; QS</Badge>
          </div>
        </CardContent>
      </Card>

      {/* dialogs (site team only — the client view never opens them) */}
      {checkFor && (
        <RecordCheckDialog
          professional={checkFor}
          open={!!checkFor}
          onOpenChange={(v) => { if (!v) setCheckFor(null) }}
        />
      )}
      {assignFor && (
        <AssignDialog
          professional={assignFor}
          parcels={parcels}
          open={!!assignFor}
          onOpenChange={(v) => { if (!v) setAssignFor(null) }}
        />
      )}
      <AddProfessionalDialog open={addOpen} onOpenChange={setAddOpen} />
    </section>
  )
}
