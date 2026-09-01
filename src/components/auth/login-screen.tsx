'use client'

import { useState } from 'react'
import { signIn } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { HardHat, LockKeyhole, LogIn, Mail } from 'lucide-react'

interface DemoAccount {
  email: string
  password: string
  label: string
  hint: string
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  { email: 'contractor@mjengo.os', password: 'mjengo2026', label: 'Contractor', hint: 'Site Manager — full site app (all tabs)' },
  { email: 'client@mjengo.os', password: 'mjengo2026', label: 'Client', hint: 'Amina — Nyumba Yangu client view' },
  { email: 'admin@mjengo.os', password: 'admin2026', label: 'Admin', hint: 'Mjengo Admin — everything + feature flags' },
  { email: 'finance@mjengo.os', password: 'mjengo2026', label: 'Finance', hint: 'Fatuma — Money/Finder/Evidence, lands on Money' },
  { email: 'supervisor@mjengo.os', password: 'mjengo2026', label: 'Supervisor', hint: 'Wanjiru — site tabs + Copilot/USSD, no Money/Land/Intel' },
  { email: 'procurement@mjengo.os', password: 'mjengo2026', label: 'Procurement', hint: 'Otieno — Finder/Materials/Evidence, lands on Finder' },
  { email: 'qs@mjengo.os', password: 'mjengo2026', label: 'QS', hint: 'Kariuki — Site Plan/Materials/Finder/Evidence, lands on Materials' },
]

/**
 * Full-screen login gate for the owner app. Share-link clients never see this
 * (the /?share=<token> view boots with no login) — this seals the
 * "Site team? Open the full app" flow.
 */
export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setError(null)
    if (!email.trim() || !password) {
      setError('Enter your email and password')
      return
    }
    setBusy(true)
    try {
      const res = await signIn('credentials', {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
      })
      if (res?.error) {
        // next-auth v4 returns the generic "CredentialsSignin" code for a wrong
        // email/password, but real messages thrown by authorize() (W1-SEC's
        // lockout: "Too many attempts — locked for 15 min. Try again later.")
        // arrive verbatim in res.error — surface those honestly instead of
        // masking them as a wrong password.
        setError(
          res.error === 'CredentialsSignin' || !res.error.trim()
            ? 'Wrong email or password — try a demo account below'
            : res.error,
        )
        setBusy(false)
        return
      }
      // Session cookie is set — reload so useSession boots the app for the role
      window.location.reload()
    } catch {
      setError('Could not reach MjengoOS — check your connection')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-start sm:justify-center bg-stone-100 p-4 sm:p-6 overflow-y-auto">
      <main className="w-full max-w-md" aria-label="Sign in to MjengoOS">
        <Card className="border-stone-200 shadow-lg">
          <CardContent className="p-6 sm:p-8">
            <div className="flex flex-col items-center text-center gap-2 mb-6">
              <div className="w-14 h-14 bg-amber-500 rounded-xl flex items-center justify-center shadow-md" aria-hidden>
                <HardHat className="w-8 h-8 text-stone-950" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-stone-900">MjengoOS</h1>
              <p className="text-sm text-stone-500">Construction Site OS · Kenya</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="login-email" className="text-stone-700">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" aria-hidden />
                  <Input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    placeholder="you@mjengo.os"
                    className="pl-9 min-h-11 bg-white border-stone-300"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={busy}
                    aria-label="Email address"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="login-password" className="text-stone-700">Password</Label>
                <div className="relative">
                  <LockKeyhole className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" aria-hidden />
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    className="pl-9 min-h-11 bg-white border-stone-300"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                    aria-label="Password"
                  />
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                disabled={busy}
                className="w-full min-h-11 bg-amber-500 hover:bg-amber-600 text-stone-950 font-bold gap-2"
                aria-label="Sign in"
              >
                {busy ? (
                  <span className="flex items-center gap-2">
                    <span className="w-4 h-4 border-2 border-stone-950/30 border-t-stone-950 rounded-full animate-spin" aria-hidden />
                    Signing in…
                  </span>
                ) : (
                  <>
                    <LogIn className="w-4 h-4" aria-hidden /> Sign in
                  </>
                )}
              </Button>
            </form>

            <div className="mt-6 border-t border-stone-200 pt-4">
              <p className="text-xs font-semibold text-stone-500 uppercase tracking-wide mb-2">
                Demo accounts <span className="normal-case font-normal">· one per role</span>
              </p>
              <div
                className="space-y-2 max-h-72 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full"
                role="list"
                aria-label="Demo accounts by role"
              >
                {DEMO_ACCOUNTS.map((acc) => (
                  <button
                    key={acc.email}
                    type="button"
                    role="listitem"
                    disabled={busy}
                    onClick={() => {
                      setEmail(acc.email)
                      setPassword(acc.password)
                      setError(null)
                    }}
                    aria-label={`Fill demo credentials for ${acc.label}: ${acc.email}`}
                    className="w-full flex items-center justify-between gap-3 text-left px-3 py-2.5 min-h-11 rounded-lg border border-stone-200 bg-white hover:bg-amber-50 hover:border-amber-300 transition-colors group"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-stone-800 truncate">
                        {acc.label} · <span className="font-mono text-xs">{acc.email}</span>
                      </span>
                      <span className="block text-[11px] text-stone-400 truncate">{acc.hint}</span>
                    </span>
                    <span className="text-[11px] font-bold text-amber-700 shrink-0 group-hover:text-amber-800">
                      Fill →
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs text-stone-400 px-4">
          Share-link clients don&apos;t need an account — the site team sends a link that just works.
        </p>
      </main>
    </div>
  )
}
