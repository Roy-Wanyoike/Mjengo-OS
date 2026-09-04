'use client'

// MjengoOS Finder tab — composition root: renders the dashboard, search,
// requests and invoices sections from ./finder/sections/ (supplier search +
// compare, requests + approvals + orders + delivery, invoices, procurement
// dashboard).

import { SearchSection } from '@/frontend/mjengo/finder/sections/search-section'
import { RequestsSection } from '@/frontend/mjengo/finder/sections/requests-section'
import { InvoicesSection } from '@/frontend/mjengo/finder/sections/invoices-section'
import { DashboardSection } from '@/frontend/mjengo/finder/sections/dashboard-section'

export function FinderTab() {
  return (
    <div className="space-y-6">
      <DashboardSection />
      <SearchSection />
      <RequestsSection />
      <InvoicesSection />
    </div>
  )
}
