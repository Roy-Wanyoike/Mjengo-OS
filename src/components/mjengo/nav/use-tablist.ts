'use client'

import { useRef } from 'react'
import type React from 'react'

/**
 * Roving-tabindex keyboard nav for a role="tablist" strip (W1-PERM a11y):
 * ArrowLeft/ArrowRight move focus (wrapping), Home/End jump to the ends,
 * Enter/Space/click activate. Only the focused tab stays tabbable.
 *
 * DOM-based (no per-tab refs): the hook queries `[role="tab"]` children of
 * the list element at keydown time, so it works for both the desktop strip
 * and the mobile bottom bar.
 */
export function useTablistKeyboard<T extends HTMLElement = HTMLElement>() {
  const listRef = useRef<T | null>(null)

  const onKeyDown = (e: React.KeyboardEvent) => {
    const root = listRef.current
    if (!root) return
    const tabs = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
    )
    if (tabs.length === 0) return

    const current = tabs.findIndex((t) => t === document.activeElement)
    let next = -1
    if (e.key === 'ArrowRight') next = current < 0 ? 0 : (current + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return

    e.preventDefault()
    // Roving tabindex: exactly one tab stops the Tab key — the focused one.
    tabs.forEach((t, i) => { t.tabIndex = i === next ? 0 : -1 })
    tabs[next]?.focus()
  }

  return { listRef, onKeyDown }
}
