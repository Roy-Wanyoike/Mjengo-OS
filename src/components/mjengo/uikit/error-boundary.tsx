'use client'

import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
 */
export interface ErrorBoundaryProps {
  children: ReactNode
  /** Fallback card headline override (default: "Something went wrong"). */
  title?: string
  /** Context tag logged with the error, e.g. `tab:money`. */
  context?: string
}

interface ErrorBoundaryState {
  error: Error | null
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
      const message =
        this.state.error.message || 'An unexpected error occurred while rendering this section.'
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
                {this.props.title ?? 'Something went wrong'}
              </h2>
              <p className="break-words text-sm leading-relaxed text-muted-foreground">{message}</p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="outline"
                className="min-h-11 gap-1.5"
                onClick={() => this.setState({ error: null })}
              >
                <RotateCcw className="h-4 w-4" aria-hidden /> Retry
              </Button>
              <Button
                className="min-h-11 gap-1.5"
                onClick={() => window.location.reload()}
              >
                <RefreshCw className="h-4 w-4" aria-hidden /> Reload app
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Nothing was lost — the rest of MjengoOS keeps working.
            </p>
          </CardContent>
        </Card>
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
