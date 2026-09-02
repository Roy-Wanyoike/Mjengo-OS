'use client'

/**
 * CLIENT-SIDE permission source (W1-PERM · spec Doc B §5 information
 * architecture, §6 permission-driven UI, §7 role matrix, §53–§55 navigation).
 *
 * SERVER TRUTH = src/backend/lib/guard.ts (+ per-route `withGuard` allowlists).
 * This file MIRRORS that truth for UX/navigation only — it is not, and can
 * never be, the enforcement point (Doc B §6: “The backend remains the final
 * authority… Never rely on frontend authorization for security.”).
 * When you change a role set in guard.ts, change the mirror here in the
 * same commit.
 *
 * Unknown roles fail CLOSED everywhere in this file: one safe tab
 * (Overview) + an honest “unknown role” notice (rendered by app.tsx).
 */

import { useSession } from 'next-auth/react'
import type { TabKey } from '@/frontend/mjengo/app'

// ---------------------------------------------------------------- tab universe

/** Every tab id the owner app can render (order = canonical nav order). */
export const ALL_TABS: readonly TabKey[] = [
  'overview', 'site', 'materials', 'finder', 'fundis', 'money',
  'land', 'evidence', 'intel', 'copilot', 'ussd', 'audit', 'settings',
]

// ---------------------------------------------------------------- role registry
// Mirrors guard.ts KNOWN_ROLES / OWNER_ROLES / FINANCE_ROLES / PAYMENT_ROLES.

/** Mirror of guard.ts KNOWN_ROLES (staff + client roles the platform ships). */
export const KNOWN_ROLES: readonly string[] = [
  'contractor', 'client', 'admin', 'finance', 'supervisor', 'procurement', 'qs',
]

/** Mirror of guard.ts OWNER_ROLES — roles that boot the full owner app. */
export const OWNER_ROLES: readonly string[] = [
  'contractor', 'admin', 'supervisor', 'procurement', 'qs', 'finance',
]

/** Mirror of guard.ts FINANCE_ROLES (wallet/payment queue surface). */
const FINANCE_ROLES: readonly string[] = ['finance', 'admin']

/** Mirror of guard.ts PAYMENT_ROLES (execute payments on the payer queue). */
const PAYMENT_ROLES: readonly string[] = ['finance', 'admin', 'client']

// ---------------------------------------------------------------- role → tabs

/**
 * Role → visible tab ids (Doc B §5: “Do not show every item to every role”).
 * `client` mirrors the existing client surface (all tabs except the AI
 * Copilot); the client flow itself is handled outside this matrix.
 * `audit` (W3-F1 · spec §44 Admin → Audit Logs) is admin-ONLY: contractor
 * and client explicitly exclude it from the full set.
 * `settings` (W3-F3) is visible to EVERY role incl. client — profile,
 * local preferences and notification prefs are per-user, not per-role.
 * Unknown roles → ['overview'] (fail closed).
 */
export const ROLE_TABS: Readonly<Record<string, readonly TabKey[]>> = {
  contractor: ALL_TABS.filter((t) => t !== 'audit'),
  admin: ALL_TABS,
  supervisor: ['overview', 'site', 'materials', 'finder', 'fundis', 'evidence', 'copilot', 'ussd', 'settings'],
  finance: ['overview', 'money', 'finder', 'evidence', 'settings'],
  procurement: ['overview', 'finder', 'materials', 'evidence', 'settings'],
  qs: ['overview', 'site', 'materials', 'finder', 'evidence', 'settings'],
  client: ALL_TABS.filter((t) => t !== 'copilot' && t !== 'audit'),
}

/** Fail-closed fallback for unknown/missing roles: the one safe tab. */
export const FALLBACK_TABS: readonly TabKey[] = ['overview']

/** Friendly, honest names (login screen, user chip, notices). */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  contractor: 'Contractor',
  client: 'Client',
  admin: 'Admin',
  finance: 'Finance Officer',
  supervisor: 'Site Supervisor',
  procurement: 'Procurement Officer',
  qs: 'Quantity Surveyor',
}

/**
 * Post-login landing tab per role (task W1-PERM):
 * finance → Money, procurement → Finder, qs → Materials,
 * everyone else → Overview. Unknown → Overview (fail closed).
 */
export const ROLE_LANDING: Readonly<Record<string, TabKey>> = {
  contractor: 'overview',
  admin: 'overview',
  supervisor: 'overview',
  finance: 'money',
  procurement: 'finder',
  qs: 'materials',
  client: 'overview',
}

// ---------------------------------------------------------------- helpers

/** True when the role is one the platform knows (fail closed otherwise). */
export function isKnownRole(role: string | null | undefined): boolean {
  return typeof role === 'string' && KNOWN_ROLES.includes(role)
}

/** Visible tabs for a role — fail closed to FALLBACK_TABS for unknown roles. */
export function tabsForRole(role: string | null | undefined): readonly TabKey[] {
  if (!role || !isKnownRole(role)) return FALLBACK_TABS
  return ROLE_TABS[role] ?? FALLBACK_TABS
}

/** Landing tab for a role — fail closed to Overview for unknown roles. */
export function landingForRole(role: string | null | undefined): TabKey {
  if (!role || !isKnownRole(role)) return 'overview'
  return ROLE_LANDING[role] ?? 'overview'
}

/** Friendly label for a role — honest “Unknown” for anything else. */
export function labelForRole(role: string | null | undefined): string {
  if (!role) return 'Unknown'
  return ROLE_LABELS[role] ?? 'Unknown'
}

/**
 * Capability checks (Doc B §6 — permission checks, not role string compares).
 * `tab:<id>` derives from ROLE_TABS; feature capabilities mirror guard.ts.
 * Fail closed: unknown roles only ever get the Overview tab.
 */
export type Capability =
  | `tab:${TabKey}`
  | 'owner.app'        // boots the owner app (vs. the client surface)
  | 'flags.manage'     // feature-flag popover (admin only, as today)
  | 'finance.queue'    // wallet / payment-queue surface (FINANCE_ROLES)
  | 'payments.execute' // execute payments on the payer queue (PAYMENT_ROLES)
  | 'project.create'   // POST /api/projects allowlist
  | 'share.link'       // share-with-client + regenerate

export function can(role: string | null | undefined, capability: Capability): boolean {
  if (!role) return false
  if (capability.startsWith('tab:')) {
    const key = capability.slice(4) as TabKey
    return tabsForRole(role).includes(key)
  }
  switch (capability) {
    case 'owner.app':
      return OWNER_ROLES.includes(role)
    case 'flags.manage':
      return role === 'admin'
    case 'finance.queue':
      return FINANCE_ROLES.includes(role)
    case 'payments.execute':
      return PAYMENT_ROLES.includes(role)
    case 'project.create':
      return role === 'contractor' || role === 'admin'
    case 'share.link':
      return OWNER_ROLES.includes(role)
    default:
      return false // fail closed on unrecognized capabilities
  }
}

// ---------------------------------------------------------------- hook

/**
 * Session-derived permission view for client components. Follows the app's
 * existing pattern (next-auth useSession — see header.tsx UserChip). Share-link
 * visitors have no session: role null → fail closed, can() always false.
 */
export function usePermissions() {
  const { data: session, status } = useSession()
  const authenticated = status === 'authenticated' && Boolean(session?.user?.email)
  const role = authenticated ? String(session?.user?.role ?? 'contractor') : null

  return {
    /** Raw session role (null while signed out / resolving). */
    role,
    authenticated,
    /** True when the role is in the mirror of guard.ts KNOWN_ROLES. */
    knownRole: isKnownRole(role),
    /** Honest label; "Unknown" signals the fail-closed state. */
    label: labelForRole(role),
    /** Visible tab ids for this role (fail closed for unknown roles). */
    tabs: tabsForRole(role),
    /** Post-login landing tab for this role. */
    landingTab: landingForRole(role),
    /** Client surface (handled outside the ROLE_TABS flow). */
    isClient: role === 'client',
    /** Owner app roles (mirror of guard.ts OWNER_ROLES). */
    isOwner: role !== null && OWNER_ROLES.includes(role),
    /** Permission check bound to this session's role. */
    can: (capability: Capability) => can(role, capability),
  }
}
