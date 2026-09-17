/**
 * Backend audit entry point. The append-only Bias-Free Ledger is the trust
 * spine of MjengoOS ("record the evidence around what happened") — every
 * domain service stamps user-visible mutations here.
 *
 * Implementation lives in `src/lib/audit.ts` (shared with the legacy action
 * engine); this re-export makes `@/backend/core/audit` the canonical import
 * for backend code.
 */
export { logAudit, summarizeAction, kindForAction, type AuditActor } from '@/lib/audit'
