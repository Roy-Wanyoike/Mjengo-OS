/**
 * i18n core types (W4-I18N · spec §62 — English + Kiswahili, designed so a
 * future language is a new dict file + one registry entry, nothing else).
 *
 * Dictionaries are FLAT with dot-notation keys (e.g. 'nav.overview') — no
 * nested lookups, trivially diffable between locales, and the compile-time
 * guard in dicts/check.ts asserts both dicts carry exactly the same key set.
 */

/** Locales the app ships today. Adding one = new dict + registry entry. */
export type Locale = 'en' | 'sw'

/** Flat dictionary: dot-notation key → user-facing string. */
export type Dict = Record<string, string>

/**
 * Translation function shape: resolves a key in the active locale, interpolates
 * `{var}` placeholders from `vars`, and falls back to the key itself when the
 * key is missing (dev build warns once — see provider.tsx).
 */
export type TranslateFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string

/** Default/fallback locale — also the SSR render locale (see provider.tsx). */
export const DEFAULT_LOCALE: Locale = 'en'

/** The locales we have dicts for, wired into the provider's registry. */
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'sw']
