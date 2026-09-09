'use client'

/**
 * Root global error boundary (FE-3 · issue #80) — the last resort when the
 * ROOT LAYOUT itself fails (Next.js requirement: this file must render its
 * own <html>/<body>, so it imports NOTHING from the app tree that may have
 * crashed — no ui kit, no i18n, no fonts). Inline styles only, bilingual
 * EN/SW hardcoded, one Try-again button (reset()) + one hard reload.
 */

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[mjengo-boundary] global (root layout) render error:', error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f5f5f4' /* stone-100 */,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '24px',
          boxSizing: 'border-box',
        }}
      >
        <div
          role="alert"
          style={{
            maxWidth: '420px',
            width: '100%',
            background: '#fff',
            border: '1px solid #e7e5e4',
            borderRadius: '12px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
            padding: '32px',
            textAlign: 'center',
          }}
        >
          <h1
            style={{
              fontSize: '18px',
              fontWeight: 700,
              color: '#1c1917',
              margin: '0 0 8px',
            }}
          >
            MjengoOS could not start
          </h1>
          <p style={{ fontSize: '14px', color: '#57534e', lineHeight: 1.6, margin: 0 }}>
            Something went wrong before the app could load. Your data is safe.
            <br />
            Kuna hitilafu kabla programu haijazipakia. Data yako iko salama.
          </p>
          {error.digest && (
            <p
              style={{
                fontSize: '11px',
                color: '#78716c',
                fontFamily: 'ui-monospace, monospace',
                marginTop: '12px',
                wordBreak: 'break-all',
              }}
            >
              Error ref: {error.digest}
            </p>
          )}
          <div style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: '44px',
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid #d6d3d1',
                background: '#fff',
                color: '#1c1917',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try again · Jaribu tena
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                minHeight: '44px',
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid #1c1917',
                background: '#1c1917',
                color: '#fafaf9',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Reload · Pakia upya
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
