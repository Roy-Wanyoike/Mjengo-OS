'use client'

// One purchase order the supplier owns (W5-3): lines, totals, the lifecycle
// actions that are THEIRS (order.confirm on SENT — availability/delivery/
// charge; order.dispatch on CONFIRMED — the truck leaves, writing the SAME
// OrderDelivery record the buyer path writes), and the delivery records with
// per-line ground truth + evidence photos. Markup mirrors
// finder/sections/requests/order-card.tsx; the data + actions are
// supplier-scoped (the server re-pins the order id to our link).

import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { AlertTriangle, Check, Truck, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import { dateShort } from '@/frontend/lib/format'
import { DeliveryStatusBadge, OrderStatusBadge, fmtQty, formatKes } from '@/frontend/mjengo/finder/sections/requests/bits'
import { DeliveryPhotos, LinePhotoThumbs } from '@/frontend/mjengo/finder/sections/requests/delivery-photos'
import type { SupplierOrderRow } from '@/backend/api/supplier'
import type { SupplierDispatch } from './supplier-portal'

export function SupplierOrderCard({
  order, dispatch, busy,
}: { order: SupplierOrderRow; dispatch: SupplierDispatch; busy: boolean }) {
  const t = useT()
  const deliveries = order.deliveries

  async function act(type: 'order.confirm' | 'order.dispatch', payload: Record<string, unknown>, success: string) {
    const ok = await dispatch(type, payload, order.projectId, `${type}: ${order.orderCode}`)
    if (ok) toast.success(success)
    // failures already toasted honestly by the portal dispatch
  }

  return (
    <Card className="shadow-sm border-stone-200">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base text-stone-900">
              <span className="font-mono text-sm font-bold text-stone-800">{order.orderCode}</span>
              <OrderStatusBadge status={order.status} />
              {order.requestCode && (
                <Badge variant="outline" className="text-[10px] font-normal text-stone-500">
                  from {order.requestCode}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {t('supplier.orders.forProject', { project: order.projectName })} ·{' '}
              {t('supplier.orders.placedBy', { role: order.createdByRole, date: dateShort(order.createdAt) })}
            </CardDescription>
          </div>
          {/* The supplier's lifecycle steps — confirm (SENT) then dispatch
              (CONFIRMED). Everything else is the buyer's or the record's. */}
          <div className="flex flex-wrap justify-end gap-1.5">
            {order.status === 'sent' && (
              <Button
                size="sm"
                className="h-9 min-h-9 gap-1 bg-teal-600 text-xs text-white hover:bg-teal-700"
                disabled={busy}
                onClick={() =>
                  void act('order.confirm', { id: order.id }, t('supplier.orders.confirmed'))
                }
                aria-label={`${t('supplier.orders.confirm')} ${order.orderCode}`}
              >
                <Check className="h-3.5 w-3.5" aria-hidden /> {t('supplier.orders.confirm')}
              </Button>
            )}
            {order.status === 'confirmed' && (
              <Button
                size="sm"
                className="h-9 min-h-9 gap-1 bg-amber-600 text-xs text-white hover:bg-amber-700"
                disabled={busy}
                onClick={() =>
                  void act('order.dispatch', { orderId: order.id }, t('supplier.orders.dispatched'))
                }
                aria-label={`${t('supplier.orders.dispatch')} ${order.orderCode}`}
              >
                <Truck className="h-3.5 w-3.5" aria-hidden /> {t('supplier.orders.dispatch')}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto rounded-md border border-stone-200">
          <table className="w-full min-w-[420px] text-sm">
            <caption className="sr-only">Lines for {order.orderCode}</caption>
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                <th scope="col" className="px-3 py-2 font-medium">{t('supplier.catalog.name')}</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Qty</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">{t('supplier.catalog.unit')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('supplier.orders.lineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => {
                const dl = deliveries.flatMap((d) => d.lines).find((x) => x.orderLineId === l.id)
                const short = dl && dl.qtyReceived < l.qty
                return (
                  <tr key={l.id} className={`border-b border-stone-100 last:border-0 ${short ? 'bg-orange-50/60' : ''}`}>
                    <td className="px-3 py-2 text-stone-700">{l.name}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-stone-700">
                      {fmtQty(l.qty)}
                      {dl && <span className="block text-[10px] text-stone-400">received {fmtQty(dl.qtyReceived)}</span>}
                    </td>
                    <td className="px-2 py-2 text-right text-[11px] text-stone-400">{l.unit}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-stone-900">{formatKes(l.lineTotal)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-stone-500">
          {formatKes(order.total)} total · {t('supplier.orders.deliveryFee')} {formatKes(order.deliveryFee)} ·{' '}
          {t('supplier.orders.paymentSource')} {order.paymentSource}
          {order.note ? ` · ${order.note}` : ''}
        </p>

        {/* Delivery records — the ground truth as verified on the ground. */}
        {deliveries.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
              {t('supplier.orders.deliveries')}
            </p>
            {deliveries.map((d) => {
              const shortLines = d.lines.filter((l) => l.qtyReceived < l.qtyOrdered)
              const linePhotoRows = d.lines
                .map((l) => ({
                  lineId: l.id,
                  name: order.lines.find((ol) => ol.id === l.orderLineId)?.name ?? 'line',
                  photos: d.photos.filter((p) => p.deliveryLineId === l.id),
                }))
                .filter((r) => r.photos.length > 0)
              const generalPhotos = d.photos.filter((p) => p.deliveryLineId === null)
              return (
                <div
                  key={d.id}
                  className={`space-y-2 rounded-lg border p-3 ${
                    d.status === 'discrepancy' ? 'border-orange-200 bg-orange-50/60' : 'border-stone-200 bg-stone-50/60'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <DeliveryStatusBadge status={d.status} />
                    <p className="text-[11px] text-stone-500">
                      {t('supplier.orders.dispatchedAt')} {d.dispatchedAt ? dateShort(d.dispatchedAt) : '—'}
                      {d.receivedAt ? ` · ${t('supplier.orders.receivedAt')} ${dateShort(d.receivedAt)}` : ''}
                      {d.receivedBy ? ` · ${t('supplier.orders.receivedBy')} ${d.receivedBy}` : ''}
                    </p>
                  </div>
                  {d.status === 'discrepancy' && shortLines.length > 0 && (
                    <div role="alert" className="rounded-md border border-orange-300 bg-white p-3">
                      <p className="flex items-center gap-1.5 text-sm font-semibold text-orange-900">
                        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                        {t('supplier.orders.short', {
                          ordered: fmtQty(shortLines[0].qtyOrdered),
                          received: fmtQty(shortLines[0].qtyReceived),
                        })}
                      </p>
                      {d.note && <p className="pt-1.5 text-xs italic text-orange-800">{d.note}</p>}
                      {linePhotoRows.map((r) => (
                        <LinePhotoThumbs key={r.lineId} photos={r.photos} lineName={r.name} />
                      ))}
                    </div>
                  )}
                  {d.status === 'received' && d.note && (
                    <p className="text-xs italic text-stone-500">{d.note}</p>
                  )}
                  {d.gpsLat !== null && d.gpsLng !== null && (
                    <p className="flex items-center gap-1 text-[11px] text-stone-500 tabular-nums">
                      <MapPin className="h-3 w-3 text-emerald-600" aria-hidden />
                      GPS {d.gpsLat.toFixed(4)}, {d.gpsLng.toFixed(4)}
                    </p>
                  )}
                  <DeliveryPhotos photos={generalPhotos} />
                  {d.status !== 'discrepancy' && linePhotoRows.map((r) => (
                    <LinePhotoThumbs key={r.lineId} photos={r.photos} lineName={r.name} />
                  ))}
                </div>
              )
            })}
          </div>
        )}

        <p className="text-[11px] text-stone-500">{t('supplier.orders.payNote')}</p>
      </CardContent>
    </Card>
  )
}
