import { expect, test } from '@playwright/test'
import { openTab, signIn } from './helpers'

/**
 * Persona 7 — ADMIN (Mjengo platform superuser).
 * Golden path (issue #182): sign in → the owner app with the admin-only
 * Audit tab → the audit trail renders seeded events → the Intel tab's
 * deterministic intelligence sections.
 *
 * Seed contract: admin@mjengo.os / admin2026 (NOTE: its own password — not
 * mjengo2026). Admin = every tab except the supplier portal (13 desktop
 * tabs), including the admin-only Audit tab (W3-F1, spec §44).
 */
test.describe('Admin — audit & intel golden path', () => {
  test('sign in → audit tab → intel tab', async ({ page }) => {
    await signIn(page, 'admin')

    // Admin sees the full strip: 13 tabs including the admin-only Audit.
    const tabCount = await page.locator('header nav[role="tablist"] [role="tab"]').count()
    expect(tabCount).toBe(13)

    // Audit — the read-only write trail (admin-only surface).
    await openTab(page, 'Audit')
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
    await expect(page.getByText('Filters', { exact: true }).first()).toBeVisible()
    // The seeded trail is non-empty: newest-first rows render in the table.
    await expect(page.locator('#mjengo-panel-audit tbody tr').first()).toBeVisible()

    // Intel — the deterministic intelligence sections over real rows.
    await openTab(page, 'Intel')
    await expect(page.getByText('Project risk', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Weekly digest', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Price intelligence', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Supplier reliability', { exact: true }).first()).toBeVisible()
  })
})
