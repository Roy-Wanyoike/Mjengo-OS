'use client'

// One purchase order card (Finder §12-§13): lines, totals, lifecycle buttons
// Send → Confirm (supplier, simulated) → Dispatch → Receive delivery → Close,
// deliveries with per-line ground truth + EVIDENCE PHOTOS (real Attachment
// links recorded at receive — replayed with the site-photo rendering via
// delivery-photos.tsx), and the DISCREPANCY banner when a short count is on
// record ("flagged for review", never an accusation) with that line's
// evidence photos beside the counts. Confirmed orders hint "Invoice →" — the
// invoices section sits below on this tab and handles the money end.

import { useState } from 'react'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { Badge } from '@/frontend/ui/badge'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/frontend/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/frontend/ui/dialog'
import { Textarea } from '@/frontend/ui/textarea'
import { AlertTriangle, Camera, FileText, MapPin, PackageCheck, ReceiptText, Send, Truck, X } from 'lucide-react'
import { toast } from 'sonner'
import { useT } from '@/frontend/i18n/provider'
import type { ActionType } from '@/backend/lib/mjengo'
import type { OrderWithDetail } from '@/backend/modules/supply/types'
import { dateShort } from '@/frontend/lib/format'
import { DeliveryStatusBadge, OrderStatusBadge, fmtQty, formatKes } from './bits'
import { DeliveryPhotos, LinePhotoThumbs } from './delivery-photos'
import { DeliveryReceiveDialog } from './delivery-receive-dialog'

export function OrderCard({
  order, canManage, onBusy,
}: {
  order: OrderWithDetail
  canManage: boolean
  onBusy?: () => void
}) {
  const { dispatch, online, outbox, actionBusy } = useMjengo()
  const t = useT()
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [reason, setReason] = useState('')
  const busy = actionBusy !== null
  const offlineNote = t('field.savedQueued', { count: outbox.length })

  const deliveries = order.deliveries
  const activeDelivery = deliveries.find((d) => d.status === 'dispatched') ?? deliveries[deliveries.length - 1] ?? null
  const discrepancy = deliveries.find((d) => d.status === 'discrepancy')
  void onBusy

  async function act(type: ActionType, payload: Record<string, unknown>, label: string, success: string) {
    const ok = await dispatch(type, payload, label)
    if (ok) toast.success(online ? success : offlineNote)
    else toast.error(t('finder.po.actFailed'))
  }

  return (
    <Card className={`shadow-sm ${discrepancy ? 'border-orange-300' : 'border-stone-200'}`}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base text-stone-900">
              <span className="font-mono text-sm font-bold text-stone-800">{order.orderCode}</span>
              <OrderStatusBadge status={order.status} />
              {order.requestCode && (
                <Badge variant="outline" className="text-[10px] font-normal text-stone-500">{t('finder.po.from', { code: order.requestCode })}</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {t('finder.po.desc', { supplier: order.supplierName, total: formatKes(order.total), delivery: formatKes(order.deliveryFee), payment: order.paymentSource, role: order.createdByRole, date: dateShort(order.createdAt) })}
            </CardDescription>
          </div>
          {canManage && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {order.status === 'approved' && (
                <Button size="sm" className="h-9 min-h-9 gap-1 bg-sky-600 text-xs text-white hover:bg-sky-700" disabled={busy}
                  onClick={() => void act('order.send', { id: order.id }, t('finder.po.audit.sent', { code: order.orderCode }), t('finder.po.toast.sent', { code: order.orderCode, supplier: order.supplierName }))}
                  aria-label={t('finder.po.sendAria', { code: order.orderCode })}>
                  <Send className="h-3.5 w-3.5" aria-hidden /> {t('finder.po.send')}
                </Button>
              )}
              {order.status === 'sent' && (
                <>
                  <Button size="sm" className="h-9 min-h-9 gap-1 bg-teal-600 text-xs text-white hover:bg-teal-700" disabled={busy}
                    onClick={() => void act('order.confirm', { id: order.id }, t('finder.po.audit.confirmed', { code: order.orderCode }), t('finder.po.toast.confirmed', { code: order.orderCode }))}
                    aria-label={t('finder.po.confirmAria', { code: order.orderCode })}>
                    {t('finder.po.confirm')}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-9 min-h-9 gap-1 text-xs text-stone-500 hover:text-rose-600" disabled={busy}
                    onClick={() => { setCancelOpen(true); setReason('') }}
                    aria-label={t('finder.po.cancelAria', { code: order.orderCode })}>
                    <X className="h-3.5 w-3.5" aria-hidden /> {t('finder.po.cancelBtn')}
                  </Button>
                </>
              )}
              {order.status === 'confirmed' && (
                <Button size="sm" className="h-9 min-h-9 gap-1 bg-amber-600 text-xs text-white hover:bg-amber-700" disabled={busy}
                  onClick={() => void act('order.dispatch', { orderId: order.id }, t('finder.po.audit.dispatched', { code: order.orderCode }), t('finder.po.toast.dispatched', { code: order.orderCode }))}
                  aria-label={t('finder.po.dispatchAria', { code: order.orderCode })}>
                  <Truck className="h-3.5 w-3.5" aria-hidden /> {t('finder.po.dispatch')}
                </Button>
              )}
              {order.status === 'delivering' && activeDelivery?.status === 'dispatched' && (
                <Button size="sm" className="h-9 min-h-9 gap-1 bg-emerald-600 text-xs text-white hover:bg-emerald-700" disabled={busy}
                  onClick={() => setReceiveOpen(true)}
                  aria-label={t('finder.po.receiveAria', { code: order.orderCode })}>
                  <Camera className="h-3.5 w-3.5" aria-hidden /> {t('finder.po.receive')}
                </Button>
              )}
              {order.status === 'delivered' && (
                <Button size="sm" variant="outline" className="h-9 min-h-9 gap-1 text-xs" disabled={busy}
                  onClick={() => void act('order.close', { id: order.id }, t('finder.po.audit.closed', { code: order.orderCode }), t('finder.po.toast.closed', { code: order.orderCode }))}
                  aria-label={t('finder.po.closeAria', { code: order.orderCode })}>
                  <PackageCheck className="h-3.5 w-3.5" aria-hidden /> {t('finder.po.close')}
                </Button>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* lines */}
        <div className="overflow-x-auto rounded-md border border-stone-200">
          <table className="w-full min-w-[420px] text-sm">
            <caption className="sr-only">{t('finder.po.caption', { code: order.orderCode })}</caption>
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-400">
                <th scope="col" className="px-3 py-2 font-medium">{t('finder.inv.det.col.item')}</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">{t('finder.inv.det.col.qty')}</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">{t('finder.inv.det.col.unit')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('finder.inv.print.col.lineTotal')}</th>
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
                      {fmtQty(l.qty)} <span className="text-[10px] text-stone-400">{l.unit}</span>
                      {dl && <span className="block text-[10px] text-stone-400">{t('finder.po.received', { qty: fmtQty(dl.qtyReceived) })}</span>}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-stone-700">{formatKes(l.unitPrice)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-stone-900">{formatKes(l.lineTotal)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {order.note && <p className="text-xs italic text-stone-500">{order.note}</p>}

        {/* deliveries — the ground-truth records */}
        {deliveries.map((d) => {
          const shortLines = d.lines.filter((l) => l.qtyReceived < l.qtyOrdered)
          const totalMissing = shortLines.reduce((s, l) => s + (l.qtyOrdered - l.qtyReceived), 0)
          // Evidence photos: line-scoped rows (deliveryLineId) are the
          // discrepancy/inspection evidence for that line; the rest are
          // whole-delivery photos. Legacy rows may carry a photoCount with no
          // links — the count line below says so honestly.
          const linePhotoRows = d.lines
            .map((l) => ({
              lineId: l.id,
              name: order.lines.find((ol) => ol.id === l.orderLineId)?.name ?? 'line',
              photos: d.photos.filter((p) => p.deliveryLineId === l.id),
            }))
            .filter((r) => r.photos.length > 0)
          const generalPhotos = d.photos.filter((p) => p.deliveryLineId === null)
          return (
            <div key={d.id} className={`space-y-2 rounded-lg border p-3 ${d.status === 'discrepancy' ? 'border-orange-200 bg-orange-50/60' : 'border-stone-200 bg-stone-50/60'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <DeliveryStatusBadge status={d.status} />
                <p className="text-[11px] text-stone-500">
                  {t('finder.po.dispatchedAt', { date: d.dispatchedAt ? dateShort(d.dispatchedAt) : '—' })}
                  {d.receivedAt ? t('finder.po.receivedSuffix', { date: dateShort(d.receivedAt) }) : ''}
                  {d.receivedBy ? t('finder.po.bySuffix', { by: d.receivedBy }) : ''}
                </p>
              </div>
              {d.status === 'discrepancy' && shortLines.length > 0 && (
                <div role="alert" className="rounded-md border border-orange-300 bg-white p-3">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-orange-900">
                    <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                    {t('finder.po.discrepancyLine', { ordered: fmtQty(shortLines[0].qtyOrdered), received: fmtQty(shortLines[0].qtyReceived), missing: fmtQty(totalMissing) })}
                  </p>
                  {shortLines.length > 1 && (
                    <ul className="pt-1 pl-5 text-[11px] text-orange-800 list-disc">
                      {shortLines.slice(1).map((l) => (
                        <li key={l.id}>{t('finder.po.anotherShort', { ordered: fmtQty(l.qtyOrdered), received: fmtQty(l.qtyReceived) })}</li>
                      ))}
                    </ul>
                  )}
                  {d.note && <p className="pt-1.5 text-xs italic text-orange-800">{d.note}</p>}
                  <p className="pt-1.5 text-[11px] text-stone-500">{t('finder.po.notified')}</p>
                  {linePhotoRows.map((r) => (
                    <LinePhotoThumbs key={r.lineId} photos={r.photos} lineName={r.name} />
                  ))}
                </div>
              )}
              {d.status === 'received' && d.note && <p className="text-xs italic text-stone-500">{d.note}</p>}
              {(d.photoCount > 0 || (d.gpsLat !== null && d.gpsLng !== null)) && (
                <p className="flex flex-wrap items-center gap-3 text-[11px] text-stone-500">
                  {d.photoCount > 0 && d.photos.length === 0 && (
                    <span className="flex items-center gap-1">
                      <Camera className="h-3 w-3" aria-hidden /> {t(d.photoCount === 1 ? 'finder.po.photosOnRecordOne' : 'finder.po.photosOnRecordMany', { count: d.photoCount })}
                    </span>
                  )}
                  {d.gpsLat !== null && d.gpsLng !== null && (
                    <span className="flex items-center gap-1 tabular-nums">
                      <MapPin className="h-3 w-3 text-emerald-600" aria-hidden />
                      GPS {d.gpsLat.toFixed(4)}, {d.gpsLng.toFixed(4)}
                    </span>
                  )}
                </p>
              )}
              {/* whole-delivery evidence photos — the site-photo rendering */}
              <DeliveryPhotos photos={generalPhotos} />
              {/* line-scoped evidence on a clean receive (no discrepancy banner) */}
              {d.status !== 'discrepancy' &&
                linePhotoRows.map((r) => <LinePhotoThumbs key={r.lineId} photos={r.photos} lineName={r.name} />)}
            </div>
          )
        })}

        {/* invoice hint — the invoices section below handles the money end */}
        {['confirmed', 'delivering', 'delivered', 'closed'].includes(order.status) && (
          <p className="flex items-center gap-1.5 text-[11px] text-stone-500">
            <ReceiptText className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
            {t('finder.po.invoiceHint')}
          </p>
        )}
        {order.status === 'cancelled' && order.note && (
          <p className="flex items-center gap-1.5 text-[11px] text-stone-500">
            <X className="h-3.5 w-3.5 shrink-0" aria-hidden /> {order.note}
          </p>
        )}
      </CardContent>

      {/* receive dialog */}
      <DeliveryReceiveDialog
        order={order}
        deliveryId={activeDelivery?.id ?? null}
        open={receiveOpen}
        onOpenChange={setReceiveOpen}
      />

      {/* cancel dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <X className="h-5 w-5 text-rose-600" aria-hidden /> {t('finder.po.cancelTitle', { code: order.orderCode })}
            </DialogTitle>
            <DialogDescription>
              {t('finder.po.cancelDesc')}
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('finder.po.cancelPh')} aria-label={t('finder.po.cancelAriaLabel')} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>{t('finder.po.keep')}</Button>
            <Button
              className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700"
              disabled={busy || !reason.trim()}
              onClick={() => {
                void act('order.cancel', { id: order.id, reason: reason.trim() }, t('finder.po.audit.cancelled', { code: order.orderCode }), t('finder.po.toast.cancelled', { code: order.orderCode }))
                setCancelOpen(false)
              }}
            >
              <FileText className="h-4 w-4" aria-hidden /> {t('finder.po.cancelOrder')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
