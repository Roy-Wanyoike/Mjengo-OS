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
} from '@/components/ui/command'
import { useMjengo } from '@/hooks/use-mjengo'
import { usePermissions, tabsForRole } from '@/lib/permissions'
import { metaForAll } from '@/components/mjengo/nav/tab-meta'
import type { TabKey } from '@/components/mjengo/app'
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
      title="Command palette"
      description="Navigate tabs, switch projects and run quick actions"
    >
      <CommandInput placeholder="Type a command or search…" aria-label="Command palette search" />
      <CommandList className="max-h-96">
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Navigate">
          {metaForAll(surfaceTabs).map(({ key, label, icon: Icon }) => (
            <CommandItem
              key={key}
              value={`tab ${key} ${label}`}
              className="min-h-11"
              onSelect={() => go(key)}
            >
              <Icon aria-hidden />
              <span>{label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {switchable.length > 0 && (
          <CommandGroup heading="Project">
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
                <span className="truncate">Switch to {p.name}</span>
                <CommandShortcut>{p.progressPct}%</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {hasActions && (
          <CommandGroup heading="Actions">
            {showLogExpense && (
              <CommandItem
                value="log expense record receipt spend money"
                className="min-h-11"
                onSelect={() => {
                  go('overview')
                  toast.info('Record expense lives on the Overview toolbar')
                }}
              >
                <ReceiptText aria-hidden />
                <span>Log expense</span>
                <CommandShortcut>Overview</CommandShortcut>
              </CommandItem>
            )}
            {showAddTask && (
              <CommandItem
                value="add task site plan todo board"
                className="min-h-11"
                onSelect={() => {
                  go('site')
                  toast.info('Add task lives on the Site Plan toolbar')
                }}
              >
                <ListPlus aria-hidden />
                <span>Add task</span>
                <CommandShortcut>Site Plan</CommandShortcut>
              </CommandItem>
            )}
            {showTakePhoto && (
              <CommandItem
                value="take photo ai copilot camera capture"
                className="min-h-11"
                onSelect={() => go('copilot')}
              >
                <Camera aria-hidden />
                <span>Take photo</span>
                <CommandShortcut>AI Copilot</CommandShortcut>
              </CommandItem>
            )}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
