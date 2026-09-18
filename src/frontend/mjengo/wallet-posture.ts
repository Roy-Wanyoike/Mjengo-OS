/**
 * Wallet-rails posture (issue #123 / audit FE-2) — PURE, unit-tested.
 *
 * The Money tab's wallet/escrow/payroll rails are honest simulations (issue
 * #43, spec §40 PaymentProvider seam): every movement posts a REAL balanced
 * double-entry ledger row, but the provider side is the SimulatedProvider —
 * no money leaves any real M-Pesa/bank account. Until #123 the disclosure
 * lived only inline inside the top-up dialog (money.topup.note), the
 * payment-request dialog (money.pr.simulatedNote) and the payroll toast
 * (fundis.payrollPaid). This module is the SINGLE client-side seam the new
 * Money-tab posture banner (and the fundis payroll gate line) read from.
 *
 * POSTURE-CHANGE RE-ARMING (the acceptance-critical design):
 *   · A dismissal is only remembered for the posture it was dismissed under
 *     — the record stores `posture`, and `isPostureBannerDismissed()` only
 *     honours it when it equals the CURRENT `WALLET_RAILS_POSTURE`.
 *   · The storage key itself is versioned (`…v${POSTURE_BANNER_STORAGE_VERSION}…`)
 *     so bumping the version ALSO re-arms the banner for every project, even
 *     if a future refactor forgets the record comparison.
 *   When Daraja production wiring lands (#43): flip `WALLET_RAILS_POSTURE`
 *   to 'production' — the banner retires everywhere (it renders only while
 *   the posture is 'simulated'), and any LATER posture change re-arms it
 *   once per project. Either flip also matches the backend HONESTY LABEL
 *   seam (modules/wallet/providers.ts — `simulated: true`).
 *
 * Persistence follows the app's offline-first local-only conventions
 * (cf. 'mjengo-os-store' / 'mjengo-os-settings'): per-project key, plain
 * localStorage, never synced to the server.
 */

/** What #43 tracks. 'simulated' today; 'production' once Daraja wiring lands. */
export type WalletRailsPosture = 'simulated' | 'production'

/** The current posture of the wallet/escrow/payroll payment rails. */
export const WALLET_RAILS_POSTURE: WalletRailsPosture = 'simulated'

/**
 * Storage-key version — bump to re-arm the banner for every project
 * (e.g. when the disclosure copy or posture semantics materially change).
 */
export const POSTURE_BANNER_STORAGE_VERSION = 1

/** localStorage key prefix, house style ('mjengo-os-store' / 'mjengo-os-settings'). */
const POSTURE_BANNER_KEY_PREFIX = 'mjengo-os-posture-banner'

/** The per-project dismissal record kept in localStorage. */
export interface PostureBannerDismissal {
  /** The posture this dismissal was given under — mismatches re-arm. */
  posture: WalletRailsPosture | string
  /** ISO timestamp (diagnostics only; no expiry by design). */
  dismissedAt: string
}

/** Per-project dismissal key: `mjengo-os-posture-banner.v<version>.<projectId>`. */
export function postureBannerKey(projectId: string): string {
  return `${POSTURE_BANNER_KEY_PREFIX}.v${POSTURE_BANNER_STORAGE_VERSION}.${projectId}`
}

/**
 * Has the user dismissed the posture banner for THIS project under the
 * CURRENT posture? Fail-visible: no window (SSR/tests), no record, corrupt
 * JSON, or a posture/version mismatch all return false (banner shows).
 */
export function isPostureBannerDismissed(
  projectId: string,
  posture: WalletRailsPosture = WALLET_RAILS_POSTURE,
): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(postureBannerKey(projectId))
    if (!raw) return false
    const parsed = JSON.parse(raw) as Partial<PostureBannerDismissal>
    // Only a dismissal given under the CURRENT posture counts — flipping
    // WALLET_RAILS_POSTURE re-arms the banner for every project.
    return parsed.posture === posture
  } catch {
    return false
  }
}

/**
 * Remember the dismissal for this project under the CURRENT posture.
 * Storage failures (quota/private-mode) are swallowed — worst case the
 * banner stays visible, which is the honest direction to fail in.
 */
export function dismissPostureBanner(
  projectId: string,
  posture: WalletRailsPosture = WALLET_RAILS_POSTURE,
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      postureBannerKey(projectId),
      JSON.stringify({ posture, dismissedAt: new Date().toISOString() } satisfies PostureBannerDismissal),
    )
  } catch {
    // fail-visible: the banner simply isn't dismissed
  }
}
