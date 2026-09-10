'use client'

// Shared display bits for the Finder requests section — status ladder chips,
// approval-chain pills, order/delivery badges. House style: stone +
// amber/emerald/rose palette, lucide icons, tabular numbers (money-tab and
// invoices-bits conventions).

import { Badge } from '@/frontend/ui/badge'
import {
  Check, FileText, Hourglass, Package, PackageCheck, Truck, X, ClipboardList,
  Send, ShieldCheck, AlertTriangle,
} from 'lucide-react'
import { formatKES } from '@/frontend/lib/format'
import { useT } from '@/frontend/i18n/provider'
import type { TranslateFn } from '@/frontend/i18n/types'

export const formatKes = formatKES

export function fmtQty(n: number | null): string {
  if (n === null || n === undefined) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// ---------------- request status ladder ----------------

/** DRAFT grey · SUBMITTED amber · APPROVED green · REJECTED rose · CONVERTED forest */
export function RequestStatusBadge({ status }: { status: string }) {
  const t = useT()
  switch (status) {
    case 'submitted':
      return <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100"><Hourglass className="h-3 w-3" aria-hidden /> {t('finder.req.status.submitted')}</Badge>
    case 'approved':
      return <Badge className="border-0 gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100"><Check className="h-3 w-3" aria-hidden /> {t('finder.req.status.approved')}</Badge>
    case 'rejected':
      return <Badge className="border-0 gap-1 bg-rose-100 text-rose-800 hover:bg-rose-100"><X className="h-3 w-3" aria-hidden /> {t('finder.req.status.rejected')}</Badge>
    case 'converted':
      return <Badge className="border-0 gap-1 bg-emerald-700 text-emerald-50 hover:bg-emerald-700"><ClipboardList className="h-3 w-3" aria-hidden /> {t('finder.req.status.converted')}</Badge>
    default:
      return <Badge className="border-0 gap-1 bg-stone-100 text-stone-600 hover:bg-stone-100"><FileText className="h-3 w-3" aria-hidden /> {t('finder.req.status.draft')}</Badge>
  }
}

/** Mini ladder DRAFT → SUBMITTED → APPROVED/REJECTED → CONVERTED. */
export function RequestStatusLadder({ status }: { status: string }) {
  const t = useT()
  const steps: Array<{ key: string; label: string }> = [
    { key: 'draft', label: t('finder.req.status.draft') },
    { key: 'submitted', label: t('finder.req.status.submitted') },
    { key: status === 'rejected' ? 'rejected' : 'approved', label: t(status === 'rejected' ? 'finder.req.status.rejected' : 'finder.req.status.approved') },
    { key: 'converted', label: t('finder.req.status.po') },
  ]
  const activeIndex =
    status === 'draft' ? 0
    : status === 'submitted' ? 1
    : status === 'rejected' ? 2
    : status === 'approved' ? 2
    : 3
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label={t('finder.req.ladderAria')}>
      {steps.map((step, i) => (
        <li key={step.key} className="flex items-center gap-1">
          {i > 0 && <span className="text-stone-300" aria-hidden>→</span>}
          <span
            className={
              i < activeIndex
                ? 'rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-400'
                : i === activeIndex
                  ? 'rounded-full bg-amber-600 px-2 py-0.5 text-[10px] font-semibold text-white'
                  : 'rounded-full bg-stone-50 px-2 py-0.5 text-[10px] text-stone-400'
            }
            aria-current={i === activeIndex ? 'step' : undefined}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

// ---------------- approval chain ----------------

/** Role display label through the i18n dict (role.* keys; unknown → raw value). */
export function roleLabel(t: TranslateFn, role: string): string {
  return t(`role.${role}`)
}

/** One approval row as a pill: role + decision state + optional note. */
export function ApprovalPill({
  role, decision, note, isMine, onDecide,
}: {
  role: string
  decision: string
  note?: string | null
  isMine: boolean
  onDecide?: (decision: 'approve' | 'reject') => void
}) {
  const t = useT()
  const tone =
    decision === 'approved'
      ? 'bg-emerald-100 text-emerald-800'
      : decision === 'rejected'
        ? 'bg-rose-100 text-rose-800'
        : 'bg-amber-100 text-amber-900'
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}>
        {decision === 'approved' ? <Check className="h-3 w-3" aria-hidden /> : decision === 'rejected' ? <X className="h-3 w-3" aria-hidden /> : <Hourglass className="h-3 w-3" aria-hidden />}
        {roleLabel(t, role)}
        {decision === 'pending' ? ` ${t('finder.approval.decides')}` : decision === 'approved' ? ' ✓' : ' ✕'}
      </span>
      {note && <span className="max-w-[16rem] truncate text-[10px] italic text-stone-400" title={note}>{note}</span>}
      {isMine && decision === 'pending' && onDecide && (
        <span className="flex gap-1">
          <button
            className="rounded-full bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-emerald-700"
            onClick={() => onDecide('approve')}
          >
            {t('finder.approval.approve')}
          </button>
          <button
            className="rounded-full border border-rose-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-700 transition hover:bg-rose-50"
            onClick={() => onDecide('reject')}
          >
            {t('finder.approval.reject')}
          </button>
        </span>
      )}
    </div>
  )
}

// ---------------- order status ----------------

export function OrderStatusBadge({ status }: { status: string }) {
  const t = useT()
  switch (status) {
    case 'pending_approval':
      return <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100"><Hourglass className="h-3 w-3" aria-hidden /> {t('finder.order.status.pendingApproval')}</Badge>
    case 'approved':
      return <Badge className="border-0 gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100"><Check className="h-3 w-3" aria-hidden /> {t('finder.order.status.approved')}</Badge>
    case 'sent':
      return <Badge className="border-0 gap-1 bg-sky-100 text-sky-800 hover:bg-sky-100"><Send className="h-3 w-3" aria-hidden /> {t('finder.order.status.sent')}</Badge>
    case 'confirmed':
      return <Badge className="border-0 gap-1 bg-teal-100 text-teal-800 hover:bg-teal-100"><ShieldCheck className="h-3 w-3" aria-hidden /> {t('finder.order.status.confirmed')}</Badge>
    case 'delivering':
      return <Badge className="border-0 gap-1 bg-amber-100 text-amber-900 hover:bg-amber-100"><Truck className="h-3 w-3" aria-hidden /> {t('finder.order.status.inTransit')}</Badge>
    case 'delivered':
      return <Badge className="border-0 gap-1 bg-emerald-700 text-emerald-50 hover:bg-emerald-700"><PackageCheck className="h-3 w-3" aria-hidden /> {t('finder.order.status.delivered')}</Badge>
    case 'closed':
      return <Badge className="border-0 gap-1 bg-stone-800 text-stone-50 hover:bg-stone-800"><Package className="h-3 w-3" aria-hidden /> {t('finder.order.status.closed')}</Badge>
    case 'cancelled':
      return <Badge className="border-0 gap-1 bg-stone-200 text-stone-600 hover:bg-stone-200"><X className="h-3 w-3" aria-hidden /> {t('finder.order.status.cancelled')}</Badge>
    default:
      return <Badge className="border-0 gap-1 bg-stone-100 text-stone-600 hover:bg-stone-100"><FileText className="h-3 w-3" aria-hidden /> {t('finder.order.status.draft')}</Badge>
  }
}

export function DeliveryStatusBadge({ status }: { status: string }) {
  const t = useT()
  switch (status) {
    case 'received':
      return <Badge className="border-0 gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100"><PackageCheck className="h-3 w-3" aria-hidden /> {t('finder.delivery.status.received')}</Badge>
    case 'discrepancy':
      return <Badge className="border-0 gap-1 bg-orange-100 text-orange-800 hover:bg-orange-100"><AlertTriangle className="h-3 w-3" aria-hidden /> {t('finder.delivery.status.discrepancy')}</Badge>
    default:
      return <Badge className="border-0 gap-1 bg-stone-100 text-stone-600 hover:bg-stone-100"><Truck className="h-3 w-3" aria-hidden /> {t('finder.delivery.status.dispatched')}</Badge>
  }
}
