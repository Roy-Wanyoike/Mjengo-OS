'use client'

// Shared display bits for the Finder invoices section — status ladder chips,
// 3-way match chip, KSh/qty cell helpers. House style: stone + emerald/amber/
// rose palette, lucide icons, tabular numbers (money-tab conventions).

import { Badge } from '@/frontend/ui/badge'
import {
  AlertTriangle, Banknote, Check, FileText, Hourglass, ShieldCheck, X,
} from 'lucide-react'
import { formatKES } from '@/frontend/lib/format'
import type { ThreeWayReport } from '@/backend/modules/invoices/types'

/** House KSh formatter (lib/format) re-exported for the invoices sub-files. */
export const formatKes = formatKES

export function fmtQty(n: number | null): string {
  if (n === null || n === undefined) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/** Status ladder: DRAFT grey · SUBMITTED amber · APPROVED green · PAID forest · REJECTED rose · DISPUTED orange. */
export function InvoiceStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'paid':
      return <Badge className="border-0 bg-emerald-700 text-emerald-50 gap-1 hover:bg-emerald-700"><Banknote className="h-3 w-3" aria-hidden /> Paid</Badge>
    case 'approved':
      return <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100"><Check className="h-3 w-3" aria-hidden /> Approved</Badge>
    case 'rejected':
      return <Badge className="border-0 bg-rose-100 text-rose-800 gap-1 hover:bg-rose-100"><X className="h-3 w-3" aria-hidden /> Rejected</Badge>
    case 'disputed':
      return <Badge className="border-0 bg-orange-100 text-orange-800 gap-1 hover:bg-orange-100"><AlertTriangle className="h-3 w-3" aria-hidden /> Disputed</Badge>
    case 'submitted':
      return <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100"><Hourglass className="h-3 w-3" aria-hidden /> Awaiting client</Badge>
    default:
      return <Badge className="border-0 bg-stone-100 text-stone-600 gap-1 hover:bg-stone-100"><FileText className="h-3 w-3" aria-hidden /> Draft</Badge>
  }
}

/**
 * 3-way match state chip (computed with the SAME pure function the server
 * uses): matched / N open review lines / no-PO 2-way. Warn-only language.
 */
export function ThreeWayChip({ report }: { report: ThreeWayReport }) {
  if (!report.hasOrder) {
    return (
      <Badge variant="outline" className="gap-1 text-[10px] font-medium text-stone-500">
        <FileText className="h-3 w-3" aria-hidden /> No PO — 2-way check
      </Badge>
    )
  }
  if (report.mismatches.length === 0) {
    return (
      <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100">
        <ShieldCheck className="h-3 w-3" aria-hidden /> 3-way matched
      </Badge>
    )
  }
  return (
    <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100">
      <AlertTriangle className="h-3 w-3" aria-hidden /> {report.mismatches.length} review line{report.mismatches.length === 1 ? '' : 's'}
    </Badge>
  )
}

export const PAYMENT_METHOD_LABELS: Record<string, { label: string; hint: string }> = {
  mpesa: { label: 'M-Pesa', hint: 'Mobile money' },
  bank: { label: 'Bank', hint: 'EFT / RTGS' },
  card: { label: 'Card', hint: 'Card rails' },
  wallet: { label: 'MjengoOS wallet', hint: 'From escrow' },
  cash: { label: 'Cash', hint: 'On-site' },
}
