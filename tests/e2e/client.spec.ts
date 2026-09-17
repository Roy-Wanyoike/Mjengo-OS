import { expect, test } from '@playwright/test'
import { expectClientProject, expectTabHidden, openTab, signIn } from './helpers'

/**
 * Persona 1 — CLIENT (Amina, diaspora homeowner).
 * Golden path (issue #182, from the QA reports' manual browser verification):
 * sign in → the pinned project's read-only surface → overview (progress) →
 * evidence → money read view → documents (Land parcel vault).
 *
 * Seed contract: client@mjengo.os / mjengo2026 is pinned to
 * "Nyumba Yangu — 3BR Bungalow" (prisma/seed-extras/users.ts); the client
 * surface never shows the site-team tools (AI Copilot / Audit tabs absent).
 */
test.describe('Client — diaspora read-only golden path', () => {
  test('sign in → project → overview/progress/evidence → money read view → documents', async ({ page }) => {
    await signIn(page, 'client')

    // The client surface banner + the seeded project pinned as active.
    await expect(page.getByText('Client view — live site data · read-only', { exact: true }).first()).toBeVisible()
    await expectClientProject(page)

    // Role matrix (fail-closed): a client never sees the site-team tools.
    await expectTabHidden(page, 'AI Copilot')
    await expectTabHidden(page, 'Audit')

    // Overview — live progress of the seeded build.
    await openTab(page, 'Overview')
    await expect(page.getByText('Build progress', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Project health', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Phases', { exact: true }).first()).toBeVisible()
    // Seeded phase set (prisma/seed.ts): Walling is the in-progress phase.
    await expect(page.getByText('Walling').first()).toBeVisible()

    // Evidence — the client keeps the Bias-Free Ledger, not the PDF tooling.
    await openTab(page, 'Evidence')
    await expect(page.getByText('Bias-Free Ledger', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('One-click PDF report', { exact: true }).first()).toHaveCount(0)

    // Money — the read view: escrow wallet + proof-of-work milestones.
    await openTab(page, 'Money')
    await expect(page.getByText('MjengoPay escrow wallet', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Milestones — money tied to proof of work', { exact: true }).first()).toBeVisible()
    // Seeded milestone awaiting the client decision (seed-extras/money.ts).
    await expect(page.getByText('Walling to ring beam').first()).toBeVisible()

    // Documents — the Land tab's parcel record for this project.
    await openTab(page, 'Land')
    await expect(page.getByText('Parcels & title record', { exact: true }).first()).toBeVisible()
    // Seeded parcel (seed-extras/land.ts): open it and reach its documents.
    await page.getByText('LR No. 2090/1234').first().click()
    await expect(page.getByText('Documents', { exact: true }).first()).toBeVisible()
    // The parcel's seeded title deed document row.
    await expect(page.getByText('title-deed-2090-1234.pdf').first()).toBeVisible()
  })
})
