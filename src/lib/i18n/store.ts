import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Locale } from './types'
import { DEFAULT_LOCALE } from './types'

/**
 * Locale preference store (W4-I18N) — ONE source of truth for the UI language.
 *
 * This is the store the Settings tab has ALWAYS persisted under the key
 * `mjengo-os-settings` (W3-F3 stored the choice but didn't apply it). It has
 * been MOVED here from settings-tab.tsx unchanged in shape — same key, same
 * version, same partialize — so existing localStorage keeps working with no
 * migration. The settings radio consumes it; the I18nProvider consumes it;
 * nothing else writes it.
 *
 * Local-only display preference, never synced to the server (the app's
 * persisted-client-state pattern, cf. 'mjengo-os-store' in hooks/use-mjengo.ts).
 */
interface LocalePrefsState {
  /** UI language — read by the I18nProvider (the rendered locale). */
  language: Locale
  setLanguage: (l: Locale) => void
  /** Danger-zone reset (caller also clears the storage key). */
  resetLocale: () => void
}

export const useLocalePrefs = create<LocalePrefsState>()(
  persist(
    (set) => ({
      language: DEFAULT_LOCALE,
      setLanguage: (language) => set({ language }),
      resetLocale: () => set({ language: DEFAULT_LOCALE }),
    }),
    {
      // SAME persisted key W3-F3's settings tab introduced — a previously
      // saved {"language":"sw"} now simply starts working.
      name: 'mjengo-os-settings',
      version: 1,
      partialize: (s) => ({ language: s.language }),
    },
  ),
)
