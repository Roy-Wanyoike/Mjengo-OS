'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useSession } from 'next-auth/react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Bell, BellOff, Globe, Loader2, RotateCcw, ShieldAlert, User } from 'lucide-react'
import { useMjengo } from '@/hooks/use-mjengo'
import { labelForRole } from '@/lib/permissions'

// ---------------------------------------------------------------- local prefs
// Mirrors the app's existing persisted-client-state pattern (zustand persist
// → localStorage, cf. 'mjengo-os-store' in hooks/use-mjengo.ts): local-only
// display preferences, never synced to the server.

export type UiLanguage = 'en' | 'sw'

interface SettingsPrefsState {
  /** UI language preference — STORED ONLY (i18n is a future wave). */
  language: UiLanguage
  setLanguage: (l: UiLanguage) => void
  /** Danger zone: restore defaults (caller also clears the storage key). */
  resetPrefs: () => void
}

const DEFAULT_LANGUAGE: UiLanguage = 'en'

export const useSettingsPrefs = create<SettingsPrefsState>()(
  persist(
    (set) => ({
      language: DEFAULT_LANGUAGE,
      setLanguage: (language) => set({ language }),
      resetPrefs: () => set({ language: DEFAULT_LANGUAGE }),
    }),
    {
      name: 'mjengo-os-settings',
      version: 1,
      partialize: (s) => ({ language: s.language }),
    },
  ),
)

// ---------------------------------------------------------------- notification prefs
// Server-backed (User.notificationPrefs) via the EXISTING notification-center
// route: GET /api/notifications returns { prefs }, PUT /api/notifications
// writes { kind: { inApp: boolean } } for the session user. No new backend.

/** Curated, honest subset of the route's allowed kinds (labels are ours). */
const PREF_KIND_ROWS: Array<{ kind: string; label: string; hint: string }> = [
  { kind: 'milestone', label: 'Milestones', hint: 'Phase & milestone completions' },
  { kind: 'variation', label: 'Variations', hint: 'Scope or cost changes' },
  { kind: 'anomaly', label: 'Anomaly alerts', hint: 'AI-detected site anomalies' },
  { kind: 'comment', label: 'Photo comments', hint: 'Comments on evidence photos' },
  { kind: 'attendance', label: 'Attendance', hint: 'Fundi check-in flags' },
  { kind: 'recap', label: 'Daily recaps', hint: 'End-of-day AI site recaps' },
  { kind: 'price.alert', label: 'Price alerts', hint: 'Material price movements (Finder)' },
  { kind: 'digest.weekly', label: 'Weekly digest', hint: 'Weekly project summary' },
  { kind: 'system', label: 'System notices', hint: 'Platform & account notices' },
]

type ServerPrefs = Record<string, unknown>

/** Noop external-store subscription for the useHydrated pattern below. */
const subscribeNoop = () => () => {}

/** True only after hydration (SSR snapshot false) — lets us render persisted
 *  client state without server/client markup mismatches, without a
 *  setState-in-effect. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  )
}

/** Checked state for a kind — unset means the default (in-app ON). */
function inAppOn(prefs: ServerPrefs, kind: string): boolean {
  const v = prefs[kind]
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const inApp = (v as { inApp?: unknown }).inApp
    if (typeof inApp === 'boolean') return inApp
  }
  return true
}

function NotificationPrefsCard() {
  const { data, activeProjectId } = useMjengo()
  const projectId = activeProjectId ?? data?.project.id ?? null
  const [prefs, setPrefs] = useState<ServerPrefs | null>(null) // null = loading
  const [error, setError] = useState<string | null>(null)
  const [signedOut, setSignedOut] = useState(false) // 401: share-link visitor, no session
  const [savingKind, setSavingKind] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  // Load the session user's saved prefs (GET also pins clients to their own
  // project; unknown/omitted projectId → server picks the first project).
  // 401 = not signed in (anonymous share-link client on the client surface
  // can reach the Settings tab) → honest signed-out note, not a fake error.
  useEffect(() => {
    let cancelled = false
    setPrefs(null)
    setError(null)
    setSignedOut(false)
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    fetch(`/api/notifications${qs}`)
      .then(async (r) => {
        if (r.status === 401) {
          if (!cancelled) setSignedOut(true)
          return
        }
        if (!r.ok) {
          const json = (await r.json().catch(() => null)) as { error?: string } | null
          throw new Error(json?.error ?? `HTTP ${r.status}`)
        }
        const json = (await r.json()) as { prefs?: ServerPrefs }
        if (!cancelled) setPrefs(json.prefs ?? {})
      })
      .catch((e) => {
        if (!cancelled) setError(`Could not load your saved preferences — ${e instanceof Error ? e.message : 'network error'}`)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, reload])

  /** Optimistic toggle → PUT the FULL prefs object (preserves other kinds). */
  async function toggle(kind: string, next: boolean) {
    if (!prefs) return
    const prev = prefs
    const merged: ServerPrefs = {
      ...prev,
      [kind]: { ...((prev[kind] ?? {}) as object), inApp: next },
    }
    setPrefs(merged)
    setSavingKind(kind)
    try {
      const r = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs: merged }),
      })
      if (!r.ok) {
        const json = (await r.json().catch(() => null)) as { error?: string } | null
        throw new Error(json?.error ?? `HTTP ${r.status}`)
      }
      const json = (await r.json()) as { prefs?: ServerPrefs }
      setPrefs(json.prefs ?? merged)
    } catch (e) {
      setPrefs(prev) // honest revert
      toast.error(e instanceof Error ? `Could not save: ${e.message}` : 'Could not save preference')
    } finally {
      setSavingKind(null)
    }
  }

  const busy = prefs === null

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-stone-900">
          <Bell className="w-4 h-4 text-amber-600" aria-hidden /> Notifications
        </CardTitle>
        <CardDescription>
          In-app notification preferences, saved to your MjengoOS account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {signedOut ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-600 leading-relaxed"
          >
            <BellOff className="w-4 h-4 shrink-0 mt-0.5 text-stone-400" aria-hidden />
            <span>
              Notification preferences are saved per MjengoOS account. You're
              viewing via a client share link — sign in to manage yours.
            </span>
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            <span className="flex-1">{error}</span>
            <Button
              variant="outline"
              size="sm"
              className="min-h-9 shrink-0"
              onClick={() => setReload((n) => n + 1)}
            >
              Retry
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200" aria-label="Notification preferences">
            {PREF_KIND_ROWS.map(({ kind, label, hint }) => {
              const checked = prefs ? inAppOn(prefs, kind) : true
              const saving = savingKind === kind
              return (
                <li key={kind} className="flex items-center gap-3 px-3 sm:px-4 min-h-11 py-3">
                  {busy ? (
                    <Skeleton className="h-5 w-40 sm:w-64" aria-label="Loading preference" />
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-900">{label}</p>
                        <p className="text-xs text-stone-500 truncate">{hint}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {saving && <Loader2 className="w-3.5 h-3.5 text-stone-400 animate-spin" aria-label="Saving" />}
                        <Switch
                          id={`pref-${kind}`}
                          checked={checked}
                          disabled={busy || saving}
                          onCheckedChange={(v) => void toggle(kind, v)}
                          aria-label={`${label} in-app notifications`}
                          className="data-[state=checked]:bg-amber-600"
                        />
                      </div>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <p className="text-xs text-stone-500 leading-relaxed">
          Honest seam: only the in-app channel exists today — these preferences are
          recorded on your account and will gate delivery when notification
          channels land. Unset kinds stay on (default).
        </p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------- tab

/**
 * Settings tab (W3-F3) — visible to every role (owner + client).
 * Data sources: session (next-auth) for the profile, localStorage for local
 * preferences, /api/notifications GET/PUT for notification prefs. Never
 * touches the DB directly.
 */
export function SettingsTab() {
  const { data: session } = useSession()
  const language = useSettingsPrefs((s) => s.language)
  const setLanguage = useSettingsPrefs((s) => s.setLanguage)
  // The persisted store rehydrates from localStorage after mount — gate the
  // persisted-dependent markup on hydration (useSyncExternalStore, no
  // setState-in-effect) to keep the server render stable.
  const hydrated = useHydrated()

  const user = session?.user
  const name = user?.name || user?.email || 'Signed-in user'
  const email = user?.email ?? '—'
  const role = user?.role ? String(user.role) : null
  const roleLabel = labelForRole(role)
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || 'U'

  function handleReset() {
    void useSettingsPrefs.persist.clearStorage()
    useSettingsPrefs.getState().resetPrefs()
    toast.success('Local preferences reset on this device')
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4 sm:space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-900">Settings</h1>
        <p className="text-sm text-stone-500">
          Your profile, device preferences and notification choices.
        </p>
      </header>

      {/* Profile — read-only, from the session (no DB access from the client).
          Share-link visitors have NO session: show an honest note instead of
          placeholder identity data. */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-stone-900">
            <User className="w-4 h-4 text-amber-600" aria-hidden /> Profile
          </CardTitle>
          <CardDescription>From your MjengoOS session — read-only.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          {user ? (
            <>
              <Avatar className="w-14 h-14 border border-stone-200">
                <AvatarFallback className="bg-amber-500 text-stone-950 text-base font-bold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-stone-900 truncate">{name}</p>
                <p className="text-sm text-stone-500 truncate">{email}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <Badge
                    className={
                      role === 'admin'
                        ? 'bg-stone-800 text-stone-100 border-stone-800'
                        : 'bg-amber-100 text-amber-900 border-amber-200'
                    }
                  >
                    {roleLabel}
                  </Badge>
                  <span className="text-xs text-stone-400">role: {role ?? 'unknown'}</span>
                </div>
              </div>
            </>
          ) : (
            <div
              role="status"
              className="flex items-center gap-4 w-full rounded-lg border border-stone-200 bg-stone-50 p-3"
            >
              <div className="w-12 h-12 rounded-full bg-stone-200 flex items-center justify-center shrink-0" aria-hidden>
                <User className="w-5 h-5 text-stone-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-stone-900">Client share-link view</p>
                <p className="text-xs text-stone-500 leading-relaxed">
                  No MjengoOS account is signed in on this device. Profiles belong
                  to signed-in accounts.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Preferences — local only (localStorage), persisted via zustand persist */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-stone-900">
            <Globe className="w-4 h-4 text-amber-600" aria-hidden /> Preferences
          </CardTitle>
          <CardDescription>Saved on this device only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-stone-900 mb-2">Language</legend>
            <RadioGroup
              value={hydrated ? language : DEFAULT_LANGUAGE}
              onValueChange={(v) => setLanguage(v as UiLanguage)}
              aria-label="Interface language"
              className="gap-0 rounded-lg border border-stone-200 divide-y divide-stone-100"
            >
              <Label
                htmlFor="lang-en"
                className="flex items-center gap-3 min-h-11 px-3 sm:px-4 py-3 cursor-pointer font-normal hover:bg-stone-50 transition-colors"
              >
                <RadioGroupItem value="en" id="lang-en" className="data-[state=checked]:border-amber-600 data-[state=checked]:text-amber-600" />
                <span className="flex-1 text-sm font-medium text-stone-900">English</span>
                <span className="text-xs text-stone-400">default</span>
              </Label>
              <Label
                htmlFor="lang-sw"
                className="flex items-center gap-3 min-h-11 px-3 sm:px-4 py-3 cursor-pointer font-normal hover:bg-stone-50 transition-colors"
              >
                <RadioGroupItem value="sw" id="lang-sw" className="data-[state=checked]:border-amber-600 data-[state=checked]:text-amber-600" />
                <span className="flex-1 text-sm font-medium text-stone-900">Kiswahili</span>
                <span className="text-xs text-stone-400">KES · Kenya</span>
              </Label>
            </RadioGroup>
          </fieldset>

          {hydrated && language === 'sw' && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 leading-relaxed"
            >
              <Globe className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
              Kiswahili UI coming soon — your choice is saved and will apply when
              the translated interface lands. The app stays in English for now (no
              half-translations).
            </p>
          )}

          <p className="text-xs text-stone-500 leading-relaxed">
            Theme and compact-mode options are intentionally absent: the app has a
            single fixed light theme today, so a toggle here would be a fake control.
          </p>
        </CardContent>
      </Card>

      {/* Notifications — server-backed prefs (existing route, wired) */}
      <NotificationPrefsCard />

      {/* Danger zone — local-only reset with confirm */}
      <Card className="border-red-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-800">
            <ShieldAlert className="w-4 h-4" aria-hidden /> Danger zone
          </CardTitle>
          <CardDescription>Non-destructive — touches this device only.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-stone-900">Reset local preferences</p>
            <p className="text-xs text-stone-500 leading-relaxed">
              Clears the language choice saved on this device. Notification
              preferences live on your account and are not affected.
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                className="gap-1.5 min-h-11 shrink-0"
                aria-label="Reset local preferences (opens confirmation)"
              >
                <RotateCcw className="w-4 h-4" aria-hidden /> Reset local preferences
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset local preferences?</AlertDialogTitle>
                <AlertDialogDescription>
                  This clears the locally saved display preferences (language) from
                  this device and restores the defaults. Your notification
                  preferences are saved on your MjengoOS account and stay unchanged.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="min-h-11 bg-red-700 hover:bg-red-800 text-white"
                  onClick={handleReset}
                >
                  Reset
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </div>
  )
}
