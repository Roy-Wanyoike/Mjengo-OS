import { expect, test } from '@playwright/test'
import { openTab, signIn } from './helpers'

/**
 * Persona 4 — PROCUREMENT OFFICER (Otieno, closed-loop supply chain).
 * Golden path (issue #182): sign in → lands on Finder → the procurement
 * dashboard → supplier search (Cement) → purchase requests & orders.
 *
 * Seed contract: procurement@mjengo.os / mjengo2026 — Finder/Materials/
 * Evidence, landing tab Finder (ROLE_LANDING). Seeded chain: MR-1042
 * (converted → PO-2026-000012 DELIVERING), MR-1043 (quotes requested),
 * MR-1044 (pending decision), MR-1045 (client-band), PO-2026-000009
 * (DELIVERED, 48-of-50 discrepancy), PO-2026-000013 (SENT, awaiting
 * supplier confirmation) — prisma/seed-extras/supply.ts.
 */
test.describe('Procurement — closed-loop supply golden path', () => {
  test('sign in → finder → requests → suppliers search → orders', async ({ page }) => {
    await signIn(page, 'procurement')

    // Lands on the Finder tab (ROLE_LANDING.procurement) — the panel is live.
    await expect(page.locator('#mjengo-panel-finder')).toBeVisible()

    // Procurement dashboard — the BOQ-lite view over seeded requests/orders.
    await expect(page.getByText('Procurement').first()).toBeVisible()

    // Requests — the seeded purchase request chain renders with its codes.
    await expect(page.getByText('Purchase requests & approvals').first()).toBeVisible()
    await expect(page.getByText('MR-1042').first()).toBeVisible()
    await expect(page.getByText('MR-1043').first()).toBeVisible()

    // Orders — the seeded PO cards in every state of the loop.
    await expect(page.getByText('PO-2026-000009').first()).toBeVisible()  // delivered (discrepancy)
    await expect(page.getByText('PO-2026-000012').first()).toBeVisible()  // delivering
    await expect(page.getByText('PO-2026-000013').first()).toBeVisible()  // sent, awaiting supplier

    // Suppliers search — run the real compare over the seeded catalog.
    await expect(page.getByText('Find Materials Near This Site').first()).toBeVisible()
    await page.locator('#finder-material').fill('Cement')
    await page.locator('#finder-qty').fill('100')
    // The search form's own CTA (unique aria-label) — the BOQ cards carry
    // five more "Find suppliers…" buttons that .first() would mis-click.
    await page.getByRole('button', { name: 'Find suppliers near this site' }).click()
    // Seeded suppliers stock cement (Nairobi Hardware Centre, Karioke…) — the
    // ranked results line appears with a real count.
    await expect(page.getByText(/suppliers? · ranked by weighted score/).first()).toBeVisible()
    await expect(page.getByText('Nairobi Hardware Centre').first()).toBeVisible()
  })
})
