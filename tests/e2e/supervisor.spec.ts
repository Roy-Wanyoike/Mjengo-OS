import { expect, test } from '@playwright/test'
import { expectTabHidden, openTab, signIn } from './helpers'

/**
 * Persona 3 — SITE SUPERVISOR (Wanjiru, runs the site day).
 * Golden path (issue #182): sign in → today's work (overview crew KPIs) →
 * attendance (Fundis daily record) → the evidence upload UI (AI Copilot
 * photo capture) → the daily report (Reports menu).
 *
 * Seed contract: supervisor@mjengo.os / mjengo2026 — site tabs + Copilot/USSD,
 * NO Money/Land/Intel (login-screen demo hint, ROLE_TABS.supervisor = 9 tabs).
 */
test.describe('Supervisor — site-operations golden path', () => {
  test('sign in → today’s work → attendance → evidence upload UI → daily report', async ({ page }) => {
    await signIn(page, 'supervisor')

    // Role matrix: site operations only — no Money, no Land, no Intel.
    await expectTabHidden(page, 'Money')
    await expectTabHidden(page, 'Land')
    await expectTabHidden(page, 'Intel')
    const tabCount = await page.locator('header nav[role="tablist"] [role="tab"]').count()
    expect(tabCount).toBe(9)

    // Today's work — the overview's crew + photo KPIs over seeded attendance.
    await openTab(page, 'Overview')
    await expect(page.getByText('Crew today', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Photo evidence log', { exact: true }).first()).toBeVisible()

    // Attendance — the Fundis tab's daily record over the seeded roster.
    await openTab(page, 'Fundis')
    await expect(page.getByText('On site today', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Attendance — last 7 days', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Mwangi Kariuki').first()).toBeVisible()

    // Evidence upload UI — Copilot "Photo progress": the field capture surface.
    await openTab(page, 'AI Copilot')
    await expect(page.getByRole('button', { name: 'Photo progress' })).toBeVisible()
    await expect(page.getByText('1 · Capture the physical ground truth', { exact: true }).first()).toBeVisible()
    await expect(page.getByLabel('Upload site photo')).toBeVisible()

    // Daily report — the overview Reports menu offers the daily CSV.
    await openTab(page, 'Overview')
    await page.getByRole('button', { name: 'Reports' }).click()
    await expect(page.getByRole('menuitem', { name: 'Daily report (CSV)' })).toBeVisible()
  })
})
