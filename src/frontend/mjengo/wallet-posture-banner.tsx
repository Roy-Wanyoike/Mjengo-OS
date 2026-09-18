'use client'

import { useEffect, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import { useT } from '@/frontend/i18n/provider'
import {
  WALLET_RAILS_POSTURE,
  dismissPostureBanner,
  isPostureBannerDismissed,
} from '@/frontend/mjengo/wallet-posture'

/**
 * Simulated-rails posture banner (issue #123 / audit FE-2).
 *
 * Sits at the TOP of the Money tab so the wallet/escrow/payroll posture is
 * discoverable BEFORE the first transaction — not only inside the top-up /
 * payment-request dialogs. States the honest posture (ledger-real,
 * provider-simulated, pending #43) and stays dismissed per project until the
 * posture itself changes (see wallet-posture.ts for the re-arm design).
 *
 * The fundis payroll gate dialog renders the SAME money.posture.* copy — one
 * key family, no divergent duplicate.
 */
export function WalletPostureBanner({ projectId }: { projectId: string }) {
  const t = useT()
  // SSR + the hydration pass render the honest default (visible) — localStorage
  // is only read after mount, the i18n provider's no-hydration-mismatch rule.
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    setDismissed(isPostureBannerDismissed(projectId))
  }, [projectId])

  function dismiss() {
    dismissPostureBanner(projectId)
    setDismissed(true)
  }

  // Renders only while the rails are simulated — when #43 lands and the
  // posture flips, this banner retires (and any future change re-arms it
  // once per project via the versioned per-posture dismissal record).
  if (WALLET_RAILS_POSTURE !== 'simulated') return null
  if (dismissed) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 leading-relaxed"
    >
      <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
      <span className="flex-1 min-w-0">
        <strong className="font-semibold">{t('money.posture.title')}</strong>
        {' — '}
        {t('money.posture.note')}
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('money.posture.dismissAria')}
        className="flex items-center gap-1.5 h-8 px-2.5 -mt-0.5 rounded-md text-xs font-semibold text-amber-900 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 transition-colors shrink-0"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden sm:inline">{t('money.posture.dismiss')}</span>
      </button>
    </div>
  )
}
