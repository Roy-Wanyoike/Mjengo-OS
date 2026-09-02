'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useLocalePrefs } from './store'
import { validateDicts } from './dicts/check'
import { enDict } from './dicts/en'
import { swDict } from './dicts/sw'
import type { Dict, Locale, TranslateFn } from './types'
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './types'

/**
 * I18n provider (W4-I18N · spec §62). Mounted in src/app/layout.tsx next to
 * (wrapping) the AuthSessionProvider — every surface below it, including the
 * login gate, can call useT().
 *
 * Rendering model (mirrors the app's existing persisted-store conventions —
 * cf. settings-tab.tsx / header.tsx useSyncExternalStore patterns):
 *  · SSR + the React hydration pass render the DEFAULT locale so server and
 *    client markup match (zustand persist has already rehydrated
 *    synchronously from localStorage on the client, but we deliberately don't
 *    read it until hydration completes).
 *  · The first post-hydration commit flips to the persisted locale, and every
 *    setLanguage() commit re-renders all consumers INSTANTLY (no reload).
 */

const DICTS: Record<Locale, Dict> = { en: enDict, sw: swDict }

interface I18nValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: TranslateFn
}

const I18nContext = createContext<I18nValue | null>(null)

/** Noop subscription — the canonical no-hydration-mismatch read-once pattern. */
const subscribeNoop = () => () => {}

/** True only after hydration (SSR snapshot false) — see settings-tab.tsx. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  )
}

/** Dev-only dict parity warnings (missing keys in either dictionary). */
if (process.env.NODE_ENV !== 'production') {
  validateDicts()
}

/** Runtime lookup + `{var}` interpolation. Missing key → the key itself. */
const warnedKeys = new Set<string>()
export function translate(dict: Dict, key: string, vars?: Record<string, string | number>): string {
  let value = dict[key]
  if (value === undefined) {
    if (process.env.NODE_ENV !== 'production' && !warnedKeys.has(key)) {
      warnedKeys.add(key)
      console.warn(`[i18n] missing key "${key}" — returning the key itself`)
    }
    value = key
  }
  if (vars) {
    for (const [name, v] of Object.entries(vars)) {
      value = value.split(`{${name}}`).join(String(v))
    }
  }
  return value
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = useLocalePrefs((s) => s.language)
  const setLanguage = useLocalePrefs((s) => s.setLanguage)
  const hydrated = useHydrated()

  // Server render + hydration pass: default locale (markup parity); the
  // post-hydration commit picks up the persisted preference.
  const locale: Locale = hydrated && SUPPORTED_LOCALES.includes(language) ? language : DEFAULT_LOCALE

  const t = useCallback<TranslateFn>(
    (key, vars) => translate(DICTS[locale], key, vars),
    [locale],
  )

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale: setLanguage, t }),
    [locale, setLanguage, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** i18n context hook — throws if used above the provider (fail loud, not English). */
export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n() must be used inside <I18nProvider>')
  return ctx
}

/** Convenience alias for components that only need the t() function. */
export function useT(): TranslateFn {
  return useI18n().t
}
