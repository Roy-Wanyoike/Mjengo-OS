/**
 * i18n dictionary invariants (src/frontend/i18n — W4-I18N).
 *
 * The app ships English + Kiswahili dicts that are compile-time asserted to
 * carry the same key set (dicts/check.ts), but that guard only runs under
 * `tsc --noEmit` and the runtime dev guard only console.warns. These tests
 * fail the build when:
 *   · a key is added to one dictionary and forgotten in the other;
 *   · a component calls t() with a literal key no dictionary knows
 *     (sampled: settings-tab — the biggest consumer — plus the nav surface);
 *   · the canonical TAB_META navigation labels drift from the dicts (a
 *     missing tab label renders a raw key string in the navbar).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { TAB_META } from '@/frontend/mjengo/nav/tab-meta'
import { ALL_TABS, KNOWN_ROLES, ROLE_LABELS } from '@/shared/permissions'

const enKeys = new Set(Object.keys(enDict))
const swKeys = new Set(Object.keys(swDict))

describe('en/sw dictionaries carry the exact same key set', () => {
  it('sw is missing nothing that en has', () => {
    const missing = [...enKeys].filter((k) => !swKeys.has(k))
    expect(missing, 'keys missing from sw.ts').toEqual([])
  })

  it('en is missing nothing that sw has', () => {
    const missing = [...swKeys].filter((k) => !enKeys.has(k))
    expect(missing, 'keys missing from en.ts').toEqual([])
  })

  it('every value in both dictionaries is a non-empty string', () => {
    for (const [k, v] of Object.entries(enDict)) {
      expect(typeof v === 'string' && v.trim().length > 0, `en.${k}`).toBe(true)
    }
    for (const [k, v] of Object.entries(swDict)) {
      expect(typeof v === 'string' && v.trim().length > 0, `sw.${k}`).toBe(true)
    }
  })
})

describe('navigation: every tab renders a label in both languages', () => {
  it('TAB_META covers exactly the tab universe (no orphan tabs, no dead meta)', () => {
    expect([...new Set(TAB_META.map((m) => m.key))].sort()).toEqual([...ALL_TABS].sort())
  })

  it('every full label key exists in both dictionaries', () => {
    for (const meta of TAB_META) {
      expect(enKeys.has(meta.label), `en is missing nav label "${meta.label}"`).toBe(true)
      expect(swKeys.has(meta.label), `sw is missing nav label "${meta.label}"`).toBe(true)
    }
  })

  it('every compact mobile label key exists in both dictionaries', () => {
    for (const meta of TAB_META) {
      expect(enKeys.has(meta.shortLabel), `en is missing short label "${meta.shortLabel}"`).toBe(true)
      expect(swKeys.has(meta.shortLabel), `sw is missing short label "${meta.shortLabel}"`).toBe(true)
    }
  })
})

describe('settings tab: every literal t() key resolves in both dictionaries', () => {
  const settingsSrc = readFileSync(
    fileURLToPath(new URL('../../src/frontend/mjengo/settings-tab.tsx', import.meta.url)),
    'utf8',
  )
  // Literal keys: t('settings.title'), t("login.email"), … (template-literal
  // dynamic keys are covered separately below).
  const literalKeys = [
    ...settingsSrc.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...settingsSrc.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  it('the sample actually found keys (guard against a silent regex drift)', () => {
    expect(literalKeys.length).toBeGreaterThan(20)
  })

  it('every sampled key exists in both dictionaries', () => {
    expect(literalKeys.length).toBeGreaterThan(0)
    for (const key of new Set(literalKeys)) {
      expect(enKeys.has(key), `en.ts is missing "${key}" (used by settings-tab)`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}" (used by settings-tab)`).toBe(true)
    }
  })

  it("dynamic t(`role.${role}`) keys exist for every role the UI can render", () => {
    const roleKeySource = [...Object.keys(ROLE_LABELS), ...KNOWN_ROLES]
    for (const role of new Set(roleKeySource)) {
      expect(enKeys.has(`role.${role}`), `en.ts is missing dynamic key "role.${role}"`).toBe(true)
      expect(swKeys.has(`role.${role}`), `sw.ts is missing dynamic key "role.${role}"`).toBe(true)
    }
    expect(enKeys.has('role.unknown')).toBe(true)
    expect(swKeys.has('role.unknown')).toBe(true)
  })
})
