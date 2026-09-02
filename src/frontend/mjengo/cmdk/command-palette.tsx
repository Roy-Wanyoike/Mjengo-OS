'use client'

import { useEffect } from 'react'
import { toast } from 'sonner'
import { Building2, Camera, ListPlus, ReceiptText } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/frontend/ui/command'
import { useMjengo } from '@/frontend/hooks/use-mjengo'
import { usePermissions, tabsForRole } from '@/shared/permissions'
import { metaForAll } from '@/frontend/mjengo/nav/tab-meta'
import type { TabKey } from '@/frontend/mjengo/app'
import { useT } from '@/frontend/i18n/provider'
import { useCommandPalette } from './palette-store'

/**
 * ⌘K command palette (W3-F3 · shadcn Command primitives / cmdk).
 *
 * Mounted once at the app root (app.tsx) so the shortcut works on every
 * surface. Focus trap + Escape are handled by the underlying Radix dialog.
 *
 * HONEST capability list — every entry does something that exists today:
 *  · Navigate — the tabs the CURRENT surface can see (ROLE_TABS mirror;
 *    share/client surface → client tab set, exactly like app.tsx). Selecting
 *    dispatches the existing 'mjengo:tab' CustomEvent (spec §80) which
 *    app.tsx honors only for allowed tabs (fail closed).
 *  · Project — "Switch to <name>" when the app state has >1 project; calls
 *    the existing useMjengo.switchProject(). Skipped gracefully otherwise.
 *  · Actions — the three quick actions that genuinely exist:
 *      – Log expense → Overview tab (the Record expense toolbar button +
 *        its dialog live there; there is no global dialog state — honest
 *        navigation + a pointer toast, no invented behavior).
 *      – Add task → Site Plan tab (the Add-task dialog is local to
 *        site-plan-tab.tsx).
 *      – Take photo → AI Copilot tab (the camera capture surface; mirrors the
 *        mobile bottom-nav quick action, shown only for copilot-capable
 *        roles).
 */

/** True while the user is typing in a form field (⌘K must not hijack it). */
function isTyping(el: Element | null): boolean {
  if (el instanceof HTMLElement && el.isContentEditable) return true
  const tag = el?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** True when any Radix dialog/sheet/popover surface is already open. */
function anyDialogOpen(): boolean {
  return document.querySelector('[data-state="open"][role="dialog"]') !== null
}

export function CommandPalette() {
  const open = useCommandPalette((s) => s.open)
  const setOpen = useCommandPalette((s) => s.setOpen)
  const t = useT()
  const { data, projects, activeProjectId, viewMode, shareToken, clientRole, switchProject } = useMjengo()
  const { tabs: roleTabs } = usePermissions()

  // Mirror app.tsx's surface derivation (single sources: useMjengo + session).
  const isClientSurface = viewMode === 'client' && (Boolean(shareToken) || clientRole)
  const surfaceTabs: readonly TabKey[] = isClientSurface ? tabsForRole('client') : roleTabs

  // Global ⌘K (macOS) / Ctrl+K — ignored while typing or when a dialog is
  // already open (checked via document.activeElement + open Radix surfaces).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (isTyping(document.activeElement) || anyDialogOpen()) return
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  /** Tab navigation via the existing cross-component event (app.tsx owns the tab state). */
  function go(tab: TabKey) {
    window.dispatchEvent(new CustomEvent('mjengo:tab', { detail: { tab } }))
    setOpen(false)
  }

  const activeId = activeProjectId ?? data?.project.id ?? null
  const switchable = projects.filter((p) => p.id !== activeId)

  // Honest action visibility: quick actions only where the target surface
  // genuinely exists for this role/surface.
  const showLogExpense = !isClientSurface && surfaceTabs.includes('overview')
  const showAddTask = !isClientSurface && surfaceTabs.includes('site')
  const showTakePhoto = surfaceTabs.includes('copilot')
  const hasActions = showLogExpense || showAddTask || showTakePhoto

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t('palette.title')}
      description={t('palette.desc')}
    >
      <CommandInput placeholder={t('palette.placeholder')} aria-label={t('palette.aria')} />
      <CommandList className="max-h-96">
        <CommandEmpty>{t('palette.empty')}</CommandEmpty>

        <CommandGroup heading={t('palette.group.navigate')}>
          {metaForAll(surfaceTabs).map(({ key, label, icon: Icon }) => (
            <CommandItem
              key={key}
              value={`tab ${key} ${label}`}
              className="min-h-11"
              onSelect={() => go(key)}
            >
              <Icon aria-hidden />
              <span>{t(label)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {switchable.length > 0 && (
          <CommandGroup heading={t('palette.group.project')}>
            {switchable.map((p) => (
              <CommandItem
                key={p.id}
                value={`project switch ${p.name} ${p.location}`}
                className="min-h-11"
                onSelect={() => {
                  void switchProject(p.id)
                  setOpen(false)
                }}
              >
                <Building2 aria-hidden />
                <span className="truncate">{t('palette.switchTo', { name: p.name })}</span>
                <CommandShortcut>{p.progressPct}%</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {hasActions && (
          <CommandGroup heading={t('palette.group.actions')}>
            {showLogExpense && (
              <CommandItem
                value="log expense record receipt spend money"
                className="min-h-11"
                onSelect={() => {
                  go('overview')
                  toast.info(t('palette.toast.expense'))
                }}
              >
                <ReceiptText aria-hidden />
                <span>{t('palette.action.logExpense')}</span>
                <CommandShortcut>{t('nav.overview')}</CommandShortcut>
              </CommandItem>
            )}
            {showAddTask && (
              <CommandItem
                value="add task site plan todo board"
                className="min-h-11"
                onSelect={() => {
                  go('site')
                  toast.info(t('palette.toast.task'))
                }}
              >
                <ListPlus aria-hidden />
                <span>{t('palette.action.addTask')}</span>
                <CommandShortcut>{t('nav.site')}</CommandShortcut>
              </CommandItem>
            )}
            {showTakePhoto && (
              <CommandItem
                value="take photo ai copilot camera capture"
                className="min-h-11"
                onSelect={() => go('copilot')}
              >
                <Camera aria-hidden />
                <span>{t('palette.action.takePhoto')}</span>
                <CommandShortcut>{t('nav.copilot')}</CommandShortcut>
              </CommandItem>
            )}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
