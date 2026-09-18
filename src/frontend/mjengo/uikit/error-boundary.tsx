'use client'

import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import { useLocalePrefs } from '@/frontend/i18n/store'
import { translateForLocale } from '@/frontend/i18n/provider'
import type { Locale, TranslateFn } from '@/frontend/i18n/types'
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/frontend/i18n/types'
import { Button } from '@/frontend/ui/button'
import { Card, CardContent } from '@/frontend/ui/card'
import { RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'

/**
 * React error boundary (W3-F2 · MjengoOS UI kit).
 *
 * Catches render-time errors anywhere below it and swaps the subtree for a
 * friendly, honest card: what broke (the real error message), a Retry that
 * resets the boundary state (children remount and try again) and a Reload
 * app that hard-refreshes. Errors are logged to the console with the
 * `[mjengo-boundary]` prefix plus an optional `context` tag (e.g. the tab
 * id) so field debugging greps cleanly.
 *
 * The boundary does NOT catch event handlers, async callbacks or effects —
 * those are toast/error-card territory (the app's existing patterns).
 *
 * #152 — the fallback card is LOCALIZED (headline, buttons, reassurance and
 * the no-message fallback all resolve the uikit.* dict keys in the user's
 * locale), and it gets that locale WITHOUT the I18nProvider on purpose (see
 * ErrorFallback below). The route-level src/app/error.tsx keeps its
 * hardcoded bilingual EN/SW copy (its own docblock: route boundaries must
 * not depend on anything that may have crashed); this card, one layer down,
 * can and does better — the persisted locale store survives any React-tree
 * crash, so the worst-moment card still speaks the user's language.
 */
export interface ErrorBoundaryProps {
  children: ReactNode
  /** Fallback card headline override (default: the localized uikit.errorTitle). */
  title?: string
  /** Context tag logged with the error, e.g. `tab:money`. */
  context?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * The crash card — a FUNCTION component so it may use hooks while the class
 * boundary above stays a class (React allows hook-using function children
 * rendered by a class). Everything user-facing resolves the uikit.* dict
 * keys.
 *
 * DESIGN DECISION (#152) — locale WITHOUT I18nProvider context. The obvious
 * `useT()` here is the wrong tool: this card renders in the worst moment,
 * possibly when the provider itself has crashed, and `useT()` THROWS outside
 * a provider ("fail loud, not English") — a fallback that throws makes React
 * unmount the entire tree, trading a broken tab for a white screen. Instead
 * the card reads the persisted locale store directly (`useLocalePrefs` — a
 * module-level zustand store that needs no provider), the SAME source of
 * truth the I18nProvider reads, and resolves keys provider-free through
 * `translateForLocale`. Consequences, all verified honest:
 *  · healthy provider → identical strings to useT() (same store, same dicts);
 *  · crashed / absent provider → the card still renders in the user's locale;
 *  · no hydration-mismatch risk — the card only appears after a client-side
 *    render error, so there is no SSR markup to stay in parity with;
 *  · switching language while a crashed tab is showing re-renders the card
 *    in the new locale (zustand subscription), same as every useT() surface.
 */
function ErrorFallback({
  error,
  title,
  onRetry,
}: {
  error: Error
  title?: string
  onRetry: () => void
}) {
  const language = useLocalePrefs((s) => s.language)
  const locale: Locale = SUPPORTED_LOCALES.includes(language) ? language : DEFAULT_LOCALE
  const t: TranslateFn = (key, vars) => translateForLocale(locale, key, vars)

  const message = error.message || t('uikit.errorMessage')
  return (
    <Card className="border-destructive/30 shadow-sm" role="alert">
      <CardContent className="flex flex-col items-center gap-4 p-6 text-center">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-destructive/10"
          aria-hidden
        >
          <TriangleAlert className="h-6 w-6 text-destructive" />
        </span>
        <div className="max-w-md space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">
            {title ?? t('uikit.errorTitle')}
          </h2>
          <p className="break-words text-sm leading-relaxed text-muted-foreground">{message}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" className="min-h-11 gap-1.5" onClick={onRetry}>
            <RotateCcw className="h-4 w-4" aria-hidden /> {t('uikit.retry')}
          </Button>
          <Button className="min-h-11 gap-1.5" onClick={() => window.location.reload()}>
            <RefreshCw className="h-4 w-4" aria-hidden /> {t('uikit.reloadApp')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('uikit.reassurance')}</p>
      </CardContent>
    </Card>
  )
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // [mjengo-boundary] prefix + context — one grep finds every crash site.
    console.error(
      `[mjengo-boundary]${this.props.context ? ` ${this.props.context}` : ''} render error:`,
      error,
      info.componentStack,
    )
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          title={this.props.title}
          onRetry={() => this.setState({ error: null })}
        />
      )
    }
    return this.props.children
  }
}

/**
 * HOC: wrap a component in a boundary, optionally overriding the fallback
 * card (title) or the console context tag.
 *
 *   export const MoneyTab = withErrorBoundary(MoneyTabInner, { context: 'tab:money' })
 */
export function withErrorBoundary<P extends object>(
  Wrapped: ComponentType<P>,
  fallbackProps?: Omit<ErrorBoundaryProps, 'children'>,
) {
  const displayName = Wrapped.displayName ?? Wrapped.name ?? 'Component'
  function WithBoundary(props: P) {
    return (
      <ErrorBoundary {...fallbackProps}>
        <Wrapped {...props} />
      </ErrorBoundary>
    )
  }
  WithBoundary.displayName = `withErrorBoundary(${displayName})`
  return WithBoundary
}
