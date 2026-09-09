import {
  LayoutDashboard, ListChecks, Boxes, PackageSearch, Users, Wallet, Landmark,
  Camera, ScrollText, Radar, Sparkles, Phone, Settings,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { TabKey } from '@/frontend/mjengo/app'

/**
 * Canonical tab metadata (id → i18n key + icon) for BOTH navigation strips
 * (desktop top strip in header.tsx, mobile bottom bar in nav/). Owned by
 * W1-PERM; the visible subset per role comes from src/shared/permissions.ts.
 *
 * W4-I18N: `label`/`shortLabel` are now DICT KEYS (e.g. 'nav.overview') —
 * components render them via t() from src/frontend/i18n. The tab `key` strings are
 * state keys used everywhere (permissions, app.tsx tab state, 'mjengo:tab'
 * events) and are NEVER translated or renamed.
 */
export interface TabMeta {
  key: TabKey
  /** i18n dict key for the full label (render via t()). */
  label: string
  /** i18n dict key for the compact mobile label (≥11px, truncation-safe). */
  shortLabel: string
  icon: LucideIcon
}

export const TAB_META: readonly TabMeta[] = [
  { key: 'overview', label: 'nav.overview', shortLabel: 'nav.short.overview', icon: LayoutDashboard },
  { key: 'site', label: 'nav.site', shortLabel: 'nav.short.site', icon: ListChecks },
  { key: 'materials', label: 'nav.materials', shortLabel: 'nav.short.materials', icon: Boxes },
  { key: 'finder', label: 'nav.finder', shortLabel: 'nav.short.finder', icon: PackageSearch },
  { key: 'fundis', label: 'nav.fundis', shortLabel: 'nav.short.fundis', icon: Users },
  { key: 'money', label: 'nav.money', shortLabel: 'nav.short.money', icon: Wallet },
  { key: 'land', label: 'nav.land', shortLabel: 'nav.short.land', icon: Landmark },
  { key: 'evidence', label: 'nav.evidence', shortLabel: 'nav.short.evidence', icon: Camera },
  { key: 'intel', label: 'nav.intel', shortLabel: 'nav.short.intel', icon: Radar },
  { key: 'copilot', label: 'nav.copilot', shortLabel: 'nav.short.copilot', icon: Sparkles },
  { key: 'ussd', label: 'nav.ussd', shortLabel: 'nav.short.ussd', icon: Phone },
  { key: 'audit', label: 'nav.audit', shortLabel: 'nav.short.audit', icon: ScrollText },
  { key: 'settings', label: 'nav.settings', shortLabel: 'nav.short.settings', icon: Settings },
]

/** Metadata for one tab id (always found — every TabKey is in TAB_META). */
export function metaFor(key: TabKey): TabMeta {
  return TAB_META.find((t) => t.key === key) ?? TAB_META[0]
}

/** Ordered metadata for a set of tab ids. */
export function metaForAll(keys: readonly TabKey[]): TabMeta[] {
  return keys.map(metaFor)
}

// ---------------- feature-flag tab gating (spec §81, task 9-a) ----------------

/**
 * Flag key → the tab whose ENTRY it gates. Mirrors the server-side map in
 * src/backend/modules/intel/flags.ts (the per-flag enforcement table) — keep
 * the two in sync. `land_verification` is NOT here: the Land tab hosts the
 * professionals directory too (a separate module with no flag), so that flag
 * gates the parcels SECTION inside the tab (see land-tab.tsx), not the tab.
 */
export const FLAG_GATED_TABS: Readonly<Record<string, TabKey>> = {
  wallet: 'money',
  marketplace: 'finder',
}

/**
 * Client mirror of the server gate (requireFlagOn in modules/intel/flags.ts):
 * a flag OFF hides its feature's entry for NON-ADMIN sessions — admins bypass
 * on both sides (their routes pass AND their entries stay visible) so they
 * can toggle & test. `flags` is the payload's intel.flags map; undefined =
 * flags not loaded yet → treated as ON, matching the pre-existing
 * ai_progress pattern (`flags?.x !== false`).
 */
export function flagOnFor(
  flags: Record<string, boolean> | null | undefined,
  key: string,
  role: string | null | undefined,
): boolean {
  if (role === 'admin') return true
  return flags?.[key] !== false
}

/**
 * Filter a role's tab list by the flag-gated entries (order preserved). Used
 * by all three navigation surfaces — app.tsx (active-tab snapping + tab
 * events), header.tsx (desktop strip) and mobile/nav (bottom bar) — so a
 * hidden tab is hidden everywhere and a stale active tab snaps to the
 * role's landing tab.
 */
export function tabsVisibleForFlags(
  tabs: readonly TabKey[],
  flags: Record<string, boolean> | null | undefined,
  role: string | null | undefined,
): readonly TabKey[] {
  if (!flags) return tabs
  return tabs.filter((key) => {
    const gated = Object.entries(FLAG_GATED_TABS).find(([, tab]) => tab === key)
    return !gated || flagOnFor(flags, gated[0], role)
  })
}
