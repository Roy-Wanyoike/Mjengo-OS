import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/backend/lib/db'
import { applyAction, getProjectPayload, getProjectsList, type ActionType } from '@/backend/lib/mjengo'
import { CLIENT_ACTIONS } from '@/shared/client-actions'
import { withGuard } from '@/backend/lib/guard'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * OFFLINE-FIRST SYNC + DETERMINISTIC CONFLICT RESOLUTION (spec §40 / §41, W1-SYNC)
 * ============================================================================
 * The device queues actions locally while offline, then flushes them here.
 * Each item is applied independently; per-item results now carry a THIRD
 * outcome besides ok / error:
 *
 *   { ok: false, conflict: true, reason, rule }   with rule ∈ server-wins | human-decides
 *
 * THE DETERMINISTIC RULE (one comment, whole system):
 *   1. FINANCIAL / LEDGER ROWS (escrow.topup, milestone.decide, variation.decide,
 *      invoice.pay/decide, wages.pay, payment.decide/pay) → THE SERVER ALWAYS WINS.
 *      Money movements are double-entry and append-only; a queued replay with
 *      different values than the ledger already recorded is NEVER applied and
 *      never silently overwrites the recorded rows. "keep-mine" is refused
 *      honestly — the only remediation is a NEW correcting action (reversal/
 *      journal entry), not an edit of history.
 *   2. FIELD ROWS (attendance, task status/progress, material notes) → HUMAN
 *      RESOLUTION IS OFFERED (rule 'human-decides'): the server explains the
 *      diverging record and keeps BOTH sides — the queued edit only applies
 *      when the human re-sends it with force ('keep-mine'). The DEFAULT
 *      suggestion is the SERVER version (keep-server) — never a silent overwrite.
 *   3. EXACT-IDEMPOTENT REPLAYS are silent successes, never conflicts:
 *      · same outbox item re-flushed → Idempotency-Key dedupe (spec §57, unchanged)
 *      · same payload re-queued under a new item id, for actions whose replay is
 *        semantically a no-op (attendance / task state / flags / decided money
 *        rows) → payload-fingerprint dedupe below → one apply, both items synced.
 *
 * Conflict detection happens as READ-ONLY prisma pre-checks BEFORE applyAction
 * runs (lib/mjengo.ts appliers are untouched — read-only to this route), so a
 * conflicted item is never half-applied and produces no audit event. Financial
 * rows without a natural key (references/ids) cannot be compared against a
 * prior application — they fall through to the normal appliers, exactly as today.
 */
interface QueuedAction {
  id: string
  type: ActionType
  payload: any
  projectId?: string
  /** W1-SYNC conflict resolution: a 'keep-mine' decision re-submits the item with force. */
  force?: boolean
}

type ConflictRule = 'server-wins' | 'human-decides'

type SyncItemResult =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string }
  | { id: string; ok: false; conflict: true; reason: string; rule: ConflictRule }

/** Pre-check verdict: a conflict (with its rule + human-readable reason), an identical replay, or nothing. */
type Precheck = { rule: ConflictRule; reason: string } | { silent: true } | null

/** The financial family: re-applies with different values are server-wins conflicts (§41). */
const FINANCIAL_TYPES = new Set<string>([
  'escrow.topup', 'milestone.decide', 'variation.decide',
  'invoice.pay', 'invoice.decide', 'wages.pay',
  'payment.decide', 'payment.pay',
])

/**
 * Actions whose EXACT replay is semantically a no-op (state flags, per-day
 * attendance, per-task state, already-decided money rows). A second queue
 * entry with a byte-identical payload (double tap, duplicated queue) is
 * deduped by payload fingerprint instead of re-applying or conflicting.
 * Deliberately excludes append-only rows (consumptions, deliveries, expenses,
 * comments, wallets, journals…) — two identical legitimate entries must both land.
 */
const REPLAY_DEDUPED_TYPES = new Set<string>([
  'attendance.record', 'attendance.checkin', 'attendance.setStatus', 'attendance.exception',
  'task.complete', 'task.verify', 'task.assign', 'task.block', 'task.unblock',
  'alert.ack', 'notification.read', 'notification.readAll',
  ...FINANCIAL_TYPES,
])

/** EAT "today" — must match lib/mjengo.ts / lib/actions/trust.ts so pre-checks read the rows appliers write. */
function todayEAT(): string {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)
}

const prettyStatus = (s: string) => s.replace('_', ' ')

/** Deterministic JSON (sorted keys, actor stripped) so identical payloads hash identically. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => k !== '__actor' && k !== '__role').sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** Fingerprint key for exact-replay dedupe, or null when the type is not deduped. */
function replayFingerprintKey(projectId: string | null | undefined, action: QueuedAction): string | null {
  if (!REPLAY_DEDUPED_TYPES.has(action.type)) return null
  const hash = createHash('sha1')
    .update(`${action.type}|${stableStringify(action.payload ?? {})}`)
    .digest('hex')
    .slice(0, 24)
  return `syncfp:${projectId ?? 'global'}:${action.type}:${hash}`
}

const kes = (n: number) => `KSh ${Math.round(n).toLocaleString('en-KE')}`

/** One worker's today-row vs the status the offline action would record. */
async function checkAttendanceForWorker(
  workerId: string,
  desired: string,
): Promise<{ reason: string } | null> {
  const att = await db.attendance.findFirst({
    where: { workerId, date: todayEAT() },
    include: { worker: { select: { name: true } } },
  })
  if (!att || att.status === desired) return null
  return {
    reason:
      `Attendance already recorded today as ${prettyStatus(att.status)} for ${att.worker.name}` +
      ` — your offline edit records ${prettyStatus(desired)}`,
  }
}

/**
 * READ-ONLY conflict pre-checks (§41). Field rows → human-decides (never a
 * silent overwrite; the server version is the suggested default). Financial
 * rows → server-wins, with identical replays reported as { silent } so the
 * route can answer a plain ok (the ledger already holds exactly this).
 */
async function detectConflict(projectId: string, action: QueuedAction): Promise<Precheck> {
  const p = action.payload ?? {}

  switch (action.type) {
    // ---------------- FIELD ROWS: human decides ----------------
    case 'attendance.record': {
      let records = p.records
      if (typeof records === 'string') {
        try { records = JSON.parse(records) } catch { records = null }
      }
      if (Array.isArray(records)) {
        for (const r of records) {
          const workerId = String(r?.workerId ?? '')
          const status =
            typeof r?.status === 'string' && ['present', 'absent', 'half_day', 'excused'].includes(r.status)
              ? r.status
              : 'present'
          if (!workerId) continue // applier throws the honest scoping error
          const hit = await checkAttendanceForWorker(workerId, status)
          if (hit) return { rule: 'human-decides', reason: hit.reason }
        }
      }
      return null
    }
    case 'attendance.setStatus': {
      if (!p.workerId || !['present', 'absent', 'half_day'].includes(p.status)) return null
      const hit = await checkAttendanceForWorker(String(p.workerId), String(p.status))
      return hit ? { rule: 'human-decides', reason: hit.reason } : null
    }
    case 'attendance.checkin': {
      // Both a check-in (records 'present') and a check-out (closes the
      // present row) conflict with a server row of a DIFFERENT status.
      if (!p.workerId) return null
      const hit = await checkAttendanceForWorker(String(p.workerId), 'present')
      return hit ? { rule: 'human-decides', reason: hit.reason } : null
    }
    case 'task.complete': {
      if (!p.id) return null
      const task = await db.task.findFirst({
        where: { id: String(p.id), phase: { projectId } },
        select: { title: true, status: true, verifiedAt: true, verifiedByName: true, blockedReason: true },
      })
      if (!task) return null // applier throws the honest scoping error
      if (task.status === 'done') {
        return {
          rule: 'human-decides',
          reason:
            `Task "${task.title}" is already marked done on the server` +
            (task.verifiedAt ? ` and verified by ${task.verifiedByName ?? 'a supervisor'}` : '') +
            ' — your offline completion conflicts',
        }
      }
      if (task.status === 'blocked') {
        return {
          rule: 'human-decides',
          reason: `Task "${task.title}" is now blocked on the server${task.blockedReason ? `: ${task.blockedReason}` : ''} — your offline completion conflicts`,
        }
      }
      return null
    }
    case 'task.update': {
      if (!p.id || (p.status === undefined && typeof p.progress !== 'number')) return null
      const task = await db.task.findFirst({
        where: { id: String(p.id), phase: { projectId } },
        select: { title: true, status: true, progress: true, verifiedAt: true, verifiedByName: true, blockedReason: true },
      })
      if (!task) return null
      const backwards = typeof p.progress === 'number' && p.progress < task.progress
      const reopens = typeof p.status === 'string' && p.status !== 'done'
      if (task.verifiedAt && (reopens || backwards)) {
        return {
          rule: 'human-decides',
          reason:
            `Task "${task.title}" was completed and verified on the server (${task.progress}% by ${task.verifiedByName ?? 'a supervisor'})` +
            ' — your offline edit would undo verified work',
        }
      }
      if (task.status === 'done' && (reopens || backwards)) {
        return {
          rule: 'human-decides',
          reason: `Task "${task.title}" is already done on the server at ${task.progress}% — your offline edit conflicts`,
        }
      }
      if (task.status === 'blocked' && reopens) {
        return {
          rule: 'human-decides',
          reason: `Task "${task.title}" is blocked on the server${task.blockedReason ? `: ${task.blockedReason}` : ''} — your offline status edit conflicts`,
        }
      }
      if (backwards) {
        return {
          rule: 'human-decides',
          reason: `Different progress on the server: "${task.title}" is at ${task.progress}% — your offline edit says ${p.progress}% (moving backward)`,
        }
      }
      return null
    }

    // ---------------- FINANCIAL / LEDGER ROWS: server always wins ----------------
    case 'milestone.decide': {
      if (!p.id) return null
      const m = await db.milestone.findFirst({
        where: { id: String(p.id), projectId },
        select: { name: true, status: true, decidedBy: true },
      })
      if (!m || (m.status !== 'released' && m.status !== 'rejected')) return null
      if (p.decision === (m.status === 'released' ? 'approve' : 'reject')) return { silent: true }
      return {
        rule: 'server-wins',
        reason: `Financial rows: the ledger already recorded this — server wins (milestone "${m.name}" was already ${m.status}${m.decidedBy ? ` by ${m.decidedBy}` : ''}; your queued decision "${p.decision}" differs)`,
      }
    }
    case 'variation.decide': {
      if (!p.id) return null
      const v = await db.variationOrder.findFirst({
        where: { id: String(p.id), projectId },
        select: { title: true, status: true, decidedBy: true },
      })
      if (!v || (v.status !== 'approved' && v.status !== 'rejected')) return null
      if (p.decision === (v.status === 'approved' ? 'approve' : 'reject')) return { silent: true }
      return {
        rule: 'server-wins',
        reason: `Financial rows: the ledger already recorded this — server wins (variation "${v.title}" was already ${v.status}${v.decidedBy ? ` by ${v.decidedBy}` : ''}; your queued decision "${p.decision}" differs)`,
      }
    }
    case 'invoice.decide': {
      if (!p.id) return null
      const inv = await db.invoice.findFirst({
        where: { id: String(p.id), projectId },
        select: { invoiceCode: true, status: true, decidedBy: true },
      })
      if (!inv || (inv.status !== 'approved' && inv.status !== 'rejected')) return null
      if (p.decision === (inv.status === 'approved' ? 'approve' : 'reject')) return { silent: true }
      return {
        rule: 'server-wins',
        reason: `Financial rows: the ledger already recorded this — server wins (${inv.invoiceCode} was already ${inv.status}${inv.decidedBy ? ` by ${inv.decidedBy}` : ''}; your queued decision "${p.decision}" differs)`,
      }
    }
    case 'payment.decide': {
      if (!p.id) return null
      const pr = await db.paymentRequest.findFirst({
        where: { id: String(p.id), projectId },
        select: { requestCode: true, status: true, decidedBy: true },
      })
      if (!pr || (pr.status !== 'approved' && pr.status !== 'rejected')) return null
      if (p.decision === (pr.status === 'approved' ? 'approve' : 'reject')) return { silent: true }
      return {
        rule: 'server-wins',
        reason: `Financial rows: the ledger already recorded this — server wins (${pr.requestCode} was already ${pr.status}${pr.decidedBy ? ` by ${pr.decidedBy}` : ''}; your queued decision "${p.decision}" differs)`,
      }
    }
    case 'invoice.pay': {
      if (!p.id) return null
      const inv = await db.invoice.findFirst({
        where: { id: String(p.id), projectId },
        select: { invoiceCode: true, status: true, paymentMethod: true },
      })
      if (!inv || inv.status !== 'paid') return null
      const method = typeof p.method === 'string' ? p.method.trim().toLowerCase() : ''
      if (method && inv.paymentMethod && method === inv.paymentMethod.toLowerCase()) return { silent: true }
      return {
        rule: 'server-wins',
        reason: `Financial rows: the ledger already recorded this — server wins (${inv.invoiceCode} was already paid${inv.paymentMethod ? ` via ${inv.paymentMethod}` : ''}; your queued payment${method ? ` via ${method}` : ''} would double-pay)`,
      }
    }
    case 'payment.pay': {
      if (!p.id) return null
      const pr = await db.paymentRequest.findFirst({
        where: { id: String(p.id), projectId },
        select: { requestCode: true, status: true, method: true },
      })
      if (!pr || pr.status !== 'paid') return null
      const method = typeof p.method === 'string' && p.method.trim() ? p.method.trim().toLowerCase() : ''
      if (!method || method === pr.method.toLowerCase()) return { silent: true }
      return {
        rule: 'server-wins',
        reason: `Financial rows: the ledger already recorded this — server wins (${pr.requestCode} was already paid via ${pr.method}; your queued payment via ${method} would double-pay)`,
      }
    }
    case 'escrow.topup': {
      const reference = typeof p.reference === 'string' ? p.reference.trim() : ''
      if (!reference) return null // auto-reference → genuinely new top-up
      const prior = await db.ledgerTransaction.findUnique({
        where: { idempotencyKey: `escrow.topup:${projectId}:${reference}` },
        select: { id: true },
      })
      if (!prior) return null
      const amount = Number(p.amount)
      const escrowLeg = await db.ledgerEntry.findFirst({
        where: { txnId: prior.id, side: 'credit' },
        orderBy: { amount: 'desc' },
        select: { amount: true },
      })
      if (escrowLeg && Number.isFinite(amount) && escrowLeg.amount === amount) return { silent: true }
      return {
        rule: 'server-wins',
        reason:
          `Financial rows: the ledger already recorded this — server wins ` +
          `(top-up ${reference} was recorded as ${escrowLeg ? kes(escrowLeg.amount) : 'a different amount'}; your queued top-up says ${Number.isFinite(amount) ? kes(amount) : 'an unknown amount'})`,
      }
    }
    case 'wages.pay': {
      const date = typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : todayEAT()
      const rows = await db.attendance.findMany({
        where: { projectId, date, status: { notIn: ['absent', 'excused'] }, wage: { gt: 0 } },
        select: { paid: true },
      })
      if (rows.length > 0 && rows.every((r) => r.paid)) {
        return {
          rule: 'server-wins',
          reason: `Financial rows: the ledger already recorded this — server wins (wages for ${date} were already paid; only newly recorded attendance can be paid)`,
        }
      }
      return null
    }
    default:
      return null
  }
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
        return NextResponse.json({ ok: true, synced: 0, failed: 0, conflicts: 0, results: [], data: null, projects: [] })
      }
      pinnedProject = await db.project.findUnique({
        where: { id: session.user.projectId },
        select: { id: true },
      })
      if (!pinnedProject) {
        return NextResponse.json({ ok: true, synced: 0, failed: 0, conflicts: 0, results: [], data: null, projects: [] })
      }
    }

    const results: SyncItemResult[] = []
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
        const itemProjectId = isClient ? pinnedProject!.id : action.projectId ?? body.projectId ?? null

        // (1) Offline-sync idempotency (spec §57): every outbox item id is recorded
        // as `sync:<projectId>:<itemId>` once applied — a re-flushed item (double
        // tap, retry after a timeout, duplicated queue) is skipped instead of
        // double-applying a money movement. This kills the offline double-payment
        // vector: applyAction's money services are additionally guarded by their
        // own natural keys, so a lost ack can never re-post money.
        const idemKey = `sync:${itemProjectId ?? 'global'}:${action.id}`
        if (await db.idempotencyRecord.findUnique({ where: { key: idemKey } })) {
          results.push({ id: action.id, ok: true })
          continue
        }

        // (2) Exact-replay fingerprint (same payload under a NEW item id) for
        // no-op-by-nature actions → one apply, both items synced (§41 rule 3).
        const fpKey = replayFingerprintKey(itemProjectId, action)
        if (fpKey && (await db.idempotencyRecord.findUnique({ where: { key: fpKey } }))) {
          results.push({ id: action.id, ok: true })
          continue
        }

        // (3) READ-ONLY conflict pre-check (§41): explain, then apply the
        // deterministic rule — or offer the human a decision. Never a silent
        // overwrite. Runs BEFORE applyAction so a conflict never half-applies.
        const pre = await detectConflict(itemProjectId ?? '', action)
        if (pre && 'silent' in pre) {
          // Identical replay of a money row — the ledger already holds exactly this.
          results.push({ id: action.id, ok: true })
          continue
        }
        if (pre && 'rule' in pre) {
          if (action.force && pre.rule === 'human-decides') {
            // The human chose 'keep-mine': the field row is theirs to decide —
            // apply the local version (the appliers keep honest history such as
            // attendance overrideLog entries). Financial rows never get here:
            // server-wins ignores force and is refused below on the next line
            // for force too (the refusal is the honest answer for money).
          } else {
            results.push({ id: action.id, ok: false, conflict: true, reason: pre.reason, rule: pre.rule })
            continue
          }
        }

        // (4) Apply — exactly once, with the item's idemKey + fingerprint recorded.
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
        if (fpKey) {
          try {
            await db.idempotencyRecord.create({
              data: { key: fpKey, scope: `syncfp:${action.type}`, projectId: itemProjectId },
            })
          } catch {
            // Same story — a concurrent identical item already recorded it.
          }
        }
        results.push({ id: action.id, ok: true })
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'failed'
        // Error-shape interpretation (thin, honest net): financial appliers that
        // refuse with an "already …" state between pre-check and apply are
        // server-wins conflicts, not silent failures.
        if (FINANCIAL_TYPES.has(action.type) && /already\s+(paid|released|rejected|approved|reversed|recorded|been)/i.test(msg)) {
          results.push({
            id: action.id,
            ok: false,
            conflict: true,
            reason: `Financial rows: the ledger already recorded this — server wins (${msg})`,
            rule: 'server-wins',
          })
        } else {
          results.push({ id: action.id, ok: false, error: msg })
        }
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
      failed: results.filter((r) => !r.ok && !('conflict' in r)).length,
      conflicts: results.filter((r) => !r.ok && 'conflict' in r).length,
      results,
      data,
      projects,
    })
  } catch (e) {
    console.error('[api/sync]', e)
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
})
