'use client'

import { useState } from 'react'
import { Camera, MoreHorizontal, HardHat } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { usePermissions } from '@/lib/permissions'
import { metaForAll, type TabMeta } from '@/components/mjengo/nav/tab-meta'
import { useTablistKeyboard } from '@/components/mjengo/nav/use-tablist'
import { useT } from '@/lib/i18n/provider'
import type { TabKey } from '@/components/mjengo/app'

/**
 * Mobile (<768px) bottom navigation (W1-PERM · Doc B §53 responsive,
 * §54 mobile navigation): up to 5 primary tabs for the role, a camera
 * quick-action (only for roles whose tab set includes the AI Copilot —
 * §56: never show buttons the role cannot use), and a "More" sheet for
 * the remaining tabs. Bottom safe-area inset respected. Hidden on md+
 * where the desktop top strip takes over (header.tsx).
 *
 * Role visibility = src/lib/permissions.ts (client mirror of guard.ts);
 * the backend remains the authority.
 */
export function MobileBottomNav({
  tab,
  onTabChange,
}: {
  tab: TabKey
  onTabChange: (t: TabKey) => void
}) {
  const { tabs } = usePermissions()
  const t = useT()
  const [moreOpen, setMoreOpen] = useState(false)
  const { listRef, onKeyDown } = useTablistKeyboard<HTMLDivElement>()

  const visible = tabs // never empty: unknown roles fail closed to ['overview']
  // Camera shares a cell with "More": cap primary tabs at 4 when either is
  // shown; otherwise 5 (task rule: ≤5 primary tabs for the role).
  const hasCamera = visible.includes('copilot')
  const moreNeeded = visible.length > 5
  const primaryCount = hasCamera || moreNeeded ? Math.min(4, visible.length) : Math.min(5, visible.length)
  const primary = visible.slice(0, primaryCount)
  const overflow = visible.slice(primaryCount)

  const overflowActive = overflow.includes(tab)

  return (
    <nav aria-label={t('nav.aria.main')} className="md:hidden fixed inset-x-0 bottom-0 z-40 bg-stone-950 border-t border-stone-800">
      <div
        className="flex items-stretch pb-[env(safe-area-inset-bottom)]"
        onKeyDown={onKeyDown}
        ref={listRef}
      >
        {/* Primary tabs (roving tabindex; arrows/Home/End in use-tablist) */}
        <ul role="tablist" aria-label={t('nav.aria.primary')} className="flex flex-1 min-w-0 items-stretch">
          {metaForAll(primary).map(({ key, shortLabel, icon: Icon }) => {
            const active = tab === key
            return (
              <li key={key} className="flex-1 min-w-0 flex">
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onTabChange(key)}
                  aria-label={t(shortLabel)}
                  className={`flex-1 min-w-0 min-h-14 py-1.5 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                    active ? 'text-amber-500' : 'text-stone-400 hover:text-stone-100'
                  }`}
                >
                  <Icon className="w-5 h-5 shrink-0" aria-hidden />
                  <span className="text-[11px] font-medium leading-none truncate max-w-full px-1">{t(shortLabel)}</span>
                  <span
                    aria-hidden
                    className={`h-0.5 w-6 rounded-full ${active ? 'bg-amber-500' : 'bg-transparent'}`}
                  />
                </button>
              </li>
            )
          })}
        </ul>

        {/* Camera quick-action — only for roles that have the Copilot tab */}
        {hasCamera && (
          <button
            type="button"
            onClick={() => onTabChange('copilot')}
            aria-label={t('nav.quickPhoto')}
            title={t('nav.quickPhotoHint')}
            className={`shrink-0 w-14 min-h-14 flex flex-col items-center justify-center gap-0.5 transition-colors ${
              tab === 'copilot' ? 'text-amber-500' : 'text-stone-400 hover:text-stone-100'
            }`}
          >
            <span
              aria-hidden
              className={`w-11 h-11 -mt-3 rounded-full flex items-center justify-center border-4 border-stone-950 shadow-lg ${
                tab === 'copilot' ? 'bg-amber-600 text-stone-50' : 'bg-amber-500 text-stone-950'
              }`}
            >
              <Camera className="w-5 h-5" />
            </span>
            <span className="sr-only">{t('nav.quickPhotoSr')}</span>
          </button>
        )}

        {/* More — the rest of the role's tabs */}
        {overflow.length > 0 && (
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-label={t('nav.moreAria', { count: overflow.length })}
              aria-haspopup="dialog"
              className={`shrink-0 w-14 min-h-14 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                overflowActive ? 'text-amber-500' : 'text-stone-400 hover:text-stone-100'
              }`}
            >
              <MoreHorizontal className={`w-5 h-5 shrink-0 ${overflowActive ? 'fill-amber-500' : ''}`} aria-hidden />
              <span className="text-[11px] font-medium leading-none">{t('nav.more')}</span>
              <span aria-hidden className={`h-0.5 w-6 rounded-full ${overflowActive ? 'bg-amber-500' : 'bg-transparent'}`} />
            </button>
            <SheetContent side="bottom" className="rounded-t-2xl p-0 gap-0 pb-[env(safe-area-inset-bottom)]">
              <SheetHeader className="p-4 pb-2 border-b border-stone-100">
                <SheetTitle className="text-base text-stone-900 flex items-center gap-2">
                  <HardHat className="w-4 h-4 text-amber-600" aria-hidden /> {t('nav.moreTabs')}
                </SheetTitle>
                <SheetDescription className="text-xs text-stone-400">
                  {t('nav.moreTabsDesc', { overflow: overflow.length, total: visible.length })}
                </SheetDescription>
              </SheetHeader>
              <ul
                className="max-h-[60vh] overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full"
                aria-label={t('nav.aria.moreItems')}
              >
                {metaForAll(overflow).map(({ key, label, icon: Icon }: TabMeta) => {
                  const active = tab === key
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => {
                          onTabChange(key)
                          setMoreOpen(false)
                        }}
                        className={`w-full text-left flex items-center gap-3 px-4 min-h-11 py-3 border-b border-stone-100 last:border-b-0 transition-colors ${
                          active ? 'bg-amber-50' : 'hover:bg-stone-50'
                        }`}
                      >
                        <Icon className={`w-5 h-5 shrink-0 ${active ? 'text-amber-600' : 'text-stone-500'}`} aria-hidden />
                        <span className={`text-sm ${active ? 'font-semibold text-stone-900' : 'font-medium text-stone-700'}`}>
                          {t(label)}
                        </span>
                        {active && <span className="ml-auto text-[11px] font-bold text-amber-700">{t('nav.active')}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </SheetContent>
          </Sheet>
        )}
      </div>
    </nav>
  )
}
