'use client'

import { useMemo, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useSession, signOut } from 'next-auth/react'
import { toast } from 'sonner'
import { useMjengo } from '@/hooks/use-mjengo'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { ProjectSwitcher } from '@/components/mjengo/project-switcher'
import {
  Wifi, CloudOff, HardHat, RefreshCw, CheckCheck, Share2, Bell, LogOut,
  LayoutDashboard, ListChecks, Boxes, Users, Sparkles, Wallet, ScrollText,
  Flag, FileDiff, MessageSquare, TriangleAlert, BellRing,
  Landmark, PackageSearch, Radar, Phone,
  Truck, Package, UserCheck, ClipboardCheck, FileText, ReceiptText, TrendingUp, Newspaper, ShieldAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Notification } from '@prisma/client'
import type { TabKey } from '@/components/mjengo/app'
import { formatKES } from '@/lib/format'

const TABS: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'site', label: 'Site Plan', icon: ListChecks },
  { key: 'materials', label: 'Materials', icon: Boxes },
  { key: 'finder', label: 'Finder', icon: PackageSearch },
  { key: 'fundis', label: 'Fundis', icon: Users },
  { key: 'money', label: 'Money', icon: Wallet },
  { key: 'land', label: 'Land', icon: Landmark },
  { key: 'evidence', label: 'Evidence', icon: ScrollText },
  { key: 'intel', label: 'Intel', icon: Radar },
  { key: 'copilot', label: 'AI Copilot', icon: Sparkles },
  { key: 'ussd', label: 'USSD', icon: Phone },
]

/** Icon + label per notification kind (falls back to a bell). */
const NOTIFICATION_KINDS: Record<string, { label: string; Icon: LucideIcon; tint: string }> = {
  milestone: { label: 'Milestone', Icon: Flag, tint: 'text-amber-600' },
  variation: { label: 'Variation', Icon: FileDiff, tint: 'text-amber-600' },
  comment: { label: 'Comment', Icon: MessageSquare, tint: 'text-stone-500' },
  anomaly: { label: 'Anomaly', Icon: TriangleAlert, tint: 'text-red-600' },
  recap: { label: 'Recap', Icon: BellRing, tint: 'text-emerald-600' },
  attendance: { label: 'Attendance', Icon: UserCheck, tint: 'text-stone-500' },
  share: { label: 'Share link', Icon: Share2, tint: 'text-stone-500' },
  system: { label: 'System', Icon: Bell, tint: 'text-stone-400' },
  'approval.requested': { label: 'Approval', Icon: ClipboardCheck, tint: 'text-amber-600' },
  'approval.decided': { label: 'Approval', Icon: ClipboardCheck, tint: 'text-amber-600' },
  'quote.received': { label: 'Quote', Icon: FileText, tint: 'text-stone-500' },
  'order.sent': { label: 'Order', Icon: Package, tint: 'text-stone-500' },
  'order.confirmed': { label: 'Order', Icon: Package, tint: 'text-stone-500' },
  'delivery.dispatched': { label: 'Delivery', Icon: Truck, tint: 'text-stone-500' },
  'delivery.discrepancy': { label: 'Delivery', Icon: TriangleAlert, tint: 'text-red-600' },
  'invoice.submitted': { label: 'Invoice', Icon: ReceiptText, tint: 'text-amber-600' },
  'invoice.decided': { label: 'Invoice', Icon: ReceiptText, tint: 'text-amber-600' },
  'invoice.disputed': { label: 'Invoice', Icon: TriangleAlert, tint: 'text-red-600' },
  'invoice.paid': { label: 'Invoice', Icon: ReceiptText, tint: 'text-emerald-600' },
  'land': { label: 'Land', Icon: Landmark, tint: 'text-stone-500' },
  'price.alert': { label: 'Price', Icon: TrendingUp, tint: 'text-amber-600' },
  'digest.weekly': { label: 'Digest', Icon: Newspaper, tint: 'text-stone-500' },
  'risk.flagged': { label: 'Risk', Icon: ShieldAlert, tint: 'text-red-600' },
}

function kindMeta(kind: string) {
  return NOTIFICATION_KINDS[kind] ?? { label: 'Notice', Icon: Bell, tint: 'text-stone-400' }
}

/** Filter groups for the notification center (unknown kinds fall into "Site"). */
const KIND_GROUPS: Array<{ key: string; label: string; kinds: string[] }> = [
  { key: 'all', label: 'All', kinds: [] },
  { key: 'approvals', label: 'Approvals', kinds: ['approval.requested', 'approval.decided'] },
  { key: 'orders', label: 'Orders', kinds: ['order.sent', 'order.confirmed', 'quote.received'] },
  { key: 'deliveries', label: 'Deliveries', kinds: ['delivery.dispatched', 'delivery.discrepancy'] },
  { key: 'invoices', label: 'Invoices', kinds: ['invoice.submitted', 'invoice.decided', 'invoice.disputed', 'invoice.paid'] },
  { key: 'intel', label: 'Risk & prices', kinds: ['price.alert', 'digest.weekly', 'risk.flagged'] },
  { key: 'money', label: 'Money', kinds: ['milestone', 'variation'] },
  { key: 'site', label: 'Site', kinds: ['recap', 'comment', 'attendance', 'anomaly', 'share', 'system'] },
]

function groupOf(kind: string): string {
  const g = KIND_GROUPS.find((x) => x.key !== 'all' && x.kinds.includes(kind))
  return g?.key ?? 'site'
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
 * share link. Signed-in users mark read via POST /api/notifications (a client
 * convenience route — see that file for the reasoning); share-link clients
 * and offline sessions fall back to the client-allowlisted
 * notification.read / readAll actions.
 */
function NotificationBell() {
  const { data, dispatch, actionBusy, notificationsSeenAt, online } = useMjengo()
  const { data: session } = useSession()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('all')
  const [marking, setMarking] = useState(false)

  const notifications = data?.notifications ?? []
  const unread = useMemo(() => notifications.filter((n) => !n.read), [notifications])
  const filtered = useMemo(
    () => (filter === 'all' ? notifications : notifications.filter((n) => groupOf(n.kind) === filter)),
    [notifications, filter],
  )
  const busy = marking || actionBusy !== null

  function markSeen() {
    if (Date.now() - (notificationsSeenAt ?? 0) > 2000) {
      useMjengo.setState({ notificationsSeenAt: Date.now() })
    }
  }

  async function markRead(ids: string[] | 'all') {
    const projectId = data?.project.id
    if (!projectId || busy) return
    if (session?.user && online) {
      // Signed-in + online: the dedicated mark-read route refreshes the store
      // via load() afterwards.
      setMarking(true)
      try {
        const res = await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, ids }),
        })
        if (res.ok) {
          await useMjengo.getState().load()
        } else {
          const json = await res.json().catch(() => null)
          toast.error(json?.error ?? 'Could not mark notifications read')
        }
      } catch {
        toast.error('Network error — try again when back online')
      } finally {
        setMarking(false)
      }
      return
    }
    // Share-link clients (no session) and offline users: the allowlisted
    // legacy actions — they route through /api/share and queue when offline.
    if (ids === 'all') {
      void dispatch('notification.readAll', {}, 'Mark all notifications read')
    } else {
      void dispatch('notification.read', { id: ids[0] }, 'Mark notification read')
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) markSeen()
      }}
    >
      <SheetTrigger asChild>
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
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-md w-full p-0 gap-0">
        <SheetHeader className="p-4 pb-3 border-b border-stone-100">
          <SheetTitle className="text-base text-stone-900">Notifications</SheetTitle>
          <SheetDescription className="text-xs text-stone-400">
            {unread.length > 0 ? `${unread.length} unread` : 'All caught up'} · {data?.project.name ?? 'project'}
          </SheetDescription>
        </SheetHeader>

        <div
          className="px-3 py-2.5 border-b border-stone-100 flex flex-wrap gap-1.5"
          role="group"
          aria-label="Filter notifications by kind"
        >
          {KIND_GROUPS.map((g) => {
            const count = g.key === 'all' ? notifications.length : notifications.filter((n) => groupOf(n.kind) === g.key).length
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => setFilter(g.key)}
                aria-pressed={filter === g.key}
                className={`min-h-8 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                  filter === g.key
                    ? 'bg-stone-900 text-stone-50'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                {g.label}
                {count > 0 && <span className="ml-1 text-[10px] font-normal opacity-70">{count}</span>}
              </button>
            )
          })}
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center flex-1" role="status">
            <Bell className="w-6 h-6 text-stone-300 mx-auto" aria-hidden />
            <p className="mt-2 text-sm text-stone-500">Nothing needs you right now.</p>
            <p className="mt-1 text-xs text-stone-400">Decisions, deliveries and price alerts land here.</p>
          </div>
        ) : (
          <ul className={`flex-1 min-h-0 max-h-[64vh] overflow-y-auto ${SCROLLBAR}`} aria-label="Notifications">
            {filtered.map((n: Notification) => {
              const meta = kindMeta(n.kind)
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!n.read) void markRead([n.id])
                    }}
                    aria-label={n.read ? n.title : `${n.title} — mark as read`}
                    className={`w-full text-left flex items-start gap-2.5 px-4 py-3 border-b border-stone-100 last:border-b-0 min-h-11 transition-colors ${
                      n.read ? 'hover:bg-stone-50' : 'bg-amber-50/60 hover:bg-amber-50'
                    }`}
                  >
                    <span className="mt-0.5 relative shrink-0">
                      <meta.Icon className={`w-4 h-4 ${meta.tint}`} aria-hidden />
                      {!n.read && (
                        <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500" aria-label="Unread" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-semibold uppercase tracking-wide text-stone-400">{meta.label}</span>
                      <span className={`block text-sm leading-snug ${n.read ? 'text-stone-600' : 'font-medium text-stone-900'}`}>{n.title}</span>
                      <span className="block text-xs text-stone-500 mt-0.5 line-clamp-2" title={n.body}>{n.body}</span>
                      <span className="block text-[11px] text-stone-400 mt-0.5">
                        {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {unread.length > 0 && (
          <SheetFooter className="border-t border-stone-100 p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full min-h-11 gap-1.5 text-stone-600 hover:text-stone-900"
              disabled={busy}
              onClick={() => void markRead('all')}
            >
              <CheckCheck className="w-4 h-4" aria-hidden /> Mark all read
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
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
