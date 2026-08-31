'use client'

import { useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useSession, signOut } from 'next-auth/react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ProjectSwitcher } from '@/components/mjengo/project-switcher'
import {
  Wifi, CloudOff, HardHat, RefreshCw, CheckCheck, Share2, Bell, LogOut,
  LayoutDashboard, ListChecks, Boxes, Users, Sparkles, Wallet, ScrollText,
  Flag, FileDiff, MessageSquare, TriangleAlert, BellRing,
} from 'lucide-react'
import type { Notification } from '@prisma/client'
import type { TabKey } from '@/components/mjengo/app'
import { formatKES } from '@/lib/format'

const TABS: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'site', label: 'Site Plan', icon: ListChecks },
  { key: 'materials', label: 'Materials', icon: Boxes },
  { key: 'fundis', label: 'Fundis', icon: Users },
  { key: 'money', label: 'Money', icon: Wallet },
  { key: 'evidence', label: 'Evidence', icon: ScrollText },
  { key: 'copilot', label: 'AI Copilot', icon: Sparkles },
]

/** Icon per notification kind (falls back to a bell). */
function NotificationKindIcon({ kind }: { kind: string }) {
  const cls = 'w-4 h-4 shrink-0'
  switch (kind) {
    case 'milestone': return <Flag className={`${cls} text-amber-600`} aria-hidden />
    case 'variation': return <FileDiff className={`${cls} text-amber-600`} aria-hidden />
    case 'comment': return <MessageSquare className={`${cls} text-stone-500`} aria-hidden />
    case 'anomaly': return <TriangleAlert className={`${cls} text-red-600`} aria-hidden />
    case 'recap': return <BellRing className={`${cls} text-emerald-600`} aria-hidden />
    default: return <Bell className={`${cls} text-stone-400`} aria-hidden />
  }
}

/** Signed-in identity chip + sign out (hidden for share-token clients — they never log in). */
function UserChip() {
  const { data: session } = useSession()
  const user = session?.user
  if (!user?.email) return null

  const initials = (user.name || user.email)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || 'U'
  const role = String(user.role ?? 'contractor')
  const roleBadge =
    role === 'admin'
      ? 'bg-stone-800 text-stone-100'
      : role === 'client'
        ? 'bg-emerald-100 text-emerald-800'
        : 'bg-amber-100 text-amber-900'

  function handleSignOut() {
    // Reset view flags so no stale client/share surface survives the reload
    useMjengo.setState({ shareToken: null, shareError: null, clientRole: false, viewMode: 'owner' })
    void signOut({ redirect: false }).finally(() => window.location.reload())
  }

  return (
    <div className="flex items-center gap-1.5 sm:gap-2" aria-label={`Signed in as ${user.name} (${role})`}>
      <div className="flex items-center gap-2 min-w-0">
        <Avatar className="w-8 h-8 border border-stone-700">
          <AvatarFallback className="bg-amber-500 text-stone-950 text-xs font-bold">
            {initials}
          </AvatarFallback>
        </Avatar>
        <span className="hidden lg:flex flex-col leading-tight min-w-0">
          <span className="text-xs font-semibold text-stone-100 truncate max-w-28">{user.name}</span>
          <span
            className={`text-[9px] font-bold uppercase tracking-wide px-1.5 rounded w-fit ${roleBadge}`}
          >
            {role}
          </span>
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={handleSignOut}
        aria-label="Sign out"
        className="h-11 w-11 p-0 border-stone-700 bg-stone-900 text-stone-200 hover:bg-red-900/60 hover:text-white"
      >
        <LogOut className="w-4 h-4" aria-hidden />
      </Button>
    </div>
  )
}

const SCROLLBAR = '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full'

/**
 * Notification center bell — works for the owner and for a client on their
 * share link (notification.read / readAll are client-allowlisted).
 */
function NotificationBell() {
  const { data, dispatch, actionBusy, notificationsSeenAt } = useMjengo()
  const [open, setOpen] = useState(false)

  const notifications = data?.notifications ?? []
  const unread = useMemo(() => notifications.filter((n) => !n.read), [notifications])
  const latest = notifications.slice(0, 15)

  function markSeen() {
    if (Date.now() - (notificationsSeenAt ?? 0) > 2000) {
      useMjengo.setState({ notificationsSeenAt: Date.now() })
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) markSeen()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          aria-label={unread.length > 0 ? `Notifications, ${unread.length} unread` : 'Notifications'}
          className="relative gap-1.5 border-stone-700 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white"
        >
          <Bell className="w-4 h-4" aria-hidden />
          <span className="hidden md:inline">Alerts</span>
          {unread.length > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 bg-amber-500 text-stone-950 text-[10px] font-bold rounded-full min-w-5 h-5 px-1 flex items-center justify-center"
              aria-label={`${unread.length} unread notifications`}
            >
              {unread.length > 9 ? '9+' : unread.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0 border-stone-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100">
          <p className="text-sm font-semibold text-stone-900">Notifications</p>
          <span className="text-[11px] text-stone-400">
            {unread.length > 0 ? `${unread.length} unread` : 'All caught up'}
          </span>
        </div>
        {latest.length === 0 ? (
          <div className="px-4 py-8 text-center" role="status">
            <Bell className="w-6 h-6 text-stone-300 mx-auto" aria-hidden />
            <p className="mt-2 text-sm text-stone-500">Nothing yet — recaps, decisions and comments land here.</p>
          </div>
        ) : (
          <ul className={`max-h-96 overflow-y-auto ${SCROLLBAR}`} aria-label="Recent notifications">
            {latest.map((n: Notification) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!n.read) void dispatch('notification.read', { id: n.id }, 'Mark notification read')
                  }}
                  aria-label={n.read ? n.title : `${n.title} — mark as read`}
                  className={`w-full text-left flex items-start gap-2.5 px-4 py-3 border-b border-stone-100 last:border-b-0 min-h-11 transition-colors ${
                    n.read ? 'hover:bg-stone-50' : 'bg-amber-50/60 hover:bg-amber-50'
                  }`}
                >
                  <span className="mt-0.5 relative shrink-0">
                    <NotificationKindIcon kind={n.kind} />
                    {!n.read && (
                      <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500" aria-label="Unread" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm leading-snug ${n.read ? 'text-stone-600' : 'font-medium text-stone-900'}`}>{n.title}</span>
                    <span className="block text-xs text-stone-400 mt-0.5 truncate" title={n.body}>{n.body}</span>
                    <span className="block text-[11px] text-stone-400 mt-0.5">
                      {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {unread.length > 0 && (
          <div className="p-2 border-t border-stone-100">
            <Button
              variant="ghost"
              size="sm"
              className="w-full min-h-11 gap-1.5 text-stone-600 hover:text-stone-900"
              disabled={actionBusy !== null}
              onClick={() => void dispatch('notification.readAll', {}, 'Mark all notifications read')}
            >
              <CheckCheck className="w-4 h-4" aria-hidden /> Mark all read
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function Header({
  tab,
  onTabChange,
  onCreateProject,
  onShare,
}: {
  tab: TabKey
  onTabChange: (t: TabKey) => void
  onCreateProject: () => void
  onShare: () => void
}) {
  const {
    data, projects, activeProjectId, switchProject, viewMode, shareToken, clientRole,
    online, setOnline, outbox, syncing, syncNow, lastSyncAt,
  } = useMjengo()
  const summary = data?.summary
  // Client surface: a real client on a share link (no login) OR a logged-in
  // client-role user — owner controls hidden, read-mostly header
  const isShareClient = viewMode === 'client' && (Boolean(shareToken) || clientRole)
  const tabs = isShareClient ? TABS.filter((t) => t.key !== 'copilot') : TABS

  return (
    <header className="bg-stone-950 text-stone-100 sticky top-0 z-40 shadow-lg">
      <div className="h-1 bg-amber-500" aria-hidden />
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="h-14 flex items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 bg-amber-500 rounded-lg flex items-center justify-center shrink-0" aria-hidden>
              <HardHat className="w-5 h-5 text-stone-950" />
            </div>
            <div className="min-w-0 hidden sm:block">
              <div className="font-bold tracking-tight leading-none">MjengoOS</div>
              <div className="text-[10px] text-stone-400 leading-tight">
                {isShareClient ? 'Virtual Site Visit' : 'Construction Site OS · Kenya'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 min-w-0 flex-1 justify-center">
            {isShareClient ? (
              <div className="min-w-0 text-center">
                <p className="text-sm font-bold tracking-tight truncate" aria-label="Project name">{data?.project.name}</p>
                <p className="text-[10px] text-stone-400 leading-tight truncate">
                  {data?.project.client} · {data?.project.location}
                </p>
              </div>
            ) : (
              <>
                <ProjectSwitcher
                  projects={projects}
                  activeId={activeProjectId ?? data?.project.id ?? null}
                  onSelect={(id) => void switchProject(id)}
                  onCreate={onCreateProject}
                />
                <span className="hidden lg:flex items-center gap-2 text-sm text-stone-400 whitespace-nowrap min-w-0" aria-label="Active project summary">
                  <span className="text-stone-600" aria-hidden>|</span>
                  Day {summary?.dayCount} · {summary?.progressPct}% complete · {formatKES(summary?.budgetSpent ?? 0, true)} / {formatKES(summary?.budgetTotal ?? 0, true)}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Signed-in identity (hidden for share-link clients — no session) */}
            <UserChip />

            {/* Share with client (owner only) */}
            {!isShareClient && viewMode === 'owner' && (
              <Button
                size="sm"
                variant="outline"
                onClick={onShare}
                aria-label="Share with client"
                className="gap-1.5 border-stone-700 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white"
              >
                <Share2 className="w-4 h-4" aria-hidden />
                <span className="hidden md:inline">Share</span>
              </Button>
            )}

            {/* Notification center — owner and client */}
            <NotificationBell />

            {!isShareClient && (
              <>
                {/* Connectivity toggle — simulates field connectivity */}
                <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-stone-900 border border-stone-800">
                  {online ? (
                    <Wifi className="w-4 h-4 text-emerald-400" aria-label="Online" />
                  ) : (
                    <CloudOff className="w-4 h-4 text-amber-500" aria-label="Offline" />
                  )}
                  <Switch
                    checked={online}
                    onCheckedChange={setOnline}
                    aria-label="Toggle connectivity"
                    className="scale-90 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-amber-600"
                  />
                  <span className="text-xs font-medium w-12 hidden sm:inline">{online ? 'Online' : 'Offline'}</span>
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  disabled={online || outbox.length === 0 || syncing}
                  onClick={() => void syncNow()}
                  aria-label="Sync queued actions"
                  className="gap-1.5 border-stone-700 bg-stone-900 text-stone-200 hover:bg-stone-800 hover:text-white relative"
                >
                  <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden />
                  <span className="hidden sm:inline">{syncing ? 'Syncing…' : 'Sync'}</span>
                  {outbox.length > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 bg-amber-500 text-stone-950 text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center" aria-label={`${outbox.length} queued actions`}>
                      {outbox.length}
                    </span>
                  )}
                </Button>
                {lastSyncAt && online && outbox.length === 0 && (
                  <span className="hidden md:flex items-center gap-1 text-[11px] text-stone-500">
                    <CheckCheck className="w-3.5 h-3.5 text-emerald-500" aria-hidden /> synced
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Tab navigation */}
        <nav className="flex items-center gap-1 overflow-x-auto -mx-1 px-1 pb-2" aria-label="Main navigation">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => onTabChange(key)}
              aria-current={tab === key ? 'page' : undefined}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
                tab === key
                  ? 'bg-amber-500 text-stone-950'
                  : 'text-stone-400 hover:text-stone-100 hover:bg-stone-800'
              }`}
            >
              <Icon className="w-4 h-4" aria-hidden />
              {label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  )
}
