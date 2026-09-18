/**
 * #130 (audit FE-5, WCAG 3.1.1 language-of-page) — <html lang> tracks the
 * active locale.
 *
 * The root layout is a SERVER component that statically renders lang="en"
 * (the SSR/hydration locale), while the live app can be Kiswahili. The fix is
 * a post-hydration client mutation of document.documentElement.lang, wired in
 * the I18nProvider (a useEffect keyed on [locale] calling the exported
 * syncHtmlLang writer), plus a pre-hydration nonce'd inline script in the
 * layout that mirrors public/offline.html for first-paint correctness.
 *
 * vitest is node-only by design (cf. frontend-a11y.test.ts / i18n.test.ts),
 * so this file mixes the two house styles:
 *   · BEHAVIORAL: the real writer (syncHtmlLang) runs against a stubbed
 *     minimal document — the "locale change → documentElement.lang updates"
 *     pin the issue asks for, in BOTH directions, plus the SSR no-document
 *     guard (never throws where there is no DOM);
 *   · SOURCE PINS: the wiring — the provider effect + its deps array, the
 *     layout's STATIC lang="en" + suppressHydrationWarning (rendering the
 *     store during SSR/hydration would be the hydration mismatch), the
 *     script-before-provider ordering, and the three-way store-key parity
 *     (layout inline script == offline.html == the zustand persist name).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncHtmlLang } from '@/frontend/i18n/provider'

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

/** Minimal DOM stand-in: only the surface syncHtmlLang touches. */
const fakeDocument = (startLang: string) => ({
  documentElement: { lang: startLang },
})

// ---------------- the writer (behavioral — real code, stubbed document) ----

describe('#130: syncHtmlLang — the html-lang writer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('flips documentElement.lang to the active locale (en → sw)', () => {
    const doc = fakeDocument('en')
    vi.stubGlobal('document', doc)
    syncHtmlLang('sw')
    expect(doc.documentElement.lang).toBe('sw')
  })

  it('flips it back on a locale switch (sw → en) — Settings changes are immediate', () => {
    const doc = fakeDocument('sw')
    vi.stubGlobal('document', doc)
    syncHtmlLang('en')
    expect(doc.documentElement.lang).toBe('en')
  })

  it('is a no-op without a document (SSR + this node-only suite never throw)', () => {
    // The node env has no `document` global — the writer must bail, not crash.
    expect(() => syncHtmlLang('sw')).not.toThrow()
  })
})

// ---------------- the provider wiring (source pins) ------------------------

describe('#130: I18nProvider keeps <html lang> in lockstep with the locale', () => {
  it('syncs inside a useEffect keyed on [locale] (post-hydration, re-runs on every switch)', () => {
    const src = readSrc('src/frontend/i18n/provider.tsx')
    expect(src).toContain('useEffect(() => {')
    expect(src).toContain('syncHtmlLang(locale)')
    // Deps are exactly [locale]: a Settings flip re-runs the effect; nothing
    // else re-triggers it.
    expect(src).toContain('}, [locale])')
  })

  it('the root layout keeps the STATIC lang="en" + suppressHydrationWarning — no render-time locale read, no hydration mismatch', () => {
    const src = readSrc('src/app/layout.tsx')
    // Static SSR/hydration markup (the effect above owns the live sync).
    expect(src).toContain('<html lang="en" suppressHydrationWarning>')
    // The layout is a server component: it must never read the client store
    // or render a dynamic lang — either would mismatch the hydrated DOM.
    expect(src).not.toContain('useLocalePrefs')
    expect(src).not.toMatch(/lang=\{/)
  })
})

// ---------------- first-paint parity with offline.html (source pins) -------

describe('#130: first-paint parity — the layout mirrors offline.html', () => {
  it("the layout's pre-hydration inline script reads the same store and flips to sw", () => {
    const src = readSrc('src/app/layout.tsx')
    // Same store key, same values as public/offline.html:12-19.
    expect(src).toContain("localStorage.getItem('mjengo-os-settings')")
    expect(src).toContain("s.state.language==='sw'")
    expect(src).toContain("document.documentElement.lang='sw'")
    // Unreadable storage (private mode / disabled) stays English, silently.
    expect(src).toContain('try{var s=JSON.parse(')
    expect(src).toContain('}catch(e){}')
  })

  it('the script is nonce’d (enforced CSP) and runs BEFORE the provider tree hydrates', () => {
    const src = readSrc('src/app/layout.tsx')
    expect(src).toMatch(/<script\s+nonce=\{nonce\}/)
    // Ordering pin: the lang flip precedes the provider that re-syncs it.
    const scriptAt = src.indexOf("localStorage.getItem('mjengo-os-settings')")
    const providerAt = src.indexOf('<I18nProvider>')
    expect(scriptAt).toBeGreaterThan(-1)
    expect(providerAt).toBeGreaterThan(scriptAt)
  })

  it('offline.html — the reference behavior — is unchanged (same key, same sw flip)', () => {
    const src = readSrc('public/offline.html')
    expect(src).toContain("localStorage.getItem('mjengo-os-settings')")
    expect(src).toContain("saved.state.language === 'sw'")
    expect(src).toContain("document.documentElement.lang = 'sw'")
  })

  it('three-way key parity: layout script == offline.html == the zustand persist name', () => {
    const store = readSrc('src/frontend/i18n/store.ts')
    expect(store).toContain("name: 'mjengo-os-settings'")
    // The functional read happens exactly ONCE per surface — the store key
    // can never silently drift apart between the three.
    const readOf = (src: string) =>
      (src.match(/localStorage\.getItem\('mjengo-os-settings'\)/g) ?? []).length
    expect(readOf(readSrc('src/app/layout.tsx'))).toBe(1)
    expect(readOf(readSrc('public/offline.html'))).toBe(1)
  })
})
