'use client'

/**
 * Route-level error boundary (FE-3 · issue #80) — Next.js App Router file
 * convention. Catches everything the per-tab boundary (app.tsx
 * `tab:<key>`) and the shell boundary (`shell:header`) do not: banners,
 * dialogs, footer, or a crash above the MjengoApp return gates. Without
 * this file those crashes hit Next's default "Application error" white
 * screen, hiding the offline queue state from a field user.
 *
 * Render matches the uikit ErrorBoundary fallback card (the app's card
 * style: stone-100 page, bordered Card, Retry + Reload) so all three
 * boundary layers read as one product. Copy is hardcoded bilingual
 * EN/SW — this file renders OUTSIDE the I18nProvider tree guarantee
 * (error boundaries must not depend on anything that may have crashed),
 * and the offline-critical audience is Kiswahili-first (audit 2-b FE-2).
 */

import { useEffect } from 'react'
import { Card, CardContent } from '@/frontend/ui/card'
import { Button } from '@/frontend/ui/button'
import { RotateCcw, RefreshCw, TriangleAlert } from 'lucide-react'

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Same greppable prefix as the uikit boundary: [mjengo-boundary].
    console.error('[mjengo-boundary] route render error:', error)
  }, [error])

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-stone-100 p-6"
      role="alert"
    >
      <Card className="max-w-md w-full border-stone-200 shadow-sm">
        <CardContent className="p-8 flex flex-col items-center text-center gap-4">
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-stone-200"
            aria-hidden
          >
            <TriangleAlert className="h-6 w-6 text-stone-600" />
          </span>
          <div className="space-y-1.5">
            <h1 className="text-lg font-bold text-stone-900">Something went wrong</h1>
            <p className="text-sm text-stone-600 leading-relaxed">
              MjengoOS hit an unexpected error. Your data is safe — offline
              changes stay queued on this device.
            </p>
            <p className="text-sm text-stone-600 leading-relaxed">
              Kuna hitilafu isiyotarajiwa. Data yako iko salama — mabadiliko ya
              nje ya mtandao bado yamehifadhiwa kwenye kifaa hiki.
            </p>
          </div>
          {error.digest && (
            <p className="text-xs text-stone-500 font-mono break-all">
              Error ref: {error.digest}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="outline" className="min-h-11 gap-1.5" onClick={reset}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Try again · Jaribu tena
            </Button>
            <Button className="min-h-11 gap-1.5" onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Reload · Pakia upya
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
