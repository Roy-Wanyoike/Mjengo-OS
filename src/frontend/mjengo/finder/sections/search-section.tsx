'use client'

// Finder search section (agent 2-c) — "Find Materials Near This Site"
// (Finder spec §3/§6): material + qty + radius + delivery day → the landed-cost
// comparison table with weighted ranking.
//
// The ranking is computed with the SAME pure function the server runs for the
// registered `supply.compare` action (modules/supply/compare.ts) — one
// algorithm, no drift. The site coordinates come from the first parcel with
// coords (data.land.parcels, createdAt order — same as the server); no parcel
// → Nairobi default. On the owner surface each explicit search is ALSO
// dispatched so it lands in the Bias-Free Ledger (2-d's threeWayCheck
// pattern); the client surface reads only (its dispatches are blocked
// upstream by the client-actions allowlist). Search inputs live in the
// finder-link store so the dashboard's "Find remaining" can prefill them
// without prop syncing.

import { useMemo, useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Input } from '@/frontend/ui/input'
import { Label } from '@/frontend/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/frontend/ui/select'
import { Loader2, MapPin, PackageSearch, Search } from 'lucide-react'
import { toast } from 'sonner'
import { compareSuppliers } from '@/backend/modules/supply/compare'
import type { CompareRow, CompareSite } from '@/backend/modules/supply/types'
import { useFinderLink } from './requests/finder-link'
import { SearchResultsTable } from './search/results-table'
import { SupplierDirectory } from './search/supplier-directory'
import { RADIUS_OPTIONS, DELIVERY_DAY_OPTIONS, formatKes } from './search/bits'
import { MapView } from '@/frontend/mjengo/map-view'

export function SearchSection() {
  const { data, dispatch, viewMode, actionBusy, online, outbox } = useMjengo()
  const { material, qty, radius, day, setMaterial, setQty, setRadius, setDay, openRequestDialog } = useFinderLink()
  const busy = actionBusy !== null
  const isSiteTeam = viewMode === 'owner'

  const [rows, setRows] = useState<CompareRow[] | null>(null)
  const [searching, setSearching] = useState(false)

  const suppliers = data?.supply.suppliers ?? []
  const pricePoints = data?.intel.pricePoints ?? []

  // Price history for the searched material (spec §30): intel PricePoints
  // matching the query either way (name contains query or query contains name).
  const priceHistory = useMemo(() => {
    const q = material.trim().toLowerCase()
    if (!q) return []
    return pricePoints
      .filter((p) => {
        const n = p.materialName.toLowerCase()
        return n.includes(q) || q.includes(n)
      })
      .map((p) => ({ unitPrice: p.unitPrice, region: p.region, recordedAt: p.recordedAt }))
      .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime())
  }, [pricePoints, material])

  // Datalist of catalog names (unique) for quick picking
  const catalogNames = useMemo(() => {
    const names = new Set<string>()
    for (const s of suppliers) for (const item of s.catalogItems) names.add(item.name)
    return [...names].sort()
  }, [suppliers])

  // Site: first parcel with coords (createdAt order — matches the server)
  const site: CompareSite = useMemo(() => {
    const parcels = [...(data?.land.parcels ?? [])].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    const withCoords = parcels.find((p) => p.lat !== null && p.lng !== null)
    if (withCoords) {
      return {
        lat: withCoords.lat as number,
        lng: withCoords.lng as number,
        label: `Site — ${withCoords.plotNumber}${withCoords.town ? `, ${withCoords.town}` : ''}`,
      }
    }
    return { lat: -1.2921, lng: 36.8219, label: 'Nairobi (default — no parcel coords yet)' }
  }, [data?.land.parcels])

  if (!data) return null

  async function runSearch() {
    const query = material.trim()
    const n = Number(qty)
    if (!query) { toast.error('Type a material to find — e.g. cement, ballast, roofing sheet'); return }
    if (!Number.isFinite(n) || n <= 0) { toast.error('Quantity must be a number greater than zero'); return }

    // Local compute first (instant, offline-safe) — same pure function as the server
    const result = compareSuppliers(
      { materialName: query, qty: n, radiusKm: radius && radius !== 'any' ? Number(radius) : null, deliveryDay: day as never },
      suppliers,
      site,
    )
    setRows(result.rows)

    // Owner surface: audit the run through the registered action (2-d's
    // threeWayCheck pattern — explicit runs land in the Bias-Free Ledger).
    if (isSiteTeam) {
      setSearching(true)
      const ok = await dispatch('supply.compare', {
        materialName: query, qty: n,
        radiusKm: radius && radius !== 'any' ? Number(radius) : undefined,
        deliveryDay: day,
      }, `Finder search: ${query} × ${n}`)
      setSearching(false)
      if (!ok) {
        // The table above is still shown (local compute) — the audit entry just failed
        toast.info('Comparison shown from local data — the audit entry could not be recorded')
      } else if (!online) {
        toast.info(`Comparison shown from local data — search queued (${outbox.length})`)
      }
    }

    if (!result.rows.length) {
      toast.info('No suppliers match this material near the site — widen the radius or try a shorter name')
    }
  }

  function addToOrder(row: CompareRow) {
    openRequestDialog([{ materialName: row.itemName, unit: row.unit, qty: row.qty }])
    toast.info(`${row.itemName} added to a new purchase request — finish the lines in the dialog`)
  }

  return (
    <section aria-label="Find materials near this site" className="space-y-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg text-stone-900">
            <PackageSearch className="h-5 w-5 text-amber-600" aria-hidden /> Find Materials Near This Site
          </CardTitle>
          <CardDescription>
            Total landed cost per supplier — product + delivery + transport — ranked on price, distance, stock,
            delivery speed and reliability. <span className="font-medium text-stone-700">Best overall</span> is not
            always the cheapest unit price.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* search inputs (mobile-first stack, sm: grid) */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
              <Label htmlFor="finder-material">Material</Label>
              <Input
                id="finder-material"
                list="finder-catalog-names"
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
                placeholder="e.g. Cement 50kg"
                autoComplete="off"
              />
              <datalist id="finder-catalog-names">
                {catalogNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="finder-qty">Quantity</Label>
              <Input
                id="finder-qty"
                type="number"
                inputMode="decimal"
                min={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="finder-radius">Radius</Label>
              <Select value={radius} onValueChange={setRadius}>
                <SelectTrigger id="finder-radius" aria-label="Search radius"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RADIUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="finder-day">Delivery day</Label>
              <Select value={day} onValueChange={setDay}>
                <SelectTrigger id="finder-day" aria-label="Delivery day"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DELIVERY_DAY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="min-h-11 gap-2 bg-amber-600 text-white hover:bg-amber-700"
              disabled={busy || searching}
              onClick={() => void runSearch()}
              aria-label="Find suppliers near this site"
            >
              {searching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />}
              Find suppliers
            </Button>
            <Badge variant="outline" className="gap-1 font-normal text-stone-500">
              <MapPin className="h-3 w-3" aria-hidden /> {site.label}
            </Badge>
          </div>

          {/* results */}
          {rows !== null ? (
            <div className="space-y-3">
              <p className="text-xs text-stone-500" aria-live="polite">
                {rows.length
                  ? `${rows.length} supplier${rows.length === 1 ? '' : 's'} · ranked by weighted score (price 0.45 · distance 0.15 · stock 0.15 · speed 0.10 · reliability 0.15)`
                  : 'No matches — widen the search'}
                {rows.length > 0 && ` · cheapest unit ${formatKes(Math.min(...rows.map((r) => r.unitPrice)))}`}
              </p>
              <SearchResultsTable rows={rows} siteLabel={site.label} busy={busy} onAddToOrder={addToOrder} priceHistory={priceHistory} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-stone-300 p-6 text-center">
              <p className="text-sm text-stone-600">
                Type a material and quantity, then <span className="font-medium">Find suppliers</span> — results rank
                every supplier by total landed cost at this site.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-3">
                {['Cement 50kg (32.5N)', 'Steel bar Y12 (12m length)', 'Ballast (screened)', 'River sand'].map((name) => (
                  <button
                    key={name}
                    className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-600 transition hover:border-amber-300 hover:text-amber-800"
                    onClick={() => setMaterial(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <SupplierDirectory canManage={isSiteTeam} />

      {/* Schematic supplier & parcel map (spec §51) — real recorded coordinates */}
      <MapView suppliers={suppliers} parcels={data.land.parcels} />
    </section>
  )
}
