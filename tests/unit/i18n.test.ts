/**
 * i18n dictionary invariants (src/frontend/i18n — W4-I18N).
 *
 * The app ships English + Kiswahili dicts that are compile-time asserted to
 * carry the same key set (dicts/check.ts), but that guard only runs under
 * `tsc --noEmit` and the runtime dev guard only console.warns. These tests
 * fail the build when:
 *   · a key is added to one dictionary and forgotten in the other;
 *   · a component calls t() with a literal key no dictionary knows
 *     (sampled: settings-tab — the biggest consumer — plus the nav surface,
 *     and the W7 field-surface files: use-mjengo, sync-outbox-panel,
 *     materials/fundis/money/share — issue #79);
 *   · the canonical TAB_META navigation labels drift from the dicts (a
 *     missing tab label renders a raw key string in the navbar);
 *   · the {var} placeholder SET of a key drifts between en and sw (a
 *     translation that drops {name} would render the literal "{name}");
 *   · a W7 field-surface file regresses to a raw English toast literal
 *     instead of a t() call (the "no English toast on the field path"
 *     acceptance of issue #79).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { enDict } from '@/frontend/i18n/dicts/en'
import { swDict } from '@/frontend/i18n/dicts/sw'
import { translate } from '@/frontend/i18n/provider'
import { TAB_META } from '@/frontend/mjengo/nav/tab-meta'
import { ALL_TABS, KNOWN_ROLES, ROLE_LABELS } from '@/shared/permissions'

const enKeys = new Set(Object.keys(enDict))
const swKeys = new Set(Object.keys(swDict))

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

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

describe('en/sw values carry the same {var} placeholder set (issue #79)', () => {
  const placeholders = (s: string) =>
    [...String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',')

  it('every key interpolates the same vars in both languages', () => {
    for (const [k, v] of Object.entries(enDict)) {
      expect(placeholders(v), `en.${k} placeholder set`).toBe(placeholders(swDict[k]))
    }
    for (const [k, v] of Object.entries(swDict)) {
      expect(placeholders(v), `sw.${k} placeholder set`).toBe(placeholders(enDict[k]))
    }
  })
})

describe('W7 field surface (issue #79): every literal t() key resolves in both dictionaries', () => {
  // use-mjengo.ts uses a store-level t() (locale read imperatively) — the
  // literal-key sampling below covers it like any component.
  const FIELD_SURFACE_FILES = [
    'src/frontend/hooks/use-mjengo.ts',
    'src/frontend/mjengo/sync-outbox-panel.tsx',
    'src/frontend/mjengo/materials-tab.tsx',
    'src/frontend/mjengo/fundis-tab.tsx',
    'src/frontend/mjengo/share-dialog.tsx',
    'src/frontend/mjengo/money-tab.tsx',
  ] as const

  const literalKeysIn = (src: string) => [
    ...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  it('the samples actually found keys (guard against a silent regex drift)', () => {
    for (const file of FIELD_SURFACE_FILES) {
      const keys = literalKeysIn(readSrc(file))
      expect(keys.length, `${file} sampled no t() keys`).toBeGreaterThan(4)
    }
  })

  it('every sampled key exists in both dictionaries', () => {
    for (const file of FIELD_SURFACE_FILES) {
      for (const key of new Set(literalKeysIn(readSrc(file)))) {
        expect(enKeys.has(key), `en.ts is missing "${key}" (used by ${file})`).toBe(true)
        expect(swKeys.has(key), `sw.ts is missing "${key}" (used by ${file})`).toBe(true)
      }
    }
  })
})

describe('W7 field surface (issue #79): no raw English toast literals on the field path', () => {
  // A toast whose first argument starts with a quote is a raw string; a
  // template literal is tolerated ONLY when it starts with ${t( (the
  // aiReview.runFailed pattern). Variable/server passthroughs (json.error,
  // msg, ternaries around t()) are fine by construction.
  const RAW_TOAST = /toast\.(?:success|error|info|warning)\(\s*(?:['"]|`(?!\$\{t\())/g

  it('component files render every toast through t()', () => {
    const files = [
      'src/frontend/mjengo/sync-outbox-panel.tsx',
      'src/frontend/mjengo/materials-tab.tsx',
      'src/frontend/mjengo/fundis-tab.tsx',
      'src/frontend/mjengo/share-dialog.tsx',
      'src/frontend/mjengo/money-tab.tsx',
    ]
    for (const file of files) {
      const offending = [...readSrc(file).matchAll(RAW_TOAST)].map(() => file)
      expect(offending, `${file} still fires raw-literal toasts`).toEqual([])
    }
  })

  it('the W7 sync/dispatch toasts exist in both dictionaries (use-mjengo store-level t())', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    for (const key of [
      'sync.backOnlineDraining', 'sync.backOnlineConflicts', 'sync.backOnline',
      'sync.doneConflicts', 'sync.doneFailed', 'sync.doneOk', 'sync.retrying',
      'sync.readOnlyClient',
    ]) {
      expect(src.includes(`t('${key}'`), `use-mjengo.ts no longer uses ${key}`).toBe(true)
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
  })

  it('interpolates {vars} through the real translate() in both languages', () => {
    expect(translate(enDict, 'field.savedQueued', { count: 2 })).toBe('Saved on-device — queued (2)')
    expect(translate(swDict, 'field.savedQueued', { count: 2 })).toBe('Imehifadhiwa kwenye kifaa — (2) zinangojea kusawazishwa')
    expect(translate(enDict, 'sync.serverRefused', { reason: 'stale version' })).toBe('Server refused: stale version')
    expect(translate(swDict, 'sync.serverRefused', { reason: 'toleo la zamani' })).toBe('Seva imekataa: toleo la zamani')
  })
})

// ---------------------------------------------------------------------------
// #107 Kiswahili completion wave (audit FE-1/FE-6): the newly wired surfaces.
// Same literal-key sampling convention as the W7 field-surface block above —
// every literal t('…') key a wired file calls must resolve in BOTH dicts, and
// the dynamic enum-key families (land labels, intel severity) are pinned by
// enumerating the backend enum values they render.
// ---------------------------------------------------------------------------

describe('#107 wave: finder / intel / land surfaces — every literal t() key resolves in both dictionaries', () => {
  const literalKeysIn = (src: string) => [
    ...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g),
    ...src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g),
  ].map((m) => m[1])

  // Key-carrying object literals (TEMPLATES / tiles / options pattern) are
  // captured by scanning for the quoted namespace strings too.
  const namespaceStringsIn = (src: string) =>
    [...src.matchAll(/'(finder|intel|land)\.[a-zA-Z0-9_.]+'/g)].map((m) => m[0].slice(1, -1))

  const WAVE_SURFACES: Record<string, string[]> = {
    finder: [
      'src/frontend/mjengo/finder/sections/dashboard-section.tsx',
      'src/frontend/mjengo/finder/sections/search-section.tsx',
      'src/frontend/mjengo/finder/sections/requests-section.tsx',
      'src/frontend/mjengo/finder/sections/requests/request-card.tsx',
      'src/frontend/mjengo/finder/sections/requests/bits.tsx',
      'src/frontend/mjengo/finder/sections/search/bits.tsx',
    ],
    intel: [
      'src/frontend/mjengo/intel/bits.tsx',
      'src/frontend/mjengo/intel/sections/risk-section.tsx',
      'src/frontend/mjengo/intel/sections/digest-section.tsx',
      'src/frontend/mjengo/intel/sections/prices-section.tsx',
      'src/frontend/mjengo/intel/sections/reliability-section.tsx',
      'src/frontend/mjengo/intel/sections/suggestions-section.tsx',
      'src/frontend/mjengo/intel/sections/jobs-section.tsx',
    ],
    land: [
      'src/frontend/mjengo/land-tab.tsx',
      'src/frontend/mjengo/land/labels.ts',
      'src/frontend/mjengo/land/sections/parcels-section.tsx',
      'src/frontend/mjengo/land/sections/parcels/badges.tsx',
      'src/frontend/mjengo/land/sections/parcels/parcel-card.tsx',
      'src/frontend/mjengo/land/sections/parcels/parcel-detail.tsx',
      'src/frontend/mjengo/land/sections/parcels/property-passport.tsx',
      'src/frontend/mjengo/land/sections/parcels/timeline.tsx',
    ],
    dialogs: [
      'src/frontend/mjengo/create-project-dialog.tsx',
      'src/frontend/mjengo/expense-dialog.tsx',
      'src/frontend/mjengo/worker-dialogs.tsx',
    ],
    shell: [
      'src/frontend/mjengo/app.tsx',
      'src/frontend/mjengo/diaspora-banner.tsx',
    ],
  }

  it('each surface family samples enough keys (guards against silent wiring regressions)', () => {
    const minimums: Record<string, number> = { finder: 60, intel: 45, land: 80, dialogs: 60, shell: 8 }
    for (const [family, files] of Object.entries(WAVE_SURFACES)) {
      const keys = new Set(files.flatMap((f) => [...literalKeysIn(readSrc(f)), ...namespaceStringsIn(readSrc(f))]))
      expect(keys.size, `${family} surface sampled too few keys (${keys.size})`).toBeGreaterThan(minimums[family])
    }
  })

  it('every sampled key exists in both dictionaries', () => {
    for (const [family, files] of Object.entries(WAVE_SURFACES)) {
      for (const key of new Set(files.flatMap((f) => [...literalKeysIn(readSrc(f)), ...namespaceStringsIn(readSrc(f))]))) {
        expect(enKeys.has(key), `en.ts is missing "${key}" (used by the ${family} surface)`).toBe(true)
        expect(swKeys.has(key), `sw.ts is missing "${key}" (used by the ${family} surface)`).toBe(true)
      }
    }
  })

  it('no raw English toast literals on the newly wired finder/intel path', () => {
    const RAW_TOAST = /toast\.(?:success|error|info|warning)\(\s*(?:['"]|`(?!\$\{t\())/g
    const files = [...WAVE_SURFACES.finder, ...WAVE_SURFACES.intel]
    for (const file of files) {
      const offending = [...readSrc(file).matchAll(RAW_TOAST)].map(() => file)
      expect(offending, `${file} still fires raw-literal toasts`).toEqual([])
    }
  })
})

describe('#107 wave: dynamic enum label keys exist for every renderable value', () => {
  // land/labels.ts renders t(`land.parcelStatus.${status}`) etc. — the enums
  // live in the backend type modules and are pinned here so a new enum value
  // cannot ship without its en+sw label keys.
  const PARCEL_STATUSES = ['searching', 'verified', 'flagged']
  const MATCHES = ['pending', 'consistent', 'mismatch']
  const SEARCH_STATUSES = ['requested', 'received', 'reviewed']
  const DOC_KINDS = ['title_deed', 'search_cert', 'survey_map', 'other']
  const ASSIGN_ROLES = ['surveyor', 'advocate', 'engineer', 'qty_surveyor']
  const ASSIGN_STATUSES = ['invited', 'active', 'done', 'completed', 'withdrawn']
  const PRO_CATEGORIES = ['surveyor', 'advocate', 'engineer', 'qty_surveyor', 'architect', 'contractor']
  const LICENCE_BODIES = ['LSK', 'EBK', 'BORAQS', 'other']
  const CHECK_METHODS = ['document_review', 'reference_call', 'registry_lookup']
  const SEVERITIES = ['info', 'warning', 'critical']

  const expectBoth = (key: string) => {
    expect(enKeys.has(key), `en.ts is missing dynamic key "${key}"`).toBe(true)
    expect(swKeys.has(key), `sw.ts is missing dynamic key "${key}"`).toBe(true)
  }

  it('land enum labels resolve in both dictionaries', () => {
    PARCEL_STATUSES.forEach((s) => expectBoth(`land.parcelStatus.${s}`))
    PARCEL_STATUSES.forEach((s) => expectBoth(`land.parcelStatus.${s}.title`))
    MATCHES.forEach((m) => expectBoth(`land.match.${m}`))
    MATCHES.forEach((m) => expectBoth(`land.match.${m}.title`))
    SEARCH_STATUSES.forEach((s) => expectBoth(`land.searchStatus.${s}`))
    SEARCH_STATUSES.forEach((s) => expectBoth(`land.searchStatus.${s}.title`))
    DOC_KINDS.forEach((k) => expectBoth(`land.docKind.${k}`))
    ASSIGN_ROLES.forEach((r) => expectBoth(`land.assignRole.${r}`))
    ASSIGN_STATUSES.forEach((s) => expectBoth(`land.assignStatus.${s}`))
    PRO_CATEGORIES.forEach((c) => expectBoth(`land.proCategory.${c}`))
    LICENCE_BODIES.forEach((b) => expectBoth(`land.licenceBody.${b}`))
    CHECK_METHODS.forEach((m) => expectBoth(`land.checkMethod.${m}`))
    for (let level = 0; level <= 6; level++) {
      expectBoth(`land.ladder.${level}.label`)
      expectBoth(`land.ladder.${level}.hint`)
    }
  })

  it('intel severity labels resolve in both dictionaries', () => {
    SEVERITIES.forEach((s) => expectBoth(`intel.severity.${s}`))
  })
})

describe('#107 wave: onboarding-critical strings + client-facing copy', () => {
  it('share dead-link / network errors render through the dict (FE-6, issue #108)', () => {
    const src = readSrc('src/frontend/hooks/use-mjengo.ts')
    expect(src.includes("t('share.error.invalid')")).toBe(true)
    expect(src.includes("t('share.error.network')")).toBe(true)
    expect(enKeys.has('share.error.invalid')).toBe(true)
    expect(swKeys.has('share.error.invalid')).toBe(true)
    expect(enKeys.has('share.error.network')).toBe(true)
    expect(swKeys.has('share.error.network')).toBe(true)
    expect(src).not.toContain("'This share link is invalid or has been revoked'")
    expect(src).not.toContain("'Could not reach MjengoOS — check your connection'")
  })

  it('client banner + footer render through the dict (banner.* / footer.*)', () => {
    for (const key of [
      'banner.preview', 'banner.exit', 'banner.exitAria', 'banner.client',
      'footer.client.tagline', 'footer.client.siteTeam', 'footer.client.siteTeamAria',
      'footer.owner.tagline', 'footer.owner.copilot', 'footer.owner.payments', 'footer.owner.location',
    ]) {
      expect(enKeys.has(key), `en.ts is missing "${key}"`).toBe(true)
      expect(swKeys.has(key), `sw.ts is missing "${key}"`).toBe(true)
    }
  })

  it('the core dialogs translate their validation errors (spot values via the real translate())', () => {
    expect(translate(enDict, 'dialog.createProject.error.budget')).toBe('Budget must be greater than 0')
    expect(translate(swDict, 'dialog.createProject.error.budget')).toBe('Bajeti lazima iwe zaidi ya 0')
    expect(translate(enDict, 'dialog.expense.error.amount')).toBe('Amount must be greater than 0')
    expect(translate(swDict, 'dialog.expense.error.amount')).toBe('Kiasi lazima kiwe zaidi ya 0')
    expect(translate(swDict, 'dialog.createProject.toastOk')).toBe('Mradi umetengenezwa — karibu kazi!')
    expect(translate(swDict, 'land.parcels.record')).toBe('Rekodi kiwanja')
    expect(translate(swDict, 'finder.search.find')).toBe('Tafuta wasambazaji')
    expect(translate(swDict, 'intel.risk.title')).toBe('Hatari ya mradi')
  })
})
