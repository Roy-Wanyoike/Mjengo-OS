'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useMjengo } from '@/hooks/use-mjengo'
import { Header } from '@/components/mjengo/header'
import { OverviewTab } from '@/components/mjengo/overview-tab'
import { SitePlanTab } from '@/components/mjengo/site-plan-tab'
import { MaterialsTab } from '@/components/mjengo/materials-tab'
import { FundisTab } from '@/components/mjengo/fundis-tab'
import { MoneyTab } from '@/components/mjengo/money-tab'
import { EvidenceTab } from '@/components/mjengo/evidence-tab'
import { CopilotTab } from '@/components/mjengo/copilot-tab'
import { LandTab } from '@/components/mjengo/land-tab'
import { FinderTab } from '@/components/mjengo/finder-tab'
import { IntelTab } from '@/components/mjengo/intel-tab'
import { UssdTab } from '@/components/mjengo/ussd-tab'
import { WelcomeScreen } from '@/components/mjengo/welcome-screen'
import { CreateProjectDialog, type CreateProjectPayload } from '@/components/mjengo/create-project-dialog'
import { ShareDialog } from '@/components/mjengo/share-dialog'
import { DiasporaBanner } from '@/components/mjengo/diaspora-banner'
import { LoginScreen } from '@/components/auth/login-screen'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent } from '@/components/ui/card'
import { CloudOff, RefreshCw, HardHat, Link2Off } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

export type TabKey =
  | 'overview' | 'site' | 'materials' | 'finder' | 'fundis' | 'money'
  | 'land' | 'evidence' | 'intel' | 'copilot' | 'ussd'

function BootSkeleton() {
  return (
    <div className="min-h-screen flex flex-col bg-stone-100">
      <div className="h-16 bg-stone-950 flex items-center px-6 gap-3">
        <div className="w-9 h-9 bg-amber-500 rounded-lg flex items-center justify-center">
          <HardHat className="w-5 h-5 text-stone-950" />
        </div>
        <div className="h-6 w-40 bg-stone-800 rounded animate-pulse" />
      </div>
      <div className="flex-1 p-4 sm:p-6 space-y-4 max-w-7xl mx-auto w-full">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    </div>
  )
}

export function MjengoApp() {
  const {
    data, loading, load, online, outbox, syncing,
    projects, activeProjectId, viewMode, setViewMode, createProject, dispatch,
    shareToken, shareError, bootFromShare, clientRole,
  } = useMjengo()
  const { data: session, status } = useSession()
  const [tab, setTab] = useState<TabKey>('overview')
  const [createOpen, setCreateOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [origin, setOrigin] = useState('')
  const [shareBooting, setShareBooting] = useState(false)

  // Boot: while signed OUT, a ?share=<token> link (or a previously used token)
  // opens the public client "Virtual Site Visit" with NO login. Signed-in users
  // are routed by the session effect below instead.
  useEffect(() => {
    if (status === 'loading' || status === 'authenticated') return
    const param = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('share')
      : null
    const token = param || useMjengo.getState().shareToken
    if (token) {
      setShareBooting(true)
      void bootFromShare(token, Boolean(param)).finally(() => setShareBooting(false))
    }
    // Signed-out owner app → the login gate; /api/projects is 401 now, no load() needed
  }, [status, bootFromShare])

  // Post-login routing by role:
  //  · client        → client view for THEIR project (no exit link — they belong there)
  //  · contractor/admin → owner app; never get stuck in a persisted client/share view
  useEffect(() => {
    if (status !== 'authenticated' || !session?.user?.email) return
    const role = session.user.role
    const pid = session.user.projectId
    const store = useMjengo.getState()
    if (role === 'client') {
      const already = store.clientRole && store.viewMode === 'client' && !store.shareToken
        && Boolean(store.data) && (!pid || store.data?.project?.id === pid)
      if (!already) {
        useMjengo.setState({
          clientRole: true,
          viewMode: 'client',
          shareToken: null,
          shareError: null,
          activeProjectId: pid ?? store.activeProjectId,
        })
        setTab('overview')
        void useMjengo.getState().load()
      }
    } else if (store.shareToken || store.viewMode === 'client' || store.clientRole || store.shareError) {
      useMjengo.setState({ shareToken: null, shareError: null, viewMode: 'owner', clientRole: false })
      void useMjengo.getState().load()
    } else if (!store.data || store.projects.length === 0) {
      // Warm session + persisted data still needs load(): the projects list is
      // NOT persisted, so without this the switcher shows "Projects · 0"
      void useMjengo.getState().load()
    }
  }, [status, session])

  useEffect(() => {
    setOrigin(window.location.origin)
  }, [])

  async function handleCreateProject(payload: CreateProjectPayload): Promise<boolean> {
    setCreating(true)
    try {
      return await createProject(payload)
    } finally {
      setCreating(false)
    }
  }

  async function handleRegenerateShareLink() {
    if (!data?.project) return
    const ok = await dispatch('share.regenerate', { id: data.project.id }, 'Regenerate client share link')
    if (ok) toast.success('New link generated — the old one no longer works')
    else toast.error('Could not regenerate the link')
  }

  function handlePreviewingChange(previewing: boolean) {
    setViewMode(previewing ? 'client' : 'owner')
    if (previewing) setShareOpen(false)
  }

  /** Leave the share-link client view (same browser) and open the site-team app. */
  function exitShareView() {
    useMjengo.setState({ shareToken: null, shareError: null, viewMode: 'owner' })
    setTab('overview')
    void load()
  }

  const isShareClient = viewMode === 'client' && Boolean(shareToken)
  // Client surface = share-link client (no login) OR a logged-in client-role user
  const isClientSurface = viewMode === 'client' && (Boolean(shareToken) || clientRole)

  // Dead share link — full-screen card, no access to any project data
  if (shareError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-100 p-6">
        <Card className="max-w-md w-full border-stone-200 shadow-sm">
          <CardContent className="p-8 flex flex-col items-center text-center gap-4">
            <div className="w-14 h-14 rounded-full bg-stone-200 flex items-center justify-center" aria-hidden>
              <Link2Off className="w-7 h-7 text-stone-500" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-lg font-bold text-stone-900">This link no longer works</h1>
              <p className="text-sm text-stone-500 leading-relaxed">
                {shareError}. Ask the site team to send a fresh link from MjengoOS.
              </p>
            </div>
            <Button
              variant="outline"
              className="min-h-11 gap-1.5"
              onClick={() => {
                useMjengo.setState({ shareError: null, shareToken: null })
                void load()
              }}
            >
              <HardHat className="w-4 h-4" aria-hidden /> Open MjengoOS
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ---------------- Auth gate (login is an app state, not a route) ----------------
  // Session still resolving → boot skeleton (prevents a login flash on share links:
  // shareBooting covers the gap while the share token is being fetched).
  if (status === 'loading') {
    return <BootSkeleton />
  }
  if (status === 'unauthenticated' && !isClientSurface && !shareBooting) {
    return <LoginScreen />
  }

  // Welcome / onboarding screen — fresh install with no projects at all (owner app only)
  if (status === 'authenticated' && session?.user?.role !== 'client'
      && !loading && !data && projects.length === 0 && !shareToken) {
    return (
      <>
        <WelcomeScreen onCreate={() => setCreateOpen(true)} />
        <CreateProjectDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreate={handleCreateProject}
          submitting={creating}
        />
      </>
    )
  }

  if (loading && !data) {
    return <BootSkeleton />
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-100 flex-col gap-4 p-6 text-center">
        <HardHat className="w-12 h-12 text-amber-600" />
        <p className="text-stone-600">Could not reach the MjengoOS server.</p>
        <Button onClick={() => void load()} variant="outline">
          <RefreshCw className="w-4 h-4 mr-2" /> Retry
        </Button>
      </div>
    )
  }

  const projectShareToken = data.project.shareToken
  const shareUrl = projectShareToken ? `${origin || ''}/?share=${projectShareToken}` : null
  // Clients never see the AI Copilot tab; guard against a stale tab key too
  const activeTab: TabKey = isClientSurface && tab === 'copilot' ? 'overview' : tab

  return (
    <div className="min-h-screen flex flex-col bg-stone-100">
      <Header
        tab={activeTab}
        onTabChange={setTab}
        onCreateProject={() => setCreateOpen(true)}
        onShare={() => setShareOpen(true)}
      />

      {viewMode === 'client' && (
        isClientSurface ? (
          <DiasporaBanner label="Client view — live site data · read-only" />
        ) : (
          <DiasporaBanner onExit={() => setViewMode('owner')} />
        )
      )}

      {!online && !isClientSurface && (
        <div className="bg-amber-500 text-stone-950 px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium" role="status">
          <CloudOff className="w-4 h-4 shrink-0" aria-hidden />
          <span className="text-center">
            Offline — saving to on-device queue
            {outbox.length > 0 && ` (${outbox.length} pending sync)`}. AI features need connectivity.
          </span>
          {syncing && <RefreshCw className="w-4 h-4 animate-spin" aria-hidden />}
        </div>
      )}

      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6" data-active-project={activeProjectId ?? data.project.id}>
        {activeTab === 'overview' && <OverviewTab onOpenCopilot={() => setTab('copilot')} />}
        {activeTab === 'site' && <SitePlanTab />}
        {activeTab === 'materials' && <MaterialsTab />}
        {activeTab === 'finder' && <FinderTab />}
        {activeTab === 'fundis' && <FundisTab />}
        {activeTab === 'money' && <MoneyTab />}
        {activeTab === 'land' && <LandTab />}
        {activeTab === 'evidence' && <EvidenceTab />}
        {activeTab === 'intel' && <IntelTab />}
        {activeTab === 'copilot' && <CopilotTab />}
        {activeTab === 'ussd' && <UssdTab />}
      </main>

      <footer className="mt-auto bg-stone-950 text-stone-400 pb-[env(safe-area-inset-bottom)]">
        {isClientSurface ? (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <HardHat className="w-4 h-4 text-amber-500" aria-hidden />
              <span className="font-semibold text-stone-200">MjengoOS</span>
              <span className="hidden sm:inline">· Live client view · Your build, verified daily</span>
            </div>
            {/* Share-link visitors may be site team; logged-in client-role users belong here */}
            {isShareClient && !clientRole && (
              <button
                type="button"
                onClick={exitShareView}
                className="text-[11px] text-stone-500 hover:text-stone-300 underline underline-offset-2 min-h-11 px-2 transition-colors"
                aria-label="Site team member? Open the full MjengoOS app"
              >
                Site team? Open the full app
              </button>
            )}
          </div>
        ) : (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <HardHat className="w-4 h-4 text-amber-500" aria-hidden />
              <span className="font-semibold text-stone-200">MjengoOS</span>
              <span className="hidden sm:inline">· Offline-first Construction Site OS · Anchoring AI to physical ground truth</span>
            </div>
            <div className="flex items-center gap-3 text-stone-500">
              <span>AI Copilot: Vision + Swahili ASR + LLM</span>
              <span className="hidden sm:inline">M-Pesa ready</span>
              <span>Nairobi, Kenya</span>
            </div>
          </div>
        )}
      </footer>

      {/* App-level dialogs (owner app only) */}
      {!isClientSurface && (
        <>
          <CreateProjectDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreate={handleCreateProject}
            submitting={creating}
          />
          <ShareDialog
            open={shareOpen}
            onOpenChange={setShareOpen}
            shareUrl={shareUrl}
            previewing={viewMode === 'client'}
            onPreviewingChange={handlePreviewingChange}
            onRegenerate={() => void handleRegenerateShareLink()}
          />
        </>
      )}
    </div>
  )
}
