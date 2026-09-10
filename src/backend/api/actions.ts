import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { applyAction, getProjectPayload, getProjectsList, type ActionType } from '@/backend/lib/mjengo'
import { CLIENT_ACTIONS } from '@/shared/client-actions'
import { SUPPLIER_ACTIONS } from '@/shared/supplier-actions'
import { publicRoute, safeError } from '@/backend/lib/route-kit'
import { unauthorized, forbidden } from '@/backend/lib/guard'
import { kindForAction, withAuditContext } from '@/backend/lib/audit'
import { actionFlagGate } from '@/backend/lib/action-flag-gate'

// Owner action endpoint — src/app/api/actions/route.ts is the shim.
// · client-ROLE sessions may only dispatch CLIENT_ACTIONS (403 otherwise) and
//   are PINNED to their own project — a body projectId is ignored (tenant
//   isolation, mirrors /api/sync)
// · no session + valid shareToken + CLIENT_ACTIONS type is also accepted
//   (same contract as POST /api/share, actor stamped from the link)
// Session identity is stamped on the Bias-Free Ledger via __actor/__role.
//
// Audit context (spec §43, F-PLATFORM): the request's IP (first
// x-forwarded-for value, 'unknown' when absent), user-agent and a requestId
// (incoming x-request-id or a fresh UUID) are threaded into applyAction via
// withAuditContext — the AsyncLocalStorage store lib/mjengo's logAudit call
// reads, WITHOUT touching lib/mjengo.ts itself.
//
// Idempotency (spec §57): an optional `Idempotency-Key` header is persisted in
// IdempotencyRecord (key, scope = action type, responseBody) — a repeated key
// REPLAYS the stored response instead of re-applying the money movement.
// BE-6 (issue #104): the replay honors the session pins — a client session
// replays only its own project's key (403 otherwise, before any payload is
// built); supplier sessions get the result-only replay; owner roles are
// unchanged.
//
// Rate limit (W1-SEC, Doc A §52): 60 actions/min per principal (session email,
// else IP). Generous for real dispatch bursts; stops scripted abuse of the
// one endpoint every mutation flows through. Counted BEFORE the idempotency
// replay — replays are still requests. In-process limiter — single-instance
// honesty note in src/backend/lib/rate-limit.ts.
//
// FEATURE-FLAG FAMILY GATE (spec §81, task 9-a; shared since W3-1): the
// action families below are the user-facing surfaces of a flaggable feature
// — dispatched through this route by the money/finder/land tabs and by API
// clients. A flag OFF closes its family's actions for NON-ADMIN sessions
// (admins bypass so they can toggle and test; the UI hides the tab entry by
// the same rule). Since W3-1 the FLAGGED_ACTION_FAMILIES table + lookup live
// in src/backend/lib/action-flag-gate.ts so /api/sync enforces the exact
// same gate per outbox item (S1 — the offline bypass is closed). The
// families and the honest boundaries (what each flag deliberately does NOT
// gate — the escrow/milestone ladder, invoices, professionals, delivery
// expense posting) are documented in src/backend/modules/intel/flags.ts.

function auditContextFor(req: NextRequest, type: ActionType, payload: any) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const userAgent = req.headers.get('user-agent')?.slice(0, 300) || undefined
  const requestId = req.headers.get('x-request-id')?.trim() || crypto.randomUUID()
  const entityId = typeof payload?.id === 'string' && payload.id ? payload.id : undefined
  return { ip, userAgent, requestId, entity: kindForAction(type), entityId }
}

export const POST = publicRoute(
  {
    scope: 'api/actions',
    rateLimit: { bucket: 'actions', limit: 60, windowMs: 60_000 },
    // Loose body contract (legacy): parse errors surface through the route's
    // error mapper exactly as the old in-handler `await req.json()` did.
    // BE-5 (issue #76): raw-body cap BEFORE JSON.parse — closes the audit-#4
    // family on the last two uncapped routes (upload 12MB / share 64KB /
    // push 1MB / whatsapp+daraja 64KB). 1 MB is deliberately generous for a
    // SINGLE action: the biggest payloads here are delivery.create's
    // rawTranscript text and attendance.record's records JSON string (a few
    // KB); photos NEVER ride this route (they go through /api/upload's 12MB
    // cap + magic-number sniff). Exceeding it → 413 before any parse/decode.
    body: { onParseError: 'throw', maxBytes: 1_048_576 },
    onError: safeError(400, 'Action failed', { okFalse: true }),
  },
  async (req, session, body) => {
    const { type, payload, projectId, shareToken } = body as {
      type: ActionType
      payload?: any
      projectId?: string
      shareToken?: string
    }
    if (!type) return NextResponse.json({ error: 'type required' }, { status: 400 })
    // W5-3: supplier sessions never receive project/portfolio payloads — the
    // buyer's `data`/`projects` response keys are skipped for them everywhere
    // below (replays included: the replay branch would otherwise embed
    // getProjectPayload + the full projects list into a supplier response).
    const isSupplier = session?.user.role === 'supplier'

    // Feature-flag gate (spec §81, task 9-a) — BEFORE the idempotency replay
    // and before any session/share branch: a disabled feature's endpoint is
    // closed for non-admins, full stop (a replay would merely echo a stored
    // response the feature now refuses; no money moves either way). A null
    // session (share-token caller) is a non-admin and is gated too. The
    // shared gate definition (lib/action-flag-gate.ts) is the SAME one
    // /api/sync enforces per outbox item.
    const flagDenied = await actionFlagGate(type, session)
    if (flagDenied) return flagDenied

    // Canonical header is Idempotency-Key; the x-idempotency-key variant is
    // accepted too (clients/api-explorers send both spellings — dedupe either way).
    const idempotencyKey =
      req.headers.get('idempotency-key')?.trim() || req.headers.get('x-idempotency-key')?.trim() || null
    if (idempotencyKey) {
      const existing = await db.idempotencyRecord.findUnique({ where: { key: idempotencyKey } })
      if (existing) {
        // Replay the original result — never re-apply a money movement. The
        // refreshed payload keeps the response contract identical for callers.
        let replayed: any = null
        try {
          replayed = JSON.parse(existing.responseBody ?? 'null')
        } catch {
          replayed = null
        }
        if (isSupplier) {
          // Supplier replay: the stored result only — no buyer payload keys.
          return NextResponse.json({ ok: true, result: replayed, replayed: true, scope: existing.scope })
        }
        // BE-6 (issue #104): a client session replays only its OWN project's
        // key. The tenant pin the fresh-dispatch branch enforces below (body
        // projectId ignored, session.user.projectId stands) was bypassable
        // here — replaying a foreign key returned that project's full payload
        // plus the original actor's result, before the client-pin branch ever
        // ran. Same pin, same refusal copy as the notifications/v1 family; a
        // no-project client and a null-project record both fail closed too
        // (an owner's global action is not a client's key by construction).
        if (session?.user.role === 'client' && existing.projectId !== session.user.projectId) {
          return NextResponse.json({ ok: false, error: 'Not permitted for this project' }, { status: 403 })
        }
        const data = await getProjectPayload(existing.projectId ?? null)
        const projects = await getProjectsList()
        return NextResponse.json({ ok: true, result: replayed, replayed: true, scope: existing.scope, data, projects })
      }
    }

    let actorPayload = { ...(payload ?? {}) }
    // Tenant pin: a client-role session ALWAYS acts on its own project — the
    // body projectId is ignored (and never leaks another project's payload).
    let targetProjectId = projectId

    if (!session) {
      // Share-link fallback: token IS the auth, but only for the client allowlist
      if (!shareToken) return unauthorized()
      const project = await db.project.findUnique({ where: { shareToken } })
      if (!project) return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
      if (!CLIENT_ACTIONS.includes(type)) return unauthorized()
      actorPayload = { ...actorPayload, __actor: project.client, __role: 'client' }
      targetProjectId = project.id
    } else if (session.user.role === 'client') {
      if (!CLIENT_ACTIONS.includes(type)) return forbidden(session.user.role)
      if (!session.user.projectId) {
        return NextResponse.json({ ok: false, error: 'Client account has no project assigned' }, { status: 403 })
      }
      // Pinned: body projectId is deliberately ignored for client sessions.
      targetProjectId = session.user.projectId
      actorPayload = { ...actorPayload, __actor: session.user.name, __role: 'client' }
    } else if (session.user.role === 'supplier') {
      // W5-3 supplier pin (mirrors the client branch exactly): allowlist →
      // linked supplier → session-stamped identity. The body projectId STANDS
      // (a supplier's rows span projects — the row-level pin in
      // modules/supply/supplier-scope.ts is the guard, not the project), and
      // any payload __actor/__role/__supplierId copies are overwritten below.
      if (!SUPPLIER_ACTIONS.includes(type)) return forbidden(session.user.role)
      if (!session.user.supplierId) {
        return NextResponse.json(
          { ok: false, error: 'Supplier account has no supplier linked' },
          { status: 403 },
        )
      }
      targetProjectId = projectId
      actorPayload = {
        ...actorPayload,
        __actor: session.user.name,
        __role: 'supplier',
        __supplierId: session.user.supplierId,
      }
    } else {
      // Site team: stamp the signed-in identity (never overridable by the payload)
      actorPayload = { ...actorPayload, __actor: session.user.name, __role: session.user.role }
    }

    // Wrap in the request audit context (spec §43) — applyAction's own
    // logAudit call (lib/mjengo.ts, untouched) picks ip/userAgent/requestId/
    // entity up via the AsyncLocalStorage store in lib/audit.ts. Exactly ONE
    // audit row per action; the entity hint comes from the payload id when
    // the action targets a known row.
    const auditCtx = auditContextFor(req, type, payload)
    const result = await withAuditContext(auditCtx, () => applyAction(type, actorPayload, targetProjectId))

    // Persist the idempotency record AFTER a successful apply (spec §57).
    if (idempotencyKey) {
      try {
        await db.idempotencyRecord.create({
          data: {
            key: idempotencyKey,
            scope: String(type),
            projectId: typeof targetProjectId === 'string' ? targetProjectId : null,
            responseBody: JSON.stringify(result ?? null),
          },
        })
      } catch {
        // Unique collision = a concurrent duplicate already recorded — the
        // original result stands, this response matches it.
      }
    }

    // Refresh payload for the project the action targeted (explicit > payload.projectId > first)
    if (isSupplier) {
      // Supplier response: the result only — the buyer payload keys never
      // ride a supplier response (the portal re-reads /api/supplier).
      return NextResponse.json({ ok: true, result })
    }
    const refreshProjectId = session?.user.role === 'client' ? session.user.projectId : targetProjectId || payload?.projectId || null
    const data = await getProjectPayload(refreshProjectId)
    const projects = await getProjectsList()
    return NextResponse.json({ ok: true, result, data, projects })
  },
)
