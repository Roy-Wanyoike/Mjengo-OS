'use client'

// MjengoOS Finder tab (placeholder — agent 2-c replaces search/requests/
// dashboard sections, 2-d replaces invoices-section; this file stays the
// composition root). Sections: supplier search + compare, requests +
// approvals + orders + delivery, invoices, procurement dashboard.

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
