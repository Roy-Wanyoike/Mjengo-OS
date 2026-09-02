import type { Dict } from '../types'
import { enDict } from './en'
import { swDict } from './sw'

/**
 * Dictionary parity guard (W4-I18N).
 *
 * Compile-time: the two assignments below only type-check when BOTH dicts
 * carry exactly the same key set — adding a key to one but not the other
 * fails `bunx tsc --noEmit` with the message string as the error hint.
 *
 * Runtime (dev only): validateDicts() is called once from the provider and
 * console.warns any drift that slipped past the compiler (e.g. dynamic keys).
 */

type KeysOf<T> = (keyof T) & string
type MissingInSw = Exclude<KeysOf<typeof enDict>, KeysOf<typeof swDict>>
type MissingInEn = Exclude<KeysOf<typeof swDict>, KeysOf<typeof enDict>>

/** Compile-time assertion: the type is `true` only when the union is never. */
type AssertAllPresent<Missing, Msg extends string> = [Missing] extends [never] ? true : Msg

const _swHasEveryEnKey: AssertAllPresent<MissingInSw, 'sw.ts is missing keys that en.ts has — keep the dicts in sync'> = true
const _enHasEverySwKey: AssertAllPresent<MissingInEn, 'en.ts is missing keys that sw.ts has — keep the dicts in sync'> = true
void _swHasEveryEnKey
void _enHasEverySwKey

/** Dev-only runtime guard: warns (once per call) about dict key-set drift. */
export function validateDicts(): void {
  const enKeys = new Set(Object.keys(enDict as Dict))
  const swKeys = new Set(Object.keys(swDict as Dict))
  const missingSw = [...enKeys].filter((k) => !swKeys.has(k))
  const missingEn = [...swKeys].filter((k) => !enKeys.has(k))
  if (missingSw.length > 0) {
    console.warn('[i18n] sw dictionary is missing keys:', missingSw)
  }
  if (missingEn.length > 0) {
    console.warn('[i18n] en dictionary is missing keys:', missingEn)
  }
}
