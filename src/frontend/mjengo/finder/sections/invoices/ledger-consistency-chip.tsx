'use client'

// A-1-lite ledger consistency chip — green "Ledger consistent" / amber
// "Drift KSh X — investigate". Read-only projection recomputed on every
// payload refresh (repository → computeLedgerConsistency); the wallet itself
// is never mutated by the check.

import { Badge } from '@/frontend/ui/badge'
import { AlertTriangle, BookCheck } from 'lucide-react'
import { useT } from '@/frontend/i18n/provider'
import type { LedgerCheck } from '@/backend/modules/invoices/types'
import { formatKes } from './invoice-bits'

export function LedgerConsistencyChip({ check, walletBalance }: { check: LedgerCheck; walletBalance: number }) {
  const t = useT()
  if (check.consistent) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="border-0 bg-emerald-100 text-emerald-800 gap-1 hover:bg-emerald-100">
          <BookCheck className="h-3 w-3" aria-hidden /> {t('finder.inv.ledger.ok')}
        </Badge>
        <span className="text-[11px] text-stone-400">
          {t('finder.inv.ledger.okNote', { balance: formatKes(walletBalance) })}
        </span>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge className="border-0 bg-amber-100 text-amber-900 gap-1 hover:bg-amber-100">
        <AlertTriangle className="h-3 w-3" aria-hidden /> {t('finder.inv.ledger.drift', { amount: formatKes(check.drift) })}
      </Badge>
      <span className="text-[11px] text-amber-700">{check.note}</span>
    </div>
  )
}
