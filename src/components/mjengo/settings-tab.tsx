'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useSession } from 'next-auth/react'
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
import { ROLE_LABELS } from '@/lib/permissions'
import { useT } from '@/lib/i18n/provider'
import { useLocalePrefs } from '@/lib/i18n/store'
import type { Locale } from '@/lib/i18n/types'

// ---------------------------------------------------------------- local prefs
// W4-I18N: the persisted language preference moved to src/lib/i18n/store.ts
// (SAME localStorage key 'mjengo-os-settings' — no migration) so the
// I18nProvider and this radio share ONE source of truth. Toggling here
// re-renders every translated surface instantly.

// ---------------------------------------------------------------- notification prefs
// Server-backed (User.notificationPrefs) via the EXISTING notification-center
// route: GET /api/notifications returns { prefs }, PUT /api/notifications
// writes { kind: { inApp: boolean } } for the session user. No new backend.

/** Curated, honest subset of the route's allowed kinds (labels are ours). */
const PREF_KIND_ROWS: Array<{ kind: string; labelKey: string; hintKey: string }> = [
  { kind: 'milestone', labelKey: 'settings.pref.milestone', hintKey: 'settings.pref.milestoneHint' },
  { kind: 'variation', labelKey: 'settings.pref.variation', hintKey: 'settings.pref.variationHint' },
  { kind: 'anomaly', labelKey: 'settings.pref.anomaly', hintKey: 'settings.pref.anomalyHint' },
  { kind: 'comment', labelKey: 'settings.pref.comment', hintKey: 'settings.pref.commentHint' },
  { kind: 'attendance', labelKey: 'settings.pref.attendance', hintKey: 'settings.pref.attendanceHint' },
  { kind: 'recap', labelKey: 'settings.pref.recap', hintKey: 'settings.pref.recapHint' },
  { kind: 'price.alert', labelKey: 'settings.pref.priceAlert', hintKey: 'settings.pref.priceAlertHint' },
  { kind: 'digest.weekly', labelKey: 'settings.pref.digest', hintKey: 'settings.pref.digestHint' },
  { kind: 'system', labelKey: 'settings.pref.system', hintKey: 'settings.pref.systemHint' },
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
  const t = useT()
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
        if (!cancelled) setError(t('settings.error.load', { error: e instanceof Error ? e.message : 'network error' }))
      })
    return () => {
      cancelled = true
    }
    // t is captured for the catch's error wording only — it is deliberately
    // NOT a fetch trigger (the effect keys on projectId/reload; exhaustive-deps
    // does not flag it, so no disable directive needed).
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
          <Bell className="w-4 h-4 text-amber-600" aria-hidden /> {t('settings.notifications')}
        </CardTitle>
        <CardDescription>
          {t('settings.notifications.desc')}
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
              {t('settings.notifications.signedOut')}
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
              {t('settings.notifications.retry')}
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200" aria-label={t('settings.notifications.aria')}>
            {PREF_KIND_ROWS.map(({ kind, labelKey, hintKey }) => {
              const label = t(labelKey)
              const checked = prefs ? inAppOn(prefs, kind) : true
              const saving = savingKind === kind
              return (
                <li key={kind} className="flex items-center gap-3 px-3 sm:px-4 min-h-11 py-3">
                  {busy ? (
                    <Skeleton className="h-5 w-40 sm:w-64" aria-label={t('settings.notifications.loading')} />
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-stone-900">{label}</p>
                        <p className="text-xs text-stone-500 truncate">{t(hintKey)}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {saving && <Loader2 className="w-3.5 h-3.5 text-stone-400 animate-spin" aria-label={t('settings.notifications.saving')} />}
                        <Switch
                          id={`pref-${kind}`}
                          checked={checked}
                          disabled={busy || saving}
                          onCheckedChange={(v) => void toggle(kind, v)}
                          aria-label={t('settings.notifications.rowAria', { label })}
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
          {t('settings.notifications.seam')}
        </p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------- tab

/**
 * Settings tab (W3-F3 · i18n W4-I18N) — visible to every role (owner + client).
 * Data sources: session (next-auth) for the profile, localStorage for local
 * preferences (the SHARED locale store), /api/notifications GET/PUT for
 * notification prefs. Never touches the DB directly.
 */
export function SettingsTab() {
  const { data: session } = useSession()
  const t = useT()
  const language = useLocalePrefs((s) => s.language)
  const setLanguage = useLocalePrefs((s) => s.setLanguage)
  // The persisted store rehydrates from localStorage after mount — gate the
  // persisted-dependent markup on hydration (useSyncExternalStore, no
  // setState-in-effect) to keep the server render stable.
  const hydrated = useHydrated()

  const user = session?.user
  const name = user?.name || user?.email || t('settings.profile.signedIn')
  const email = user?.email ?? '—'
  const role = user?.role ? String(user.role) : null
  // Known roles have dict entries; anything else falls back to the honest
  // "unknown" label (permissions.ts ROLE_LABELS stays the role registry).
  const roleLabel = role && ROLE_LABELS[role] ? t(`role.${role}`) : t('role.unknown')
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || 'U'

  function handleReset() {
    void useLocalePrefs.persist.clearStorage()
    useLocalePrefs.getState().resetLocale()
    toast.success(t('settings.resetToast'))
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4 sm:space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{t('settings.title')}</h1>
        <p className="text-sm text-stone-500">
          {t('settings.subtitle')}
        </p>
      </header>

      {/* Profile — read-only, from the session (no DB access from the client).
          Share-link visitors have NO session: show an honest note instead of
          placeholder identity data. */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-stone-900">
            <User className="w-4 h-4 text-amber-600" aria-hidden /> {t('settings.profile')}
          </CardTitle>
          <CardDescription>{t('settings.profile.desc')}</CardDescription>
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
                  <span className="text-xs text-stone-400">{t('settings.profile.roleLabel', { role: role ?? t('role.unknown') })}</span>
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
                <p className="text-sm font-bold text-stone-900">{t('settings.profile.shareTitle')}</p>
                <p className="text-xs text-stone-500 leading-relaxed">
                  {t('settings.profile.shareBody')}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Preferences — local only (localStorage), persisted via the SHARED
          locale store ('mjengo-os-settings') that the I18nProvider consumes. */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-stone-900">
            <Globe className="w-4 h-4 text-amber-600" aria-hidden /> {t('settings.prefs')}
          </CardTitle>
          <CardDescription>{t('settings.prefs.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-stone-900 mb-2">{t('settings.language')}</legend>
            <RadioGroup
              value={hydrated ? language : 'en'}
              onValueChange={(v) => setLanguage(v as Locale)}
              aria-label={t('settings.language.aria')}
              className="gap-0 rounded-lg border border-stone-200 divide-y divide-stone-100"
            >
              <Label
                htmlFor="lang-en"
                className="flex items-center gap-3 min-h-11 px-3 sm:px-4 py-3 cursor-pointer font-normal hover:bg-stone-50 transition-colors"
              >
                <RadioGroupItem value="en" id="lang-en" className="data-[state=checked]:border-amber-600 data-[state=checked]:text-amber-600" />
                <span className="flex-1 text-sm font-medium text-stone-900">{t('settings.language.en')}</span>
                <span className="text-xs text-stone-400">{t('settings.language.enHint')}</span>
              </Label>
              <Label
                htmlFor="lang-sw"
                className="flex items-center gap-3 min-h-11 px-3 sm:px-4 py-3 cursor-pointer font-normal hover:bg-stone-50 transition-colors"
              >
                <RadioGroupItem value="sw" id="lang-sw" className="data-[state=checked]:border-amber-600 data-[state=checked]:text-amber-600" />
                <span className="flex-1 text-sm font-medium text-stone-900">{t('settings.language.sw')}</span>
                <span className="text-xs text-stone-400">{t('settings.language.swHint')}</span>
              </Label>
            </RadioGroup>
          </fieldset>

          {hydrated && language === 'sw' && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 leading-relaxed"
            >
              <Globe className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
              {t('settings.language.partialNote')}
            </p>
          )}

          <p className="text-xs text-stone-500 leading-relaxed">
            {t('settings.prefs.themeNote')}
          </p>
        </CardContent>
      </Card>

      {/* Notifications — server-backed prefs (existing route, wired) */}
      <NotificationPrefsCard />

      {/* Danger zone — local-only reset with confirm */}
      <Card className="border-red-200 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-800">
            <ShieldAlert className="w-4 h-4" aria-hidden /> {t('settings.danger')}
          </CardTitle>
          <CardDescription>{t('settings.danger.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-stone-900">{t('settings.danger.reset')}</p>
            <p className="text-xs text-stone-500 leading-relaxed">
              {t('settings.danger.resetDesc')}
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                className="gap-1.5 min-h-11 shrink-0"
                aria-label={t('settings.danger.aria')}
              >
                <RotateCcw className="w-4 h-4" aria-hidden /> {t('settings.danger.reset')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('settings.danger.confirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('settings.danger.confirmBody')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-11">{t('settings.danger.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  className="min-h-11 bg-red-700 hover:bg-red-800 text-white"
                  onClick={handleReset}
                >
                  {t('settings.danger.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </div>
  )
}
