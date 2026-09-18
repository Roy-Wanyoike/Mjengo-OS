import { NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { logAudit } from '@/backend/lib/audit'
import { currentRequestId, log } from '@/backend/lib/log'
import { route, genericError } from '@/backend/lib/route-kit'
import { FLAG_KEYS, FLAG_DEFAULTS, getFlags, setFlag, type FlagKey } from '@/backend/modules/intel/flags'

// Feature-flag toggles (spec §81) — src/app/api/flags/route.ts is the shim.
//
// GET returns the current flag map; POST { key, enabled } persists one
// toggle. POST is admin only (the header popover is the single writer); GET
// is admin + contractor — the owner-app roles whose UI surfaces the flags
// popover. (W-BACKEND 4c: GET was previously open to every signed-in role
// while the popover is an owner surface — qs/finance/procurement/client
// sessions now get 403, matching the UI instead of oversharing.)
//
// API-11 (issue #162): a successful POST writes an AuditEvent — flags gate
// real server-side behavior for everyone (wallet, marketplace, land
// verification, the AI provider seam), so an admin silently flipping one is
// a system-behavior change that belongs on the trail (same logAudit writer
// as /api/actions and the v1 money family).
//
// Body validation is deliberately loose ('throw' mode): the historical
// contract answers with the flag-specific 400 messages below, not zod copy.

export const GET = route(
  {
    scope: 'api/flags GET',
    roles: ['admin', 'contractor'],
    onError: genericError(500, 'Could not read flags'),
  },
  async () => {
    return NextResponse.json({ ok: true, flags: await getFlags(), keys: FLAG_KEYS })
  },
)

export const POST = route(
  {
    scope: 'api/flags POST',
    roles: ['admin'],
    // Rate limit (S-SEC): 10 toggles/min — admin-only mutation, but flags gate
    // product behavior for everyone.
    rateLimit: { bucket: 'flags.post', limit: 10, windowMs: 60_000 },
    body: { onParseError: 'throw' },
    onError: genericError(500, 'Could not save flag'),
  },
  async (req, session, body) => {
    const { key, enabled } = body as { key?: string; enabled?: boolean }
    if (typeof key !== 'string' || !(FLAG_KEYS as readonly string[]).includes(key)) {
      return NextResponse.json(
        { error: `Unknown flag key — expected one of ${FLAG_KEYS.join(', ')}` },
        { status: 400 },
      )
    }
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }

    // API-11 (#162): read the PRIOR value BEFORE the toggle — the raw
    // FeatureFlag row is what setFlag changes (the 30s-cached map may also
    // carry the NEXT_FLAGS_OFF env override, which is not what moved). A
    // row missing until now (lazily created by setFlag's ensureRows)
    // honestly defaults to FLAG_DEFAULTS — exactly the value ensureRows
    // persists before the update.
    const priorRow = await db.featureFlag.findUnique({ where: { key } })
    const before = priorRow?.enabled ?? FLAG_DEFAULTS[key as FlagKey]

    const flags = await setFlag(key as FlagKey, enabled)

    // AuditEvent.projectId is a REQUIRED Project FK — every trail row is
    // scoped to a project by schema design. A platform-wide flag toggle has
    // no natural project, so it scopes to the admin's pinned project, else
    // the portfolio's founding project; with ZERO projects in the database
    // there is no honest scope for the row — one warning, no fabricated id
    // (the same after-commit residual honesty as #120's money family).
    const auditProjectId =
      session.user.projectId ??
      (await db.project.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } }))?.id
    if (auditProjectId) {
      await logAudit(
        auditProjectId,
        'flag',
        { name: session.user.name, role: session.user.role },
        `Feature flag "${key}" toggled ${before ? 'ON' : 'OFF'} → ${enabled ? 'ON' : 'OFF'}`,
        { type: 'flag.toggle', key, before, after: enabled },
        {
          ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
          userAgent: req.headers.get('user-agent')?.slice(0, 300) || undefined,
          requestId: currentRequestId() ?? crypto.randomUUID(),
          entity: 'FeatureFlag',
          entityId: key,
          before: { enabled: before },
          after: { enabled },
        },
      )
    } else {
      log.warn(
        'api/flags POST',
        `flag "${key}" → ${enabled} NOT audited: no Project exists to scope the ` +
          `AuditEvent to (projectId is a required Project FK) — create a project first.`,
        { key, enabled },
      )
    }
    return NextResponse.json({ ok: true, key, enabled, flags })
  },
)
