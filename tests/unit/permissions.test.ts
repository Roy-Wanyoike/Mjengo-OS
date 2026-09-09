/**
 * Invariants of the CLIENT-SIDE role→tab permission matrix
 * (src/shared/permissions.ts — W1-PERM mirror of guard.ts).
 *
 * This file is UX navigation only (the backend guard is the enforcement
 * point), so what matters here is that the mirror is SAFE:
 *   · every known role gets a sane, non-empty tab set ⊆ ALL_TABS;
 *   · Audit is admin-only; Settings is universal (per-user prefs);
 *   · the client surface is strictly narrower than the contractor's;
 *   · anything unknown fails CLOSED to the single Overview tab.
 */
import { describe, expect, it } from 'vitest'
import {
  ALL_TABS, FALLBACK_TABS, KNOWN_ROLES, OWNER_ROLES, ROLE_LANDING,
  ROLE_LABELS, ROLE_TABS, can, isKnownRole, labelForRole, landingForRole,
  tabsForRole,
} from '@/shared/permissions'

const OTHER_ROLES = KNOWN_ROLES.filter((r) => r !== 'admin')

describe('role registry', () => {
  it('ships a non-empty tab list for every known role (no blank app)', () => {
    for (const role of KNOWN_ROLES) {
      expect(tabsForRole(role).length, `role "${role}" has no tabs`).toBeGreaterThan(0)
    }
  })

  it('maps exactly the known roles — no orphan rows, no missing rows', () => {
    expect([...Object.keys(ROLE_TABS)].sort()).toEqual([...KNOWN_ROLES].sort())
  })

  it('only ever resolves tabs from the tab universe (defensive typos)', () => {
    for (const role of KNOWN_ROLES) {
      for (const tab of tabsForRole(role)) {
        expect(ALL_TABS).toContain(tab)
      }
    }
  })

  it('labels every known role and stays honest for unknown ones', () => {
    for (const role of KNOWN_ROLES) expect(labelForRole(role)).not.toBe('Unknown')
    expect(labelForRole('intruder')).toBe('Unknown')
    expect(labelForRole(null)).toBe('Unknown')
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...KNOWN_ROLES].sort())
  })
})

describe('audit tab is admin-only (spec §44)', () => {
  it('admin sees Audit', () => {
    expect(tabsForRole('admin')).toContain('audit')
  })

  it('no other role sees Audit', () => {
    for (const role of OTHER_ROLES) {
      expect(tabsForRole(role), `role "${role}" must not see audit`).not.toContain('audit')
    }
  })

  it('the can() capability view agrees with the tab lists for every role', () => {
    for (const role of KNOWN_ROLES) {
      for (const tab of ALL_TABS) {
        expect(can(role, `tab:${tab}`)).toBe(tabsForRole(role).includes(tab))
      }
    }
  })
})

describe('settings is universal (W3-F3 — profile/prefs are per-user)', () => {
  it('is visible to every known role including client', () => {
    for (const role of KNOWN_ROLES) {
      expect(tabsForRole(role), `role "${role}" lost settings`).toContain('settings')
    }
  })
})

describe('client surface is strictly narrower than the contractor surface', () => {
  it('every client tab is also a contractor tab', () => {
    const contractorTabs = new Set(tabsForRole('contractor'))
    for (const tab of tabsForRole('client')) {
      expect(contractorTabs.has(tab), `client-only tab "${tab}" leaked`).toBe(true)
    }
  })

  it('client is a proper subset (contractor strictly sees more)', () => {
    const clientTabs = new Set(tabsForRole('client'))
    const contractorTabs = tabsForRole('contractor')
    expect(contractorTabs.length).toBeGreaterThan(clientTabs.size)
  })

  it('client cannot boot the owner app or manage flags', () => {
    expect(can('client', 'owner.app')).toBe(false)
    expect(can('client', 'flags.manage')).toBe(false)
    expect(OWNER_ROLES).not.toContain('client')
  })
})

describe('unknown / missing roles fail closed', () => {
  it('resolves to exactly the single Overview fallback tab', () => {
    expect(FALLBACK_TABS).toEqual(['overview'])
    expect(tabsForRole('superuser')).toEqual(['overview'])
    expect(tabsForRole('')).toEqual(['overview'])
    expect(tabsForRole(null)).toEqual(['overview'])
    expect(tabsForRole(undefined)).toEqual(['overview'])
  })

  it('case variants are NOT silently accepted (fail closed)', () => {
    expect(tabsForRole('Admin')).toEqual(['overview'])
    expect(isKnownRole('Admin')).toBe(false)
  })

  it('can() denies an unknown role everything EXCEPT the one safe tab', () => {
    // Fail closed = the fallback surface (Overview), not a blank app: the
    // tab: capability derives from tabsForRole, so the fallback tab passes.
    expect(can('ghost', 'tab:overview')).toBe(true)
    expect(can('ghost', 'tab:settings')).toBe(false)
    expect(can('ghost', 'tab:audit')).toBe(false)
    expect(can('ghost', 'owner.app')).toBe(false)
    expect(can('ghost', 'finance.queue')).toBe(false)
    expect(can(null, 'tab:settings')).toBe(false)
  })

  it('unrecognized capabilities fail closed even for admin', () => {
    expect(can('admin', 'tab:audit')).toBe(true)
    expect(can('admin', 'press.the.button' as never)).toBe(false)
  })
})

describe('landing tabs land inside the visible surface', () => {
  it('every known role lands on a tab it can actually see', () => {
    for (const role of KNOWN_ROLES) {
      const landing = landingForRole(role)
      expect(ROLE_TABS[role]).toContain(landing)
    }
  })

  it('unknown roles land on Overview (fail closed)', () => {
    expect(landingForRole('ghost')).toBe('overview')
    expect(landingForRole(null)).toBe('overview')
  })
})
