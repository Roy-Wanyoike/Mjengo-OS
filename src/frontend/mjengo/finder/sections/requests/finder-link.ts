'use client'

// Cross-section link store for the Finder tab. finder-tab.tsx is the
// composition root (sections are siblings, no shared props), so the
// hand-offs ride this tiny zustand store instead:
//   · search-section "Add to Project Order" → requests-section create dialog
//   · dashboard BOQ "Find remaining"        → search-section inputs (the
//     search inputs LIVE here — no props-to-state syncing effects needed)
// Consumed by the sections that own the receiving UI; the store stays local
// to the Finder tab's sections.

import { create } from 'zustand'

export interface RequestPrefillLine {
  materialName: string
  unit: string
  qty: number
}

interface FinderLinkState {
  // ---- search inputs (owned here so the dashboard can prefill them) ----
  material: string
  qty: string
  radius: string
  day: string
  setMaterial: (v: string) => void
  setQty: (v: string) => void
  setRadius: (v: string) => void
  setDay: (v: string) => void
  /** Dashboard BOQ "Find remaining" → prefill the search inputs. */
  setSearchPrefill: (prefill: { materialName: string; qty: number }) => void

  // ---- create-request dialog trigger (search "Add to Project Order") ----
  requestPrefill: RequestPrefillLine[] | null
  requestDialogOpen: boolean
  requestDialogNonce: number
  openRequestDialog: (lines?: RequestPrefillLine[]) => void
  clearRequestDialog: () => void
}

export const useFinderLink = create<FinderLinkState>()((set) => ({
  material: '',
  qty: '50',
  radius: 'any',
  day: 'any',
  setMaterial: (v) => set({ material: v }),
  setQty: (v) => set({ qty: v }),
  setRadius: (v) => set({ radius: v }),
  setDay: (v) => set({ day: v }),
  setSearchPrefill: (prefill) =>
    set({ material: prefill.materialName, qty: prefill.qty > 0 ? String(prefill.qty) : '1' }),

  requestPrefill: null,
  requestDialogOpen: false,
  requestDialogNonce: 0,
  openRequestDialog: (lines) =>
    set((s) => ({
      requestPrefill: lines && lines.length ? lines : null,
      requestDialogOpen: true,
      requestDialogNonce: s.requestDialogNonce + 1,
    })),
  clearRequestDialog: () => set({ requestPrefill: null, requestDialogOpen: false }),
}))
