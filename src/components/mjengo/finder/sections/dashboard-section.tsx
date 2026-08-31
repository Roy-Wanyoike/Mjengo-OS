'use client'

// Finder procurement dashboard (agent 2-c — Finder spec §18/§20): money tiles
// (Required / Purchased / Committed / Remaining), status tiles (pending
// requests, pending approvals, orders in transit, discrepancies), the
// BOQ-lite per-material table with "Find suppliers for the remaining"
// prefill into the search, the approval-rules settings card (§11) and the
// cement price-alert chip (read-only intel surface). All numbers are computed
// with the pure insights module the server shares — no drift.

import { useMemo } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertTriangle, ClipboardList, Hourglass, Landmark, LayoutDashboard, Lock, PackageSearch, ShoppingCart, Truck, Warehouse,
} from 'lucide-react'
import { boqRows, procurementTotals } from '@/modules/supply/insights'
import { useFinderLink } from './requests/finder-link'
import { fmtQty, formatKes } from './requests/bits'
import { PriceAlertChip } from './dashboard/price-alert-chip'
import { RulesCard } from './dashboard/rules-card'

export function DashboardSection() {
  const { data, viewMode } = useMjengo()
  const { setSearchPrefill } = useFinderLink()
  const isSiteTeam = viewMode === 'owner'

  const requests = data?.supply.requests ?? []
  const orders = data?.supply.orders ?? []
  const approvals = data?.supply.approvals ?? []
  const suppliers = data?.supply.suppliers ?? []

  const totals = useMemo(
    () =>
      procurementTotals(
        requests.map((r) => ({
          status: r.status,
          lines: r.lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })),
          quotes: r.quotes.map((q) => ({ status: q.status, totalLanded: q.totalLanded })),
        })),
        orders.map((o) => ({
          status: o.status,
          total: o.total,
          lines: o.lines.map((l) => ({ id: l.id, name: l.name, unit: l.unit, qty: l.qty })),
          deliveries: o.deliveries.map((d) => ({
            status: d.status,
            lines: d.lines.map((dl) => ({ orderLineId: dl.orderLineId, qtyReceived: dl.qtyReceived })),
          })),
        })),
        approvals.map((a) => ({ decision: a.decision })),
        suppliers.map((s) => ({ catalogItems: s.catalogItems })),
      ),
    [requests, orders, approvals, suppliers],
  )

  const boq = useMemo(() => boqRows(
    requests.map((r) => ({
      status: r.status,
      lines: r.lines.map((l) => ({ materialName: l.materialName, unit: l.unit, qty: l.qty })),
      quotes: r.quotes.map((q) => ({ status: q.status, totalLanded: q.totalLanded })),
    })),
    orders.map((o) => ({
      status: o.status,
      total: o.total,
      lines: o.lines.map((l) => ({ id: l.id, name: l.name, unit: l.unit, qty: l.qty })),
      deliveries: o.deliveries.map((d) => ({
        status: d.status,
        lines: d.lines.map((dl) => ({ orderLineId: dl.orderLineId, qtyReceived: dl.qtyReceived })),
      })),
    })),
  ), [requests, orders])

  if (!data) return null

  const moneyTiles: Array<{ label: string; value: number; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; hint: string; tone: string }> = [
    {
      label: 'Required (est.)',
      value: totals.required,
      icon: ClipboardList,
      hint: 'Submitted + approved + converted requests, estimated from best quotes or catalog averages',
      tone: 'text-stone-900',
    },
    {
      label: 'Purchased',
      value: totals.purchased,
      icon: ShoppingCart,
      hint: 'Delivered + closed purchase orders — money already committed to suppliers',
      tone: 'text-emerald-700',
    },
    {
      label: 'Committed (in flight)',
      value: totals.committed,
      icon: Truck,
      hint: 'Sent + confirmed + in-transit orders — committed but not yet delivered',
      tone: 'text-amber-700',
    },
    {
      label: 'Remaining',
      value: totals.remaining,
      icon: Warehouse,
      hint: 'Required − purchased — what still needs sourcing',
      tone: 'text-stone-900',
    },
  ]

  const statusTiles: Array<{ label: string; value: number; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; hint: string; warn: boolean }> = [
    { label: 'Pending requests', value: totals.pendingRequests, icon: Hourglass, hint: 'Submitted, awaiting approval decisions', warn: false },
    { label: 'Pending approvals', value: totals.pendingApprovals, icon: Lock, hint: 'Approval rows still PENDING across the project', warn: false },
    { label: 'Orders in transit', value: totals.ordersInTransit, icon: Truck, hint: 'Dispatched trucks awaiting ground-truth receipt', warn: false },
    { label: 'Discrepancies', value: totals.discrepancies, icon: AlertTriangle, hint: 'Deliveries with short counts — flagged for review, never accusations', warn: true },
  ]

  return (
    <section aria-label="Procurement dashboard" className="space-y-6">
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-lg text-stone-900">
            <LayoutDashboard className="h-5 w-5 text-amber-600" aria-hidden /> Procurement
            <PriceAlertChip pricePoints={data.intel.pricePoints} />
          </CardTitle>
          <CardDescription>
            Required vs purchased vs committed across every request and order on this project — the BOQ-lite view
            (spec §18/§20). Estimates come from the same engine the approval rules use.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* money tiles */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {moneyTiles.map((tile) => {
              const Icon = tile.icon
              return (
                <Card key={tile.label} className="border-stone-200 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription className="flex items-center gap-1.5 text-xs">
                      <Icon className="h-3.5 w-3.5" aria-hidden /> {tile.label}
                    </CardDescription>
                    <CardTitle className={`text-2xl font-bold tabular-nums ${tile.tone}`}>{formatKes(tile.value)}</CardTitle>
                  </CardHeader>
                  <CardContent><p className="text-xs leading-relaxed text-stone-500">{tile.hint}</p></CardContent>
                </Card>
              )
            })}
          </div>

          {/* status tiles */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {statusTiles.map((tile) => {
              const Icon = tile.icon
              return (
                <div key={tile.label} className={`rounded-lg border p-3 ${tile.warn && tile.value > 0 ? 'border-orange-200 bg-orange-50/70' : 'border-stone-200 bg-stone-50/60'}`}>
                  <p className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide ${tile.warn && tile.value > 0 ? 'text-orange-800' : 'text-stone-500'}`}>
                    <Icon className="h-3.5 w-3.5" aria-hidden /> {tile.label}
                  </p>
                  <p className={`pt-1 text-xl font-bold tabular-nums ${tile.warn && tile.value > 0 ? 'text-orange-900' : 'text-stone-900'}`}>{tile.value}</p>
                  <p className="pt-0.5 text-[10px] leading-snug text-stone-500">{tile.hint}</p>
                </div>
              )
            })}
          </div>

          {/* BOQ-lite table */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-stone-800">
                Materials — required vs purchased (BOQ-lite)
              </h3>
              <p className="text-[11px] text-stone-500">Required counts requests in submitted/approved/converted; purchased counts verified delivery lines.</p>
            </div>
            {boq.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-xs text-stone-500">
                No material requirements yet — submit a purchase request and the plan-vs-purchase table builds here.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-stone-200">
                <table className="w-full min-w-[640px] text-sm">
                  <caption className="sr-only">Per-material required versus purchased quantities</caption>
                  <thead>
                    <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                      <th scope="col" className="px-3 py-2 font-medium">Material</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Required</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Purchased</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Remaining</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Sourcing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {boq.map((row) => (
                      <tr key={row.materialKey} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                        <td className="px-3 py-2.5">
                          <span className="font-medium text-stone-800">{row.displayNames[0]}</span>
                          {row.displayNames.length > 1 && (
                            <Badge variant="outline" className="ml-1.5 text-[10px] font-normal text-stone-400" title={`Grouped variants: ${row.displayNames.join(' · ')}`}>
                              +{row.displayNames.length - 1} variant{row.displayNames.length > 2 ? 's' : ''}
                            </Badge>
                          )}
                          <span className="block text-[10px] text-stone-400">per {row.unit}</span>
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-stone-700">{fmtQty(row.required)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-stone-700">{fmtQty(row.purchased)}</td>
                        <td className="px-2 py-2.5 text-right font-semibold tabular-nums text-stone-900">{fmtQty(row.remaining)}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right">
                          {row.remaining > 0 ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 min-h-8 gap-1 px-2 text-xs"
                              onClick={() => setSearchPrefill({ materialName: row.displayNames[0], qty: row.remaining })}
                              aria-label={`Find suppliers for the remaining ${fmtQty(row.remaining)} ${row.unit} of ${row.displayNames[0]}`}
                            >
                              <PackageSearch className="h-3.5 w-3.5" aria-hidden /> Find remaining
                            </Button>
                          ) : (
                            <span className="text-[11px] text-emerald-700">fully sourced</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <RulesCard canManage={isSiteTeam} />

      <p className="flex items-center gap-1.5 text-[11px] text-stone-400">
        <Landmark className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Payment flows through the invoices section (below) and the Transaction ledger — requests and orders never move money directly.
      </p>
    </section>
  )
}
