'use client'

// Admin Audit Log (W3-F1 · spec §44 “Admin → Audit Logs”).
//
// Surface: admin role ONLY — the tab is hidden from every other role by
// src/lib/permissions.ts ROLE_TABS, and this component ALSO renders an
// access-denied panel when reached by a non-admin (fail closed, never trust
// navigation alone) or when the API answers 403.
//
// Data: GET /api/audit (backend W3-B) —
//   ?actor&role&projectId&entity&kind&from&to&q&limit&cursor
//   → { ok: true, data: AuditEventRow[], nextCursor: string | null, hasMore }
// Rows stream newest-first; “Load more” appends via nextCursor.
// The audit trail is read-only here — no mutations, no dispatch.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMjengo } from '@/hooks/use-mjengo'
import { usePermissions, KNOWN_ROLES, labelForRole } from '@/lib/permissions'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  ScrollText, Search, RotateCcw, ShieldAlert, Loader2, ChevronRight,
  Fingerprint, Globe, MonitorSmartphone, Server, Activity,
} from 'lucide-react'
import { dateShort, timeEAT } from '@/lib/format'
import { EmptyState } from '@/components/mjengo/uikit/empty-state'

// ---------------- API contract types (mirror of W3-B route) ----------------

interface AuditEventRow {
  id: string
  projectId: string
  kind: string
  actor: string
  role: string
  summary: string
  meta?: string | Record<string, unknown> | null
  entity?: string | null
  entityId?: string | null
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
  createdAt: string
}

interface AuditResponse {
  ok: boolean
  data?: AuditEventRow[]
  nextCursor?: string | null
  hasMore?: boolean
  error?: string
}

// ---------------- filter option sets ----------------

/** Audit kinds the platform writes (prisma schema comment + lib/audit kindForAction). */
const AUDIT_KINDS: readonly string[] = [
  'task', 'phase', 'delivery', 'material', 'consumption', 'attendance', 'wage',
  'worker', 'alert', 'photo', 'project', 'expense', 'transaction', 'share',
  'escrow', 'milestone', 'variation', 'comment', 'notification', 'site_map',
  'inventory', 'boq', 'payment', 'wallet', 'ledger', 'auth', 'export', 'action',
]

/** Actor roles seen in the audit trail: platform roles + system/AI writers. */
const AUDIT_ROLES: readonly string[] = [...KNOWN_ROLES, 'system', 'ai', 'foreman']

const PAGE_LIMIT = 25

/** Role badge tint (mirrors header UserChip role colors). */
function roleBadgeClass(role: string): string {
  if (role === 'admin') return 'bg-stone-800 text-stone-100 hover:bg-stone-800 border-0'
  if (role === 'client') return 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-0'
  if (role === 'system' || role === 'ai') return 'bg-stone-100 text-stone-600 hover:bg-stone-100 border-0'
  return 'bg-amber-100 text-amber-900 hover:bg-amber-100 border-0'
}

/** meta arrives as JSON or a plain string — pretty-print either way. */
function prettyMeta(meta: AuditEventRow['meta']): string | null {
  if (meta === null || meta === undefined || meta === '') return null
  if (typeof meta === 'string') {
    try {
      return JSON.stringify(JSON.parse(meta), null, 2)
    } catch {
      return meta
    }
  }
  try {
    return JSON.stringify(meta, null, 2)
  } catch {
    return String(meta)
  }
}

function kindLabel(kind: string): string {
  return kind.replace(/_/g, ' ')
}

// ---------------- component ----------------

interface Filters {
  actor: string
  role: string
  kind: string
  from: string
  to: string
  q: string
}

const EMPTY_FILTERS: Filters = { actor: '', role: '', kind: '', from: '', to: '', q: '' }

export function AuditTab() {
  const { role, authenticated } = usePermissions()
  const projectId = useMjengo((s) => s.data?.project?.id ?? null)

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS) // form state
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS) // last applied
  const [rows, setRows] = useState<AuditEventRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [denied, setDenied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<AuditEventRow | null>(null)

  const isAdmin = authenticated && role === 'admin'

  /** Count of non-empty applied filters (shown in the results header). */
  const activeFilterCount = useMemo(
    () => Object.values(applied).filter((v) => v !== '').length,
    [applied],
  )

  /** Fetch one page. `cursor` set → append (Load more); else replace. */
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const appending = cursor !== null
      if (appending) setLoadingMore(true)
      else setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (projectId) params.set('projectId', projectId)
        if (applied.actor.trim()) params.set('actor', applied.actor.trim())
        if (applied.role) params.set('role', applied.role)
        if (applied.kind) params.set('kind', applied.kind)
        if (applied.from) params.set('from', applied.from)
        if (applied.to) params.set('to', applied.to)
        if (applied.q.trim()) params.set('q', applied.q.trim())
        params.set('limit', String(PAGE_LIMIT))
        if (cursor) params.set('cursor', cursor)

        const res = await fetch(`/api/audit?${params.toString()}`, { cache: 'no-store' })
        if (res.status === 403) {
          setDenied('The server rejected this request — audit logs are admin-only.')
          setRows([])
          setHasMore(false)
          setNextCursor(null)
          return
        }
        if (res.status === 401) {
          setError('Session expired — sign in again to view the audit trail.')
          return
        }
        const json = (await res.json()) as AuditResponse
        if (!json.ok || !json.data) {
          setError(json.error ?? `Request failed (${res.status})`)
          if (!appending) {
            setRows([])
            setHasMore(false)
            setNextCursor(null)
          }
          return
        }
        setDenied(null)
        setRows((prev) => (appending ? [...prev, ...json.data!] : json.data!))
        setNextCursor(json.nextCursor ?? null)
        setHasMore(Boolean(json.hasMore))
      } catch {
        setError('Network error — could not reach the audit API.')
      } finally {
        if (appending) setLoadingMore(false)
        else setLoading(false)
      }
    },
    [applied, projectId],
  )

  // First page whenever the applied filters or project change
  useEffect(() => {
    if (!isAdmin) return
    void fetchPage(null)
  }, [isAdmin, fetchPage])

  /** Apply the form filters → refetch from the top. */
  function applyFilters() {
    setApplied({ ...filters, actor: filters.actor.trim(), q: filters.q.trim() })
  }

  /** Reset form + applied filters → unfiltered first page. */
  function resetFilters() {
    setFilters(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
  }

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((f) => ({ ...f, [key]: value }))
  }

  // ---------------- access gate (fail closed) ----------------

  if (!isAdmin) {
    return (
      <Card className="border-stone-200 shadow-sm max-w-xl mx-auto">
        <CardContent className="p-8 flex flex-col items-center text-center gap-4">
          <div className="w-14 h-14 rounded-full bg-stone-200 flex items-center justify-center" aria-hidden>
            <ShieldAlert className="w-7 h-7 text-stone-500" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-lg font-bold text-stone-900">Admin only</h1>
            <p className="text-sm text-stone-500 leading-relaxed">
              The audit log is restricted to platform administrators.
              {role ? ` You are signed in as ${labelForRole(role)}.` : ' You are not signed in.'}
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const detailMeta = prettyMeta(detail?.meta)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
          <ScrollText className="w-6 h-6 text-amber-600" aria-hidden /> Audit log
        </h1>
        <p className="text-sm text-stone-500 mt-1">
          Every write on this platform lands here — who, what, when, from where. Read-only trail, newest first.
        </p>
      </div>

      {/* Filter bar */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-stone-700 flex items-center gap-2">
            <Search className="w-4 h-4 text-stone-400" aria-hidden /> Filters
          </CardTitle>
          <CardDescription className="text-xs">
            Narrow the trail by actor, role, kind or date range · press Apply to run
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="audit-actor" className="text-xs font-medium text-stone-600">Actor</label>
              <Input
                id="audit-actor"
                value={filters.actor}
                onChange={(e) => updateFilter('actor', e.target.value)}
                placeholder="Name or email"
                className="min-h-11"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="audit-role" className="text-xs font-medium text-stone-600">Role</label>
              <Select value={filters.role} onValueChange={(v) => updateFilter('role', v === 'all' ? '' : v)}>
                <SelectTrigger id="audit-role" className="min-h-11 w-full" aria-label="Filter by role">
                  <SelectValue placeholder="All roles" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="min-h-9">All roles</SelectItem>
                  {AUDIT_ROLES.map((r) => (
                    <SelectItem key={r} value={r} className="min-h-9">{labelForRole(r) === 'Unknown' ? r : labelForRole(r)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="audit-kind" className="text-xs font-medium text-stone-600">Kind</label>
              <Select value={filters.kind} onValueChange={(v) => updateFilter('kind', v === 'all' ? '' : v)}>
                <SelectTrigger id="audit-kind" className="min-h-11 w-full" aria-label="Filter by event kind">
                  <SelectValue placeholder="All kinds" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="all" className="min-h-9">All kinds</SelectItem>
                  {AUDIT_KINDS.map((k) => (
                    <SelectItem key={k} value={k} className="min-h-9">{kindLabel(k)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="audit-from" className="text-xs font-medium text-stone-600">From date</label>
              <Input
                id="audit-from"
                type="date"
                value={filters.from}
                onChange={(e) => updateFilter('from', e.target.value)}
                className="min-h-11"
                aria-label="Events from this date"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="audit-to" className="text-xs font-medium text-stone-600">To date</label>
              <Input
                id="audit-to"
                type="date"
                value={filters.to}
                onChange={(e) => updateFilter('to', e.target.value)}
                className="min-h-11"
                aria-label="Events up to this date"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="audit-q" className="text-xs font-medium text-stone-600">Search text</label>
              <Input
                id="audit-q"
                value={filters.q}
                onChange={(e) => updateFilter('q', e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilters() }}
                placeholder="Summary, entity, request id…"
                className="min-h-11"
                autoComplete="off"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              onClick={applyFilters}
              disabled={loading || loadingMore}
              className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white min-h-9"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Search className="w-4 h-4" aria-hidden />}
              Apply filters
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={resetFilters}
              disabled={loading || loadingMore || (activeFilterCount === 0 && rows.length === 0)}
              className="gap-1.5 min-h-9"
            >
              <RotateCcw className="w-4 h-4" aria-hidden /> Reset
            </Button>
            {activeFilterCount > 0 && (
              <span className="text-xs text-stone-500" aria-live="polite">
                {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} active
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Server-side access denial (403) */}
      {denied && (
        <Card className="border-red-200 bg-red-50/60 shadow-sm" role="alert">
          <CardContent className="p-4 flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-red-800">Access denied</p>
              <p className="text-xs text-red-700 mt-0.5">{denied}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Request error (non-403) */}
      {error && !denied && (
        <Card className="border-amber-200 bg-amber-50/60 shadow-sm" role="alert">
          <CardContent className="p-4 flex items-start gap-3">
            <Activity className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-900">Could not load the audit trail</p>
              <p className="text-xs text-amber-800 mt-0.5">{error}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 gap-1.5 min-h-9"
                onClick={() => void fetchPage(null)}
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden /> Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      <Card className="border-stone-200 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-stone-700 flex items-center justify-between gap-2 flex-wrap">
            <span>Events</span>
            {!loading && (
              <span className="text-xs font-normal text-stone-400">
                {rows.length} shown{hasMore ? ' · more available' : ' · end of trail'}
              </span>
            )}
          </CardTitle>
          <CardDescription className="text-xs">
            Tap a row for the full event — meta, IP, request id. Times in EAT.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {loading ? (
            <div className="px-4 pb-4 pt-1 space-y-2">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-4 w-28 shrink-0" />
                  <Skeleton className="h-4 w-20 shrink-0" />
                  <Skeleton className="h-4 flex-1 max-w-md" />
                  <Skeleton className="h-4 w-16 shrink-0 hidden sm:block" />
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4 text-stone-500 text-xs">Time</TableHead>
                    <TableHead className="text-stone-500 text-xs">Actor</TableHead>
                    <TableHead className="text-stone-500 text-xs">Kind</TableHead>
                    <TableHead className="text-stone-500 text-xs min-w-48">Summary</TableHead>
                    <TableHead className="text-stone-500 text-xs hidden md:table-cell">Entity</TableHead>
                    <TableHead className="w-8" aria-label="Expand row" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && !denied && !error && (
                    <TableRow>
                      <TableCell colSpan={6} className="p-0">
                        <EmptyState
                          compact
                          icon={ScrollText}
                          title="No audit events match these filters."
                          description={
                            activeFilterCount > 0
                              ? 'Try widening the date range or clearing filters.'
                              : 'Nothing has been logged for this project yet.'
                          }
                        />
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((row) => (
                    <TableRow
                      key={row.id}
                      tabIndex={0}
                      role="button"
                      aria-haspopup="dialog"
                      aria-label={`Audit event: ${row.summary}`}
                      onClick={() => setDetail(row)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setDetail(row)
                        }
                      }}
                      className="cursor-pointer"
                    >
                      <TableCell className="pl-4 text-xs text-stone-500 whitespace-nowrap">
                        <span className="block font-medium text-stone-700">{dateShort(row.createdAt)}</span>
                        <span>{timeEAT(row.createdAt)}</span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium text-stone-800">{row.actor}</span>
                          <Badge className={`text-[10px] w-fit ${roleBadgeClass(row.role)}`}>{row.role}</Badge>
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge variant="outline" className="text-[10px] bg-stone-50 capitalize">
                          {kindLabel(row.kind)}
                        </Badge>
                      </TableCell>
                      <TableCell className="min-w-48 max-w-lg">
                        <span className="text-sm text-stone-700 block truncate" title={row.summary}>{row.summary}</span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-stone-500">
                        {row.entity ? (
                          <span title={row.entityId ?? undefined}>
                            {row.entity}{row.entityId ? ` ·${row.entityId.slice(-6)}` : ''}
                          </span>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="pr-4">
                        <ChevronRight className="w-4 h-4 text-stone-300" aria-hidden />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Load more (cursor pagination, appends) */}
          {!loading && hasMore && (
            <div className="p-4 border-t border-stone-100">
              <Button
                variant="outline"
                className="w-full sm:w-auto min-h-11 gap-1.5"
                disabled={loadingMore || !nextCursor}
                onClick={() => void fetchPage(nextCursor)}
              >
                {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ChevronRight className="w-4 h-4" aria-hidden />}
                {loadingMore ? 'Loading…' : 'Load more events'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Row detail dialog */}
      <Dialog open={Boolean(detail)} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="text-stone-900 flex items-center gap-2 flex-wrap">
                  <Badge className={`text-[10px] ${roleBadgeClass(detail.role)}`}>{detail.role}</Badge>
                  <Badge variant="outline" className="text-[10px] bg-stone-50 capitalize">{kindLabel(detail.kind)}</Badge>
                  <span className="text-sm font-normal text-stone-400">
                    {dateShort(detail.createdAt)} · {timeEAT(detail.createdAt)} EAT
                  </span>
                </DialogTitle>
                <DialogDescription className="text-stone-700 pt-1">{detail.summary}</DialogDescription>
              </DialogHeader>

              <dl className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-2.5 text-sm">
                <dt className="text-xs font-semibold text-stone-500 flex items-center gap-1.5"><Fingerprint className="w-3.5 h-3.5" aria-hidden /> Actor</dt>
                <dd className="text-stone-800">{detail.actor}</dd>
                <dt className="text-xs font-semibold text-stone-500 flex items-center gap-1.5"><Server className="w-3.5 h-3.5" aria-hidden /> Entity</dt>
                <dd className="text-stone-800 break-all">
                  {detail.entity ?? '—'}{detail.entityId ? <span className="text-stone-400"> · {detail.entityId}</span> : null}
                </dd>
                <dt className="text-xs font-semibold text-stone-500 flex items-center gap-1.5"><Globe className="w-3.5 h-3.5" aria-hidden /> IP</dt>
                <dd className="text-stone-800 break-all">{detail.ip ?? '—'}</dd>
                <dt className="text-xs font-semibold text-stone-500 flex items-center gap-1.5"><MonitorSmartphone className="w-3.5 h-3.5" aria-hidden /> Agent</dt>
                <dd className="text-xs text-stone-600 break-all leading-snug">{detail.userAgent ?? '—'}</dd>
                <dt className="text-xs font-semibold text-stone-500 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" aria-hidden /> Request</dt>
                <dd className="text-xs text-stone-600 break-all">{detail.requestId ?? '—'}</dd>
              </dl>

              {detailMeta ? (
                <div>
                  <p className="text-xs font-semibold text-stone-500 mb-1.5">Detail (meta)</p>
                  <pre className="text-[11px] leading-relaxed text-stone-700 bg-stone-50 border border-stone-200 rounded-lg p-3 max-h-64 overflow-auto whitespace-pre-wrap break-all [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-thumb]:rounded-full">
                    {detailMeta}
                  </pre>
                </div>
              ) : (
                <p className="text-xs text-stone-400">No extra meta recorded for this event.</p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
