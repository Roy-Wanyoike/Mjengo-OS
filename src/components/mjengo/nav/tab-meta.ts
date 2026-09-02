import {
  LayoutDashboard, ListChecks, Boxes, PackageSearch, Users, Wallet, Landmark,
  Camera, ScrollText, Radar, Sparkles, Phone, Settings,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { TabKey } from '@/components/mjengo/app'

/**
 * Canonical tab metadata (id → i18n key + icon) for BOTH navigation strips
 * (desktop top strip in header.tsx, mobile bottom bar in nav/). Owned by
 * W1-PERM; the visible subset per role comes from src/lib/permissions.ts.
 *
 * W4-I18N: `label`/`shortLabel` are now DICT KEYS (e.g. 'nav.overview') —
 * components render them via t() from src/lib/i18n. The tab `key` strings are
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
