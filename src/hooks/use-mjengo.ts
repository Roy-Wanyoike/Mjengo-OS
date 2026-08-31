'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import type { ProjectPayload, ProjectListItem, ActionType } from '@/lib/mjengo'

export interface OutboxItem {
  id: string
  type: ActionType
  payload: any
  label: string
  createdAt: number
  projectId?: string | null
}

/** Body for POST /api/projects (matches CreateProjectPayload from the dialog). */
export interface CreateProjectInput {
  name: string
  budget: number
  client?: string
  clientType?: string
  location?: string
  startDate?: string
  targetDate?: string
  template?: 'bungalow' | 'maisonette' | 'duplex' | 'blank'
}

export type ViewMode = 'owner' | 'client'

/** Actions a client may perform (shared with the server guards — single source of truth). */
export { CLIENT_ACTIONS } from '@/lib/client-actions'
import { CLIENT_ACTIONS as CLIENT_ACTION_LIST } from '@/lib/client-actions'

interface MjengoState {
  data: ProjectPayload | null
  projects: ProjectListItem[]
  activeProjectId: string | null
  viewMode: ViewMode
  /** Non-null while the app is acting as a real client via /?share=<token> (not the owner preview). */
  shareToken: string | null
  /** True when a logged-in client-ROLE user is in the client view (no share token — they belong there). */
  clientRole: boolean
  /** Set when a share link fails to resolve (invalid/revoked) — drives the dead-link screen. */
  shareError: string | null
  /** Epoch ms of the last time the user opened the notification center. */
  notificationsSeenAt: number | null
  actionBusy: string | null
  loading: boolean
  online: boolean
  syncing: boolean
  outbox: OutboxItem[]
  lastSyncAt: number | null
  load: () => Promise<void>
  /** Boot the public client view from a share token (GET /api/share). */
  bootFromShare: (token: string, fromUrl?: boolean) => Promise<void>
  switchProject: (id: string) => Promise<void>
  createProject: (payload: CreateProjectInput) => Promise<boolean>
  setViewMode: (v: ViewMode) => void
  setOnline: (v: boolean) => void

  dispatch: (type: ActionType, payload: any, label: string) => Promise<boolean>

  applyLocal: (type: ActionType, payload: any) => void
  syncNow: () => Promise<{ synced: number; failed: number } | undefined>
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Client-side optimistic reducer — mirrors the on-device SQLite write for queued actions. */
function reduceLocal(data: ProjectPayload, type: string,
  payload: any): ProjectPayload {
  const d: ProjectPayload = JSON.parse(JSON.stringify(data))
  switch (type) {
    case 'task.update': {
      for (const p of d.phases) {
        const t = p.tasks.find((x) => x.id === payload.id)
        if (t) {
          if (typeof payload.progress === 'number') {
            t.progress = Math.max(0, Math.min(100, payload.progress))
            if (t.progress === 100) t.status = 'done'
            else if (t.progress > 0 && t.status === 'pending') t.status = 'in_progress'
          }
          if (payload.status) t.status = payload.status
        }
      }
      break
    }
    case 'task.create': {
      const p = d.phases.find((x) => x.id === payload.phaseId)
      p?.tasks.push({ id: uid(), phaseId: payload.phaseId, title: payload.title, status: 'pending', progress: 0, dueDate: null, createdAt: new Date(), updatedAt: new Date() } as never)
      break
    }
    case 'task.delete': {
      for (const p of d.phases) {
        const i = p.tasks.findIndex((x) => x.id === payload.id)
        if (i >= 0) { p.tasks.splice(i, 1); break }
      }
      break
    }
    case 'phase.update': {
      const p = d.phases.find((x) => x.id === payload.id)
      if (p) {
        if (typeof payload.progressManual === 'number') { p.progressManual = payload.progressManual; p.progress = payload.progressManual }
        if (payload.status) p.status = payload.status
      }
      break
    }
    case 'phase.create': {
      d.phases.push({
        id: uid(), projectId: d.project.id, name: String(payload.name), order: d.phases.length + 1,
        budget: Number(payload.budget) || 0, status: 'pending', progressManual: null,
        tasks: [], progress: 0, createdAt: new Date(), updatedAt: new Date(),
      } as never)
      d.summary.budgetTotal = d.phases.reduce((s, p) => s + p.budget, 0)
      d.summary.budgetSpentPct = d.summary.budgetTotal
        ? Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
        : 0
      break
    }
    case 'delivery.create': {
      const m = d.materials.find((x) => x.id === payload.materialId)
      if (m) {
        const cost = typeof payload.unitCost === 'number' && payload.unitCost > 0 ? payload.unitCost : m.unitPrice
        const total = payload.quantity * cost
        m.deliveredQty += payload.quantity
        m.deliveredCost += total
        m.onSiteQty += payload.quantity
        m.stockValue = m.onSiteQty * m.unitPrice
        d.deliveries.unshift({
          id: uid(), projectId: d.project.id, materialId: m.id, material: undefined as never,
          quantity: payload.quantity, unitCost: cost, totalCost: total,
          supplier: payload.supplier || 'Unknown supplier', date: new Date(),
          source: payload.source || 'manual', rawTranscript: payload.rawTranscript ?? null, createdAt: new Date(),
        } as never)
        d.summary.budgetSpent += total
        d.summary.materialSpend += total
        d.summary.budgetSpentPct = Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
      }
      break
    }
    case 'consumption.create': {
      const m = d.materials.find((x) => x.id === payload.materialId)
      if (m) {
        m.consumedQty += payload.quantity
        m.onSiteQty = Math.max(0, m.onSiteQty - payload.quantity)
        m.stockValue = m.onSiteQty * m.unitPrice
        d.consumptions.unshift({
          id: uid(), projectId: d.project.id, materialId: m.id, material: undefined as never,
          quantity: payload.quantity, materialName: m.name, unit: m.unit,
          phaseName: payload.phaseName ?? null, date: new Date(), note: payload.note ?? null, createdAt: new Date(),
        } as never)
      }
      break
    }
    case 'attendance.checkin': {
      const w = d.workers.find((x) => x.id === payload.workerId)
      if (w) {
        if (!w.todayStatus.status) {
          w.todayStatus = { status: 'present', checkIn: new Date().toISOString(), checkOut: null, method: payload.method || 'geofence', wage: w.dailyRate, paid: false, verification: 'verified', exceptionReason: null }
          d.summary.fundisToday += 1
          d.summary.wagesToday += w.dailyRate
        } else if (payload.toggle === 'out') {
          w.todayStatus = { ...w.todayStatus, checkOut: new Date().toISOString() }
        }
      }
      break
    }
    case 'attendance.setStatus': {
      const w = d.workers.find((x) => x.id === payload.workerId)
      if (w) {
        const prevWage = w.todayStatus.wage
        const wage = payload.status === 'present' ? w.dailyRate : payload.status === 'half_day' ? w.dailyRate / 2 : 0
        if (!w.todayStatus.status) d.summary.fundisToday += payload.status === 'absent' ? 0 : 1
        w.todayStatus = { ...w.todayStatus, status: payload.status, wage, paid: false }
        d.summary.wagesToday += wage - prevWage
      }
      break
    }
    case 'worker.create': {
      d.workers.push({
        id: uid(), projectId: d.project.id, name: payload.name, role: payload.role || 'Mtumishi (Labourer)',
        phone: payload.phone || '', dailyRate: Number(payload.dailyRate) || 800, active: true,
        attendances: [], todayStatus: { status: null, checkIn: null, checkOut: null, method: null, wage: 0, paid: false }, weekEarnings: 0,
      } as never)
      d.summary.fundisExpected += 1
      break
    }
    case 'worker.update': {
      const w = d.workers.find((x) => x.id === payload.id)
      if (w) {
        if (typeof payload.name === 'string' && payload.name.trim()) w.name = payload.name.trim()
        if (typeof payload.role === 'string' && payload.role.trim()) w.role = payload.role
        if (typeof payload.phone === 'string') w.phone = payload.phone
        if (typeof payload.dailyRate === 'number' && payload.dailyRate >= 0) w.dailyRate = payload.dailyRate
        if (typeof payload.active === 'boolean') {
          const wasActive = w.active
          w.active = payload.active
          if (wasActive && !payload.active) d.summary.fundisExpected = Math.max(0, d.summary.fundisExpected - 1)
          else if (!wasActive && payload.active) d.summary.fundisExpected += 1
        }
      }
      break
    }
    case 'expense.create': {
      const amount = Number(payload.amount) || 0
      d.transactions.unshift({
        id: uid(), projectId: d.project.id, type: payload.type, amount,
        method: payload.method || 'mpesa', reference: payload.reference ?? null, note: payload.note ?? null,
        date: payload.date ? new Date(payload.date) : new Date(), createdAt: new Date(),
      } as never)
      d.summary.budgetSpent += amount
      if (payload.type === 'material') d.summary.materialSpend += amount
      d.summary.budgetSpentPct = d.summary.budgetTotal
        ? Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
        : 0
      break
    }
    case 'transaction.delete': {
      const i = d.transactions.findIndex((t) => t.id === payload.id)
      if (i >= 0) {
        const [tx] = d.transactions.splice(i, 1)
        d.summary.budgetSpent = Math.max(0, d.summary.budgetSpent - tx.amount)
        if (tx.type === 'material') d.summary.materialSpend = Math.max(0, d.summary.materialSpend - tx.amount)
        d.summary.budgetSpentPct = d.summary.budgetTotal
          ? Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
          : 0
      }
      break
    }
    case 'material.create': {
      d.materials.push({
        id: uid(), name: String(payload.name), unit: String(payload.unit), unitPrice: Number(payload.unitPrice) || 0,
        deliveredQty: 0, deliveredCost: 0, consumedQty: 0, onSiteQty: 0, stockValue: 0, deliveries: [],
        createdAt: new Date(), updatedAt: new Date(),
      } as never)
      break
    }
    case 'project.update': {
      const p = d.project
      if (typeof payload.name === 'string' && payload.name.trim()) p.name = payload.name.trim()
      if (typeof payload.client === 'string' && payload.client.trim()) p.client = payload.client.trim()
      if (typeof payload.clientType === 'string' && payload.clientType.trim()) p.clientType = payload.clientType
      if (typeof payload.location === 'string' && payload.location.trim()) p.location = payload.location.trim()
      if (typeof payload.status === 'string' && payload.status) p.status = payload.status
      if (typeof payload.startDate === 'string') p.startDate = new Date(payload.startDate) as never
      if (typeof payload.targetDate === 'string') p.targetDate = new Date(payload.targetDate) as never
      if (typeof payload.budget === 'number' && payload.budget > 0) {
        p.budget = payload.budget
        // Rescale phase budgets proportionally (same rule as the server)
        const currentTotal = d.phases.reduce((s, ph) => s + ph.budget, 0)
        if (currentTotal > 0 && d.phases.length) {
          const scale = payload.budget / currentTotal
          for (const ph of d.phases) ph.budget = Math.round(ph.budget * scale)
        }
        d.summary.budgetTotal = d.phases.reduce((s, ph) => s + ph.budget, 0)
        d.summary.budgetSpentPct = d.summary.budgetTotal
          ? Math.round((d.summary.budgetSpent / d.summary.budgetTotal) * 100)
          : 0
      }
      break
    }
    case 'wages.pay': {
      for (const w of d.workers) {
        if (w.todayStatus.status && !w.todayStatus.paid) {
          w.todayStatus.paid = true
          d.summary.wagesUnpaid = Math.max(0, d.summary.wagesUnpaid - w.todayStatus.wage)
        }
      }
      break
    }
    case 'alert.ack': {
      const a = d.alerts.find((x) => x.id === payload.id)
      if (a) { a.acknowledged = true; d.summary.unackedAlerts = Math.max(0, d.summary.unackedAlerts - 1) }
      break
    }
    case 'photo.apply': {
      const p = d.phases.find((x) => x.id === payload.phaseId)
      if (p && typeof payload.progressPct === 'number' && payload.progressPct > p.progress) {
        p.progress = payload.progressPct
        p.progressManual = payload.progressPct
        if (payload.progressPct >= 100) p.status = 'done'
      }
      break
    }
    // ---- Money / Evidence optimistic cases (best-effort mirrors of server modules) ----
    case 'escrow.topup': {
      const amount = Number(payload.amount) || 0
      if (amount > 0) {
        if (d.escrow) d.escrow.balance += amount
        else d.escrow = { id: uid(), projectId: d.project.id, balance: amount, createdAt: new Date(), updatedAt: new Date() } as never
      }
      break
    }
    case 'milestone.decide': {
      const m = d.milestones.find((x) => x.id === payload.id)
      if (m && m.status === 'release_requested') {
        if (payload.decision === 'approve') {
          m.status = 'released'
          m.releasedAt = new Date() as never
          if (d.escrow) d.escrow.balance = Math.max(0, d.escrow.balance - m.amount)
        } else {
          m.status = 'rejected'
        }
        m.decidedBy = String(payload.by ?? 'Client')
        m.decidedAt = new Date() as never
        if (typeof payload.note === 'string' && payload.note.trim()) m.decisionNote = payload.note.trim()
      }
      break
    }
    case 'variation.decide': {
      const v = d.variations.find((x) => x.id === payload.id)
      if (v && v.status === 'submitted') {
        v.status = payload.decision === 'approve' ? 'approved' : 'rejected'
        v.decidedBy = String(payload.by ?? 'Client')
        v.decidedAt = new Date() as never
        if (typeof payload.note === 'string' && payload.note.trim()) v.decisionNote = payload.note.trim()
      }
      break
    }
    case 'comment.add': {
      const text = typeof payload.message === 'string' ? payload.message.trim() : ''
      if (payload.photoId && text) {
        d.photoComments.unshift({
          id: uid(), photoId: String(payload.photoId), projectId: d.project.id,
          author: String(payload.author ?? 'Client'), role: String(payload.role ?? 'client'),
          message: text, resolved: false, createdAt: new Date(),
        } as never)
      }
      break
    }
    case 'notification.read': {
      const n = d.notifications.find((x) => x.id === payload.id)
      if (n) n.read = true
      break
    }
    case 'notification.readAll': {
      for (const n of d.notifications) n.read = true
      break
    }
    case 'zone.create': {
      const name = typeof payload.name === 'string' ? payload.name.trim() : ''
      if (name) {
        d.zones.push({
          id: uid(), projectId: d.project.id, name,
          x: Math.max(0, Math.min(100, Number(payload.x) || 0)),
          y: Math.max(0, Math.min(100, Number(payload.y) || 0)),
          w: Math.max(4, Math.min(100, Number(payload.w) || 20)),
          h: Math.max(4, Math.min(100, Number(payload.h) || 14)),
          createdAt: new Date(),
        } as never)
      }
      break
    }
    case 'zone.delete': {
      const zi = d.zones.findIndex((z) => z.id === payload.id)
      if (zi >= 0) {
        const [z] = d.zones.splice(zi, 1)
        for (const p of d.photos) if (p.zoneId === z.id) p.zoneId = null
      }
      break
    }
  }
  return d
}

export const useMjengo = create<MjengoState>()(
  persist(
    (set, get) => ({
      data: null,
      projects: [],
      activeProjectId: null,
      viewMode: 'owner',
      shareToken: null,
      clientRole: false,
      shareError: null,
      notificationsSeenAt: null,
      actionBusy: null,
      loading: true,
      online: true,
      syncing: false,
      outbox: [],
      lastSyncAt: null,

      bootFromShare: async (token: string, fromUrl = false) => {
        set({ loading: !get().data, shareError: null })
        try {
          const res = await fetch(`/api/share?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
          if (res.status === 404 || !res.ok) {
            // A dead token in the URL deserves the invalid-link screen; a stale
            // persisted token (owner reseeded/regenerated) silently falls back to owner mode.
            if (fromUrl) {
              set({ shareError: 'This share link is invalid or has been revoked', loading: false, shareToken: null })
            } else {
              set({ shareToken: null, viewMode: 'owner' })
              await get().load()
            }
            return
          }
          const json = await res.json()
          if (!json?.ok || !json.data) {
            if (fromUrl) {
              set({ shareError: 'This share link is invalid or has been revoked', loading: false, shareToken: null })
            } else {
              set({ shareToken: null, viewMode: 'owner' })
              await get().load()
            }
            return
          }
          set({
            data: json.data as ProjectPayload,
            activeProjectId: (json.data as ProjectPayload).project.id,
            viewMode: 'client',
            shareToken: token,
            shareError: null,
            loading: false,
          })
        } catch {
          // Network failure on a persisted token → still allow owner mode fallback
          if (fromUrl) {
            set({ shareError: 'Could not reach MjengoOS — check your connection', loading: false })
          } else {
            set({ shareToken: null, viewMode: 'owner', loading: false })
            await get().load()
          }
        }
      },

      load: async () => {
        set({ loading: !get().data })
        try {
          const { activeProjectId } = get()
          const [projectsRes, projectRes] = await Promise.all([
            fetch('/api/projects', { cache: 'no-store' }),
            fetch(`/api/project${activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : ''}`, { cache: 'no-store' }),
          ])
          const projectsJson = projectsRes.ok ? await projectsRes.json().catch(() => null) : null
          const listLoaded = Boolean(projectsJson?.ok)
          const projects: ProjectListItem[] = listLoaded ? (projectsJson.projects as ProjectListItem[]) : get().projects
          if (listLoaded && projects.length === 0) {
            // Fresh install — no projects yet, show the welcome screen
            set({ projects: [], data: null, activeProjectId: null, loading: false })
            return
          }
          if (projectRes.ok) {
            const data = (await projectRes.json()) as ProjectPayload
            set({ data, projects, activeProjectId: data.project.id, loading: false })
          } else {
            // Active project may have been deleted — fall back to the first project
            const fallbackRes = await fetch('/api/project', { cache: 'no-store' })
            if (fallbackRes.ok) {
              const data = (await fallbackRes.json()) as ProjectPayload
              set({ data, projects, activeProjectId: data.project.id, loading: false })
            } else {
              set({ projects, loading: false })
            }
          }
        } catch {
          set({ loading: false })
        }
      },

      switchProject: async (id) => {
        const { data, activeProjectId } = get()
        if (id === activeProjectId && data?.project?.id === id) return
        set({ loading: true, activeProjectId: id })
        try {
          const res = await fetch(`/api/project?projectId=${encodeURIComponent(id)}`, { cache: 'no-store' })
          if (res.ok) {
            const newData = (await res.json()) as ProjectPayload
            set({ data: newData, activeProjectId: newData.project.id, loading: false })
            toast.success(`Switched to ${newData.project.name}`)
          } else {
            set({ loading: false })
            toast.error('Could not open that project')
          }
        } catch {
          set({ loading: false })
          toast.error('Network error — could not switch project')
        }
      },

      createProject: async (payload) => {
        try {
          const res = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const json = await res.json()
          if (json.ok && json.data) {
            set({
              data: json.data,
              projects: (json.projects ?? get().projects) as ProjectListItem[],
              activeProjectId: json.result.id,
              lastSyncAt: Date.now(),
              loading: false,
            })
            return true
          }
          console.error('create project failed', json.error)
          return false
        } catch (e) {
          console.error('create project failed', e)
          return false
        }
      },

      setViewMode: (v) => set({ viewMode: v }),

      setOnline: (v) => {
        set({ online: v })
        if (v && get().outbox.length > 0) {
          void get().syncNow()
        }
      },

      dispatch: async (type, payload, label) => {
        const { viewMode, shareToken, clientRole } = get()
        // Real client on a share link: only the decision allowlist goes through /api/share
        if (viewMode === 'client' && shareToken && CLIENT_ACTION_LIST.includes(type)) {
          set({ actionBusy: label })
          try {
            const res = await fetch('/api/share', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: shareToken, type, payload }),
            })
            const json = await res.json()
            if (json.ok && json.data) {
              set({ data: json.data, lastSyncAt: Date.now() })
              return true
            }
            console.error('client action failed', json.error)
            return false
          } catch {
            return false
          } finally {
            set({ actionBusy: null })
          }
        }
        // Logged-in client-role user (session cookie is the auth): same allowlist via /api/actions
        if (viewMode === 'client' && !shareToken && clientRole && CLIENT_ACTION_LIST.includes(type)) {
          set({ actionBusy: label })
          try {
            const projectId = get().data?.project?.id ?? get().activeProjectId ?? undefined
            const res = await fetch('/api/actions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type, payload, projectId }),
            })
            const json = await res.json()
            if (json.ok && json.data) {
              set({ data: json.data, lastSyncAt: Date.now() })
              return true
            }
            console.error('client-role action failed', json.error)
            return false
          } catch {
            return false
          } finally {
            set({ actionBusy: null })
          }
        }
        if (viewMode === 'client') {
          toast.info('Read-only client view — site data is managed by the site team')
          return false
        }
        const { online } = get()
        const projectId = get().data?.project?.id ?? get().activeProjectId ?? undefined
        if (online) {
          set({ actionBusy: label })
          try {
            const res = await fetch('/api/actions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type, payload, projectId }),
            })
            const json = await res.json()
            if (json.ok && json.data) {
              set({
                data: json.data,
                projects: (json.projects ?? get().projects) as ProjectListItem[],
                lastSyncAt: Date.now(),
              })
              return true
            }
            console.error('action failed', json.error)
            return false
          } catch {
            return false
          } finally {
            set({ actionBusy: null })
          }
        }
        // Offline: optimistic local write + queue for sync
        const item: OutboxItem = { id: uid(), type, payload, label, createdAt: Date.now(), projectId: projectId ?? null }
        const data = get().data
        if (data) set({ data: reduceLocal(data, type, payload) })
        set({ outbox: [...get().outbox, item] })
        return true
      },

      applyLocal: (type, payload) => {
        const data = get().data
        if (data) set({ data: reduceLocal(data, type, payload) })
      },

      syncNow: async () => {
        const { outbox } = get()
        if (!outbox.length || get().syncing) { set({ lastSyncAt: Date.now() }); return }
        set({ syncing: true })
        try {
          const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              actions: outbox.map(({ id, type, payload, projectId }) => ({ id, type, payload, projectId })),
            }),
          })
          const json = await res.json()
          if (json.ok) {
            const failedIds = new Set((json.results ?? []).filter((r: { ok: boolean }) => !r.ok).map((r: { id: string }) => r.id))
            set({
              outbox: outbox.filter((o) => failedIds.has(o.id)),
              data: json.data ?? get().data,
              projects: (json.projects ?? get().projects) as ProjectListItem[],
              lastSyncAt: Date.now(),
            })
            return json as { synced: number; failed: number }
          }
        } catch (e) {
          console.error('sync failed', e)
        } finally {
          set({ syncing: false })
        }
      },
    }),
    {
      name: 'mjengo-os-store',
      partialize: (s) => ({
        online: s.online,
        outbox: s.outbox,
        data: s.data,
        lastSyncAt: s.lastSyncAt,
        activeProjectId: s.activeProjectId,
        shareToken: s.shareToken,
      }),
    },
  ),
)
