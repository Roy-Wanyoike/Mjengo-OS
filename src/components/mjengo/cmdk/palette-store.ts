'use client'

import { create } from 'zustand'

/**
 * Command-palette open state (W3-F3).
 *
 * A tiny standalone zustand store (same client-state pattern as
 * use-mjengo.ts) so ANY component can open the palette without prop
 * drilling: the header button (header.tsx) sets it, the palette itself
 * (cmdk/command-palette.tsx) reads it and owns the global ⌘K shortcut.
 * Deliberately NOT persisted — transient UI state.
 */
interface CommandPaletteState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useCommandPalette = create<CommandPaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
