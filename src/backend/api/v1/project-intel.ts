import { db } from '@/backend/lib/db'
import { route } from '@/backend/lib/route-kit'
import { getProjectPayload } from '@/backend/lib/mjengo'
import { projectIdRef, projectIntelQuery, validateQuery } from './schemas'
import { mapServiceError, v1Err, v1Ok, V1_READ_LIMIT } from './respond'
import { clientProjectDenied, supplierProjectDenied } from './scope'
import {
  parseDigestItems, parseRiskFindings, parseScoreComponents,
} from '@/backend/modules/intel/types'

// /api/v1/projects/:id/intel (Phase D, read-only — the intel digest) —
// src/app/api/v1/projects/[id]/intel/route.ts is the shim.

/** Dynamic-route context (Next 16: params is a Promise). */
type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/v1/projects/:id/intel — the project's INTEL DIGEST: the flags
 * state, the latest MjengoScore trust score, the latest risk assessment, the
 * §48 health snapshot, the latest weekly digest row, and the anomalies
 * summary (the project's alert ledger — every anomaly/budget/attendance/
 * safety alert with its severity mix and acknowledgement state).
 *
 * HONESTY RULES carried verbatim from the intel module:
 *   · the score GATES nothing and APPROVES nothing — it describes, humans
 *     decide; score is NULL (never a fake 0 or 100) when the project has too
 *     little history, with the explanation in `notes`;
 *   · every number is deterministic and traceable to real rows — no
 *     anonymous ratings, no opaque "AI scores";
 *   · risk findings and anomalies are "review required" language, never
 *     accusations.
 *
 * NO FEATURE FLAG gates this READ, deliberately: ai_progress/ai_voice gate
 * the AI *routes* (Copilot photo analysis / voice logging), not the intel
 * module's deterministic reads — the webapp Intel tab renders while flags are
 * off, and v1 mirrors that (the projects-resource precedent, documented in
 * flags.ts).
 *
 * ROLE SCOPING: same as /api/v1/projects/:id (client pinned to their own
 * project, foreign → 403; unknown project → 404). W5-3: supplier sessions
 * are not project readers — uniform 403.
 *
 * DATA (honest seam notes): risk/score/digests/health/flags come from
 * getProjectPayload()'s intel slice — loadIntelSlice(projectId), the intel
 * module's public read (latest-wins rows + the module's own safe JSON
 * parsers, re-used here; never re-implemented). The anomalies summary is a
 * route-layer read of the Alert ledger (the rows the anomaly scan writes) —
 * the wallet-transactions precedent. Pagination does not apply (one digest
 * object). Rate limit: 120/min per principal.
 */
export const GET = route(
  {
    scope: 'projects/:id/intel GET',
    rateLimit: { bucket: 'v1.projects.intel', limit: V1_READ_LIMIT, windowMs: 60_000 },
    onError: (e) => mapServiceError('projects/:id/intel GET', e, 'Project intel digest failed'),
  },
  async (req, session, _body, ctx: Ctx) => {
    const { id } = await ctx.params
    const idRef = projectIdRef.safeParse(id)
    if (!idRef.success) return v1Err(400, idRef.error.issues[0].message, 'id')
    const q = validateQuery(req, projectIntelQuery)
    if (!q.ok) return q.response

    const payload = await getProjectPayload(id)
    if (!payload) return v1Err(404, 'Project not found')
    const denied = clientProjectDenied(session, payload.project.id)
    if (denied) return denied
    // W5-3: supplier sessions are not project readers. Uniform 403 — no
    // project data is returned.
    const supplierDenied = supplierProjectDenied(session)
    if (supplierDenied) return supplierDenied

    const intel = payload.intel
    // The alert ledger — the anomaly scan's output rows (counts + latest 5).
    const alerts = await db.alert.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
    })

    return v1Ok({
      projectId: id,
      flags: {
        ai_progress: intel.flags.ai_progress,
        ai_voice: intel.flags.ai_voice,
        wallet: intel.flags.wallet,
        marketplace: intel.flags.marketplace,
        land_verification: intel.flags.land_verification,
      },
      score: intel.score
        ? {
            score: intel.score.score, // nullable — honest low-confidence state
            confidence: intel.score.confidence,
            ruleVersion: intel.score.ruleVersion,
            computedAt: intel.score.computedAt.toISOString(),
            componentsCount: parseScoreComponents(intel.score.components).length,
            components: parseScoreComponents(intel.score.components),
            notes: intel.score.notes,
          }
        : null,
      risk: intel.risk
        ? {
            overallScore: intel.risk.overallScore,
            ruleVersion: intel.risk.ruleVersion,
            computedAt: intel.risk.computedAt.toISOString(),
            findings: parseRiskFindings(intel.risk.findings),
          }
        : null,
      health: intel.health
        ? {
            overall: intel.health.overall,
            computedAt: intel.health.computedAt,
            dimensions: intel.health.dimensions,
          }
        : null,
      digest: intel.digests[0]
        ? {
            id: intel.digests[0].id,
            weekStart: intel.digests[0].weekStart,
            summary: intel.digests[0].summary,
            items: parseDigestItems(intel.digests[0].items),
            createdAt: intel.digests[0].createdAt.toISOString(),
          }
        : null,
      anomalies: {
        total: alerts.length,
        unacknowledged: alerts.filter((a) => !a.acknowledged).length,
        critical: alerts.filter((a) => a.severity === 'critical').length,
        warning: alerts.filter((a) => a.severity === 'warning').length,
        info: alerts.filter((a) => a.severity === 'info').length,
        byType: Object.fromEntries(
          ['anomaly', 'budget', 'attendance', 'safety', 'progress', 'info'].map((t) => [
            t,
            alerts.filter((a) => a.type === t).length,
          ]),
        ),
        latest: alerts.slice(0, 5).map((a) => ({
          id: a.id,
          type: a.type,
          severity: a.severity,
          title: a.title,
          message: a.message,
          acknowledged: a.acknowledged,
          createdAt: a.createdAt.toISOString(),
        })),
      },
    })
  },
)
