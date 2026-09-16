import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'
import { logAudit, summarizeAction } from '@/backend/lib/audit'
import { getProjectPayload, getProjectsList } from '@/backend/lib/mjengo'
import { route, safeError, genericError } from '@/backend/lib/route-kit'
import { shareTokenExpiryFromNow } from '@/backend/lib/share-token'

// Projects list + create — src/app/api/projects/route.ts is the shim.

/** Phase templates: [name, pct of total budget]. */
const TEMPLATES: Record<string, Array<[string, number]>> = {
  bungalow: [
    ['Site Prep & Foundation', 25],
    ['Walling', 20],
    ['Roofing', 15],
    ['Plumbing & Electrical', 15],
    ['Finishing', 25],
  ],
  maisonette: [
    ['Site Prep & Foundation', 20],
    ['Structural Frame', 20],
    ['Walling', 15],
    ['Roofing', 10],
    ['Plumbing & Electrical', 15],
    ['Finishing', 20],
  ],
  duplex: [
    ['Site Prep & Foundation', 22],
    ['Walling', 22],
    ['Roofing', 14],
    ['Plumbing & Electrical', 16],
    ['Finishing', 26],
  ],
  blank: [['Phase 1', 100]],
}

export const GET = route(
  {
    scope: 'api/projects GET',
    // BE-8 (issue #105): 60/min per principal — the list route builds the full
    // portfolio payload (per-table take caps now live in getProjectsList too);
    // the same standard GET bucket posture as /api/project (project.get).
    rateLimit: { bucket: 'projects.list', limit: 60, windowMs: 60_000 },
    onError: genericError(500, 'Failed to list projects'),
  },
  async (_req, session) => {
    const projects = await getProjectsList()
    // Client-role sessions see exactly their own project — never the portfolio.
    // W5-3 supplier sessions see an EMPTY list — never the portfolio (the same
    // honest empty answer a client without a pinned project gets; the supplier
    // surface is /api/supplier, which scopes to their own rows).
    const scoped =
      session.user.role === 'client' && session.user.projectId
        ? projects.filter((p) => p.id === session.user.projectId)
        : session.user.role === 'supplier'
          ? []
          : projects
    return NextResponse.json({ ok: true, projects: scoped })
  },
)

interface CreateProjectBody {
  name?: string
  client?: string
  clientType?: string
  location?: string
  budget?: number
  startDate?: string
  targetDate?: string
  template?: string
}

export const POST = route(
  {
    scope: 'api/projects POST',
    roles: ['contractor', 'admin'],
    // Rate limit (S-SEC): 10 creates/min — each create writes a project + its
    // phase rows + a full payload build.
    rateLimit: { bucket: 'projects.create', limit: 10, windowMs: 60_000 },
    body: { onParseError: 'throw' },
    onError: safeError(500, 'Failed to create project'),
  },
  async (req, session, body) => {
    const parsed = body as CreateProjectBody
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    if (name.length > 200) return NextResponse.json({ error: 'name must be at most 200 characters' }, { status: 400 })
    for (const [field, value, max] of [
      ['client', parsed.client, 120],
      ['location', parsed.location, 120],
    ] as const) {
      if (value !== undefined && (typeof value !== 'string' || value.length > max)) {
        return NextResponse.json({ error: `${field} must be a string of at most ${max} characters` }, { status: 400 })
      }
    }
    const budget = Number(parsed.budget)
    if (!isFinite(budget) || budget <= 0) return NextResponse.json({ error: 'budget must be a positive number' }, { status: 400 })
    const clientType = ['diaspora', 'local', 'company'].includes(parsed.clientType ?? '')
      ? (parsed.clientType as string)
      : 'diaspora'
    const template = parsed.template && parsed.template in TEMPLATES ? parsed.template : 'blank'

    // Unparseable dates reach Prisma as Invalid Date (S-SEC: its validation
    // error leaks internals) — reject them with an honest 400 instead.
    const invalidDate = (v: string | undefined) => v !== undefined && Number.isNaN(new Date(v).getTime())
    if (invalidDate(parsed.startDate) || invalidDate(parsed.targetDate)) {
      return NextResponse.json(
        { error: `startDate/targetDate must be valid dates (got ${JSON.stringify(parsed.startDate ?? parsed.targetDate)})` },
        { status: 400 },
      )
    }
    const startDate = parsed.startDate ? new Date(parsed.startDate) : new Date()
    const defaultTarget = new Date()
    defaultTarget.setDate(defaultTarget.getDate() + 120)
    const targetDate = parsed.targetDate ? new Date(parsed.targetDate) : defaultTarget

    // SEC-3: the share token is a money-adjacent bearer capability — a share
    // link can approve milestone/variation decisions — so the INITIAL token
    // is minted with the CSPRNG (24 random bytes ≈ 192-bit, base64url, no
    // padding) instead of leaning on Prisma's collision-resistant but not
    // unguessability-hardened cuid() default (kept in the schema only as a
    // defensive fallback for raw db writes — seeds still use it).
    //
    // Issue #172 (SEC-3r): every mint also stamps an EXPIRY — the link dies
    // after SHARE_TOKEN_TTL_DAYS (default 90). A leaked link is no longer a
    // permanent capability; share.regenerate re-mints with a fresh window.
    const shareToken = randomBytes(24).toString('base64url')
    const project = await db.project.create({
      data: {
        name,
        client: parsed.client?.trim() || 'New Client',
        clientType,
        location: parsed.location?.trim() || 'Kenya',
        budget,
        startDate,
        targetDate,
        status: 'active',
        shareToken,
        shareTokenExpiresAt: shareTokenExpiryFromNow(),
      },
    })

    const phaseDefs = TEMPLATES[template]
    for (let i = 0; i < phaseDefs.length; i++) {
      const [phaseName, pct] = phaseDefs[i]
      await db.phase.create({
        data: {
          projectId: project.id,
          name: phaseName,
          order: i + 1,
          budget: Math.round((pct / 100) * budget),
          status: 'pending',
        },
      })
    }

    // API-11 (issue #162): project creation is the founding mutation of the
    // data model — it now writes the same Bias-Free Ledger trail row the
    // actions registry writes per action. Same writer/summarizer as
    // applyAction (lib/audit.ts) and the v1 money family (#120), so the
    // trail is uniform across /api/actions, /api/v1 and the direct routes.
    // Honest order: AFTER the project + phases persist (every 400 above wrote
    // nothing) and after-commit like #120 — a crash between the create and
    // this line leaves an unaudited project (logAudit itself never throws).
    // The share token is deliberately NOT in the row (a money-adjacent
    // bearer capability — SEC-3; meta records only that one was issued).
    await logAudit(
      project.id,
      'project',
      { name: session.user.name, role: session.user.role },
      summarizeAction('project.create', { name, budget }, null),
      { type: 'project.create', name, budget, template, phases: phaseDefs.length, shareTokenIssued: true },
      {
        ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
        userAgent: req.headers.get('user-agent')?.slice(0, 300) || undefined,
        requestId: req.headers.get('x-request-id')?.trim() || crypto.randomUUID(),
        entity: 'Project',
        entityId: project.id,
        after: {
          name,
          client: parsed.client?.trim() || 'New Client',
          clientType,
          location: parsed.location?.trim() || 'Kenya',
          budget,
          status: 'active',
          template,
          startDate: startDate.toISOString(),
          targetDate: targetDate.toISOString(),
        },
      },
    )

    const [data, projects] = await Promise.all([getProjectPayload(project.id), getProjectsList()])
    return NextResponse.json({ ok: true, result: { id: project.id, shareToken: project.shareToken }, data, projects })
  },
)
