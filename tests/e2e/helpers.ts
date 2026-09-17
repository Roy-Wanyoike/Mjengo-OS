import { expect, type Page } from '@playwright/test'

/**
 * Shared helpers for the 7 persona golden paths (issue #182 / TEST-1).
 *
 * Everything here drives the app exactly as a human does: the login form on
 * the root route, then the role-scoped app shell. Locators prefer the app's
 * own accessibility contract — the login inputs (#login-email/#login-password),
 * the header tab strip (role="tab", id `mjengo-tab-<key>` paired with panel
 * `mjengo-panel-<key>`), and visible seeded data.
 */

/**
 * The demo accounts provisioned by `bun run seed` (prisma/seed-extras/users.ts,
 * listed in README.md "Demo accounts"). NOTE: the supplier and admin accounts
 * ship with their OWN passwords (supplier2026 / admin2026) — not mjengo2026.
 */
export const DEMO = {
  contractor: { email: 'contractor@mjengo.os', password: 'mjengo2026' },
  client: { email: 'client@mjengo.os', password: 'mjengo2026' },
  supervisor: { email: 'supervisor@mjengo.os', password: 'mjengo2026' },
  procurement: { email: 'procurement@mjengo.os', password: 'mjengo2026' },
  finance: { email: 'finance@mjengo.os', password: 'mjengo2026' },
  admin: { email: 'admin@mjengo.os', password: 'admin2026' },
  supplier: { email: 'supplier@mjengo.os', password: 'supplier2026' },
} as const

export type DemoRole = keyof typeof DEMO

/** The base demo project from prisma/seed.ts (the client demo account is pinned to it). */
export const SEEDED_PROJECT = 'Nyumba Yangu — 3BR Bungalow'

/** Visible tab label → canonical tab key (src/frontend/mjengo/nav/tab-meta.ts). */
const TAB_KEYS: Record<string, string> = {
  Overview: 'overview',
  'Site Plan': 'site',
  Materials: 'materials',
  Finder: 'finder',
  Fundis: 'fundis',
  Money: 'money',
  Land: 'land',
  Evidence: 'evidence',
  Intel: 'intel',
  'AI Copilot': 'copilot',
  USSD: 'ussd',
  Audit: 'audit',
  Settings: 'settings',
}

/**
 * Sign in through the real login form and wait for the role's app shell.
 *
 * The login screen posts next-auth credentials, then `window.location.reload()`
 * boots the role's surface — so we wait for a shell marker per surface:
 *   · owner roles (contractor/admin/supervisor/procurement/finance) → tabpanel
 *   · client → the read-only client banner (client surface, no owner shell)
 *   · supplier → the SupplierPortal header
 */
export async function signIn(page: Page, role: DemoRole): Promise<void> {
  const { email, password } = DEMO[role]
  await page.goto('/')
  const emailField = page.locator('#login-email')
  await expect(emailField).toBeVisible()
  await emailField.fill(email)
  await page.locator('#login-password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  if (role === 'supplier') {
    // W5-3: supplier sessions boot the scoped SupplierPortal, never the owner
    // app. The portal header <p> is the unambiguous shell marker.
    await expect(page.getByText('MjengoOS · Supplier portal')).toBeVisible()
    return
  }
  if (role === 'client') {
    // The client surface keeps the tab strip but swaps the banner to read-only.
    await expect(page.getByText('Client view — live site data · read-only')).toBeVisible()
    return
  }
  // Owner app shell: the active tab panel exists as soon as data has loaded.
  await expect(page.getByRole('tabpanel')).toBeVisible()
}

/**
 * Switch to a tab by its visible label and wait for its panel.
 * Uses the canonical `mjengo-tab-<key>` / `mjengo-panel-<key>` ids (app.tsx +
 * header.tsx a11y contract) — deterministic even though the mobile bottom bar
 * repeats the same role="tab" behind md:hidden.
 */
export async function openTab(page: Page, label: keyof typeof TAB_KEYS & string): Promise<void> {
  const key = TAB_KEYS[label]
  if (!key) throw new Error(`Unknown tab label: ${label}`)
  const tab = page.locator(`#mjengo-tab-${key}`)
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(page.locator(`#mjengo-panel-${key}`)).toBeVisible()
}

/**
 * Assert the active project by the switcher trigger's accessible name —
 * the trigger's inner span truncates to zero width on narrower layouts, so
 * the aria-label (not the text) is the stable, honest signal.
 */
export async function expectActiveProject(page: Page, name: string = SEEDED_PROJECT): Promise<void> {
  await expect(page.getByRole('button', { name: `Switch project — current: ${name}` })).toBeVisible()
}

/**
 * The CLIENT surface pins the project in the header (aria-label "Project
 * name") instead of the owner app's switcher — clientRole sessions render
 * the share-client header (header.tsx isShareClient).
 */
export async function expectClientProject(page: Page, name: string = SEEDED_PROJECT): Promise<void> {
  await expect(page.getByLabel('Project name')).toHaveText(name)
}

/** Assert a tab is present in the desktop strip (role-scoped navigation check). */
export async function expectTabVisible(page: Page, label: keyof typeof TAB_KEYS & string): Promise<void> {
  const key = TAB_KEYS[label]
  if (!key) throw new Error(`Unknown tab label: ${label}`)
  await expect(page.locator(`#mjengo-tab-${key}`)).toBeVisible()
}

/** Assert a tab is ABSENT from the desktop strip (fail-closed role matrix check). */
export async function expectTabHidden(page: Page, label: keyof typeof TAB_KEYS & string): Promise<void> {
  const key = TAB_KEYS[label]
  if (!key) throw new Error(`Unknown tab label: ${label}`)
  await expect(page.locator(`#mjengo-tab-${key}`)).toHaveCount(0)
}
