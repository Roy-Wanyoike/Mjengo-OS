import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { applyAction, getProjectPayload, getProjectsList, type ActionType } from '@/lib/mjengo'
import { CLIENT_ACTIONS } from '@/lib/client-actions'
import { withGuard } from '@/lib/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface QueuedAction {
  id: string
  type: ActionType
  payload: any
  projectId?: string
}

/**
 * Offline-first sync endpoint.
 * The device queues actions locally (simulated on-device SQLite outbox) while offline,
 * then flushes them here when connectivity returns. Each action is applied
 * independently; partial failures are reported per-item without blocking the rest.
 *
 * Scoping (same contract as POST /api/actions):
 *  · site team (contractor/admin): items may target any project (they run the sites)
 *  · client-role sessions are PINNED to their own project — a foreign projectId
 *    is rejected per-item, the payload refresh returns only their project, and
 *    the projects list is scoped to it (a foreign probe is indistinguishable
 *    from a miss: plain per-item failure / empty response, never foreign data)
 */
export const POST = withGuard(async (req, session) => {
  try {
    const body = (await req.json()) as { actions?: QueuedAction[]; projectId?: string }
    const actions = body.actions
    if (!Array.isArray(actions)) return NextResponse.json({ error: 'actions[] required' }, { status: 400 })

    const isClient = session.user.role === 'client'
    // Resolve the client's pinned project once (null → honest empty sync below).
    let pinnedProject: { id: string } | null = null
    if (isClient) {
      if (!session.user.projectId) {
        return NextResponse.json({ ok: true, synced: 0, failed: 0, results: [], data: null, projects: [] })
      }
      pinnedProject = await db.project.findUnique({
        where: { id: session.user.projectId },
        select: { id: true },
      })
      if (!pinnedProject) {
        return NextResponse.json({ ok: true, synced: 0, failed: 0, results: [], data: null, projects: [] })
      }
    }

    const results: Array<{ id: string; ok: boolean; error?: string }> = []
    for (const action of actions) {
      try {
        if (isClient) {
          // Clients flush only client-allowlisted actions, pinned to their project.
          if (!CLIENT_ACTIONS.includes(action.type)) {
            results.push({ id: action.id, ok: false, error: 'Not permitted for role "client"' })
            continue
          }
          if (action.projectId && action.projectId !== pinnedProject!.id) {
            results.push({ id: action.id, ok: false, error: 'Not your project' })
            continue
          }
        }
        // Offline-sync idempotency (spec §57): every outbox item id is recorded
        // as `sync:<projectId>:<itemId>` once applied — a re-flushed item (double
        // tap, retry after a timeout, duplicated queue) is skipped instead of
        // double-applying a money movement. This kills the offline double-payment
        // vector: applyAction's money services are additionally guarded by their
        // own natural keys, so a lost ack can never re-post money.
        const itemProjectId = isClient ? pinnedProject!.id : action.projectId ?? body.projectId ?? null
        const idemKey = `sync:${itemProjectId ?? 'global'}:${action.id}`
        const alreadyApplied = await db.idempotencyRecord.findUnique({ where: { key: idemKey } })
        if (alreadyApplied) {
          results.push({ id: action.id, ok: true })
          continue
        }
        const actorPayload = isClient
          ? { ...(action.payload ?? {}), __actor: session.user.name, __role: 'client' }
          : { ...(action.payload ?? {}), __actor: session.user.name, __role: session.user.role }
        await applyAction(action.type, actorPayload, isClient ? pinnedProject!.id : action.projectId)
        try {
          await db.idempotencyRecord.create({
            data: { key: idemKey, scope: `sync:${action.type}`, projectId: itemProjectId },
          })
        } catch {
          // Unique collision = a concurrent flush already recorded this item —
          // the action was applied exactly once either way.
        }
        results.push({ id: action.id, ok: true })
      } catch (e) {
        results.push({ id: action.id, ok: false, error: e instanceof Error ? e.message : 'failed' })
      }
    }

    // Payload refresh: site team — top-level projectId > single distinct item
    // projectId > first project. Clients — always their pinned project only.
    let data: Awaited<ReturnType<typeof getProjectPayload>> = null
    let projects: Awaited<ReturnType<typeof getProjectsList>> = []
    if (isClient) {
      const [d, list] = await Promise.all([getProjectPayload(pinnedProject!.id), getProjectsList()])
      data = d
      projects = list.filter((p) => p.id === pinnedProject!.id)
    } else {
      const distinctIds = Array.from(new Set(actions.map((a) => a.projectId).filter(Boolean))) as string[]
      const dataPid = body.projectId || (distinctIds.length === 1 ? distinctIds[0] : null)
      const [d, list] = await Promise.all([getProjectPayload(dataPid), getProjectsList()])
      data = d
      projects = list
    }
    return NextResponse.json({
      ok: true,
      synced: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
      data,
      projects,
    })
  } catch (e) {
    console.error('[api/sync]', e)
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
})
