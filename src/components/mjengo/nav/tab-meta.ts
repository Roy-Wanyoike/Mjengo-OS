import {
  LayoutDashboard, ListChecks, Boxes, PackageSearch, Users, Wallet, Landmark,
  ScrollText, Radar, Sparkles, Phone,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { TabKey } from '@/components/mjengo/app'

/**
 * Canonical tab metadata (id → label + icon) for BOTH navigation strips
 * (desktop top strip in header.tsx, mobile bottom bar in nav/). Owned by
 * W1-PERM; the visible subset per role comes from src/lib/permissions.ts.
 */
export interface TabMeta {
  key: TabKey
  label: string
  /** Compact label for the mobile bottom bar (≥11px, truncation-safe). */
  shortLabel: string
  icon: LucideIcon
}

export const TAB_META: readonly TabMeta[] = [
  { key: 'overview', label: 'Overview', shortLabel: 'Home', icon: LayoutDashboard },
  { key: 'site', label: 'Site Plan', shortLabel: 'Plan', icon: ListChecks },
  { key: 'materials', label: 'Materials', shortLabel: 'Stock', icon: Boxes },
  { key: 'finder', label: 'Finder', shortLabel: 'Finder', icon: PackageSearch },
  { key: 'fundis', label: 'Fundis', shortLabel: 'Fundis', icon: Users },
  { key: 'money', label: 'Money', shortLabel: 'Money', icon: Wallet },
  { key: 'land', label: 'Land', shortLabel: 'Land', icon: Landmark },
  { key: 'evidence', label: 'Evidence', shortLabel: 'Photos', icon: ScrollText },
  { key: 'intel', label: 'Intel', shortLabel: 'Intel', icon: Radar },
  { key: 'copilot', label: 'AI Copilot', shortLabel: 'Copilot', icon: Sparkles },
  { key: 'ussd', label: 'USSD', shortLabel: 'USSD', icon: Phone },
]

/** Metadata for one tab id (always found — every TabKey is in TAB_META). */
export function metaFor(key: TabKey): TabMeta {
  return TAB_META.find((t) => t.key === key) ?? TAB_META[0]
}

/** Ordered metadata for a set of tab ids. */
export function metaForAll(keys: readonly TabKey[]): TabMeta[] {
  return keys.map(metaFor)
}
