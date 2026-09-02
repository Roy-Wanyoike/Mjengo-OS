'use client'

// Price intelligence section — regional price bands + ~30d trends per
// material+region with inline SVG sparklines, plus the manual "Record price"
// form (dispatches price.record). Sources: platform price history + manual
// entries — nothing is scraped or guessed.

import { useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Button } from '@/frontend/ui/button'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { TrendingUp, Plus, MapPin, Boxes } from 'lucide-react'
import { toast } from 'sonner'
import { formatKES } from '@/frontend/lib/format'
import { DeltaChip, Sparkline } from '@/frontend/mjengo/intel/bits'

const SOURCE_LABELS: Record<string, string> = { seed: 'platform history', manual: 'manual entry', order: 'order-derived' }

export function PricesSection() {
  const { data, dispatch, actionBusy, viewMode } = useMjengo()
  const trends = data?.intel.priceTrends ?? []
  const isClient = viewMode === 'client'

  const materials = useMemo(() => Array.from(new Set(trends.map((t) => t.materialName))).sort(), [trends])
  const regions = useMemo(() => Array.from(new Set(trends.map((t) => t.region))).sort(), [trends])

  const [material, setMaterial] = useState('')
  const [region, setRegion] = useState('')
  const [price, setPrice] = useState('')

  const byMaterial = useMemo(() => {
    const map = new Map<string, typeof trends>()
    for (const row of trends) {
      const arr = map.get(row.materialName) ?? []
      arr.push(row)
      map.set(row.materialName, arr)
    }
    return Array.from(map.entries())
  }, [trends])

  if (!data) return null

  async function recordPrice() {
    const unitPrice = Number(price)
    // The selects fall back to the first tracked material/region when the
    // state is untouched — submit the value the user SEES, not the empty state.
    const materialName = material || materials[0]
    const regionName = region || regions[0]
    if (!materialName || !regionName) {
      toast.error('Pick a material and a region first')
      return
    }
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      toast.error('Price must be a number greater than zero (KES)')
      return
    }
    const ok = await dispatch('price.record', { materialName, region: regionName, unitPrice }, `Record ${materialName} price — ${regionName}`)
    if (ok) {
      setPrice('')
      toast.success(`Price recorded: ${materialName} in ${regionName} at ${formatKES(unitPrice)}`)
    }
  }

  return (
    <section aria-label="Price intelligence">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="w-4 h-4 text-stone-500" aria-hidden /> Price intelligence
          </CardTitle>
          <CardDescription>
            Regional price bands and ~30-day trends per material. From platform transactions + manual entries — every
            row is a recorded observation, not a forecast.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0 space-y-5">
          {byMaterial.length === 0 ? (
            <p className="text-sm text-stone-500 py-6 text-center" role="status">
              No price points recorded yet — record the first observation below.
            </p>
          ) : (
            byMaterial.map(([materialName, rows]) => (
              <div key={materialName}>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-stone-800 mb-2">
                  <Boxes className="w-4 h-4 text-stone-400" aria-hidden /> {materialName}
                </h3>
                <ul className="rounded-lg border border-stone-200 divide-y divide-stone-100" aria-label={`${materialName} prices by region`}>
                  {rows.map((row) => (
                    <li key={row.region} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3.5 py-2.5 bg-white">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-stone-700 min-w-24">
                        <MapPin className="w-3.5 h-3.5 text-stone-400" aria-hidden /> {row.region}
                      </span>
                      <span className="text-sm font-bold tabular-nums text-stone-900">{formatKES(row.current)}</span>
                      <DeltaChip deltaPct={row.deltaPct} />
                      <Sparkline points={row.points.map((p) => p.price)} />
                      <span className="ml-auto text-[11px] text-stone-400">
                        {row.previous !== null && <>from {formatKES(row.previous)} · </>}
                        {SOURCE_LABELS[row.source] ?? row.source} · {formatDistanceToNow(new Date(row.lastRecordedAt), { addSuffix: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}

          {/* Manual price observation */}
          <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-4">
            <p className="text-sm font-semibold text-stone-800 mb-1">Record a price</p>
            <p className="text-xs text-stone-500 mb-3">
              Add a manual observation for any tracked material+region. Big jumps (&gt;5% over ~30 days) raise a price alert.
            </p>
            {isClient ? (
              <p className="text-xs text-stone-400">Read-only client view — the site team records prices.</p>
            ) : materials.length === 0 || regions.length === 0 ? (
              <p className="text-xs text-stone-400">No tracked materials yet — order-derived points will appear here.</p>
            ) : (
              <form
                className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2.5 items-end"
                onSubmit={(e) => {
                  e.preventDefault()
                  void recordPrice()
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor="price-material" className="text-xs text-stone-600">Material</Label>
                  <Select value={material || materials[0]} onValueChange={(v) => setMaterial(v)}>
                    <SelectTrigger id="price-material" className="bg-white min-h-11" aria-label="Material">
                      <SelectValue placeholder="Material" />
                    </SelectTrigger>
                    <SelectContent>
                      {materials.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="price-region" className="text-xs text-stone-600">Region</Label>
                  <Select value={region || regions[0]} onValueChange={(v) => setRegion(v)}>
                    <SelectTrigger id="price-region" className="bg-white min-h-11" aria-label="Region">
                      <SelectValue placeholder="Region" />
                    </SelectTrigger>
                    <SelectContent>
                      {regions.map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="price-value" className="text-xs text-stone-600">Unit price (KSh)</Label>
                  <Input
                    id="price-value"
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    placeholder="754"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="bg-white min-h-11 w-28"
                    required
                  />
                </div>
                <Button type="submit" size="sm" className="gap-1.5 min-h-11" disabled={actionBusy !== null}>
                  <Plus className="w-4 h-4" aria-hidden /> Record
                </Button>
              </form>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
