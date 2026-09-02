// Land & Property module — role permissions.
//
// Working rules from the Finder/roadmap specs (who MAY do what; the action
// dispatcher enforces, this module documents + checks):
//
//   contractor  · create/edit parcels · attach documents · request title searches
//                · receive registry results · mark reviews
//   supervisor  · attach documents · view everything (no registry receive)
//   client      · view parcels, documents, searches, Property Passport (read-only)
//   finance     · view-only (land records are not a money surface)
//   admin       · everything the contractor can do
//   share client· read-only (finder tab is client-relevant; land is read-only)
//
// Honest-language rule for every status this module emits:
//   "recorded", "anomaly", "review required" — NEVER "verified by government",
//   "thief", "fraud". AI recommends, humans decide.
//
// ENFORCEMENT POINTS (this module's matrix is the single source of truth):
//   1. src/app/api/actions/route.ts — client-ROLE sessions are restricted to
//      CLIENT_ACTIONS (land actions are NOT in that list → 403 before the
//      dispatcher runs; share-token clients likewise).
//   2. src/frontend/hooks/use-mjengo.ts dispatch() — the client VIEW is read-only for
//      every non-allowlisted action (toast, no request).
//   3. The Land tab UI hides mutation controls when viewMode === 'client'.
//   4. landCan() is exported for any future API surface (e.g. /api/v1) and for
//      UI hints — server handlers trust the route-level guards above.

export type LandRole = 'contractor' | 'supervisor' | 'client' | 'finance' | 'admin' | 'share_client'
export type LandAction =
  | 'parcel.view'
  | 'parcel.create'
  | 'parcel.update'
  | 'parcelDoc.attach'
  | 'search.request'
  | 'search.receive'
  | 'search.review'

/** Human-readable role notes — surfaced in docs and the Land tab. */
export const LAND_ROLE_NOTES: Record<LandRole, string> = {
  contractor: 'Records and edits parcels, attaches documents, requests registry searches, receives results and marks reviews.',
  supervisor: 'Views all land records and may attach site documents; registry results and reviews stay with the contractor.',
  client: 'Read-only — parcels, documents, searches and the Property Passport.',
  finance: 'Read-only — land records are not a money surface.',
  admin: 'Everything the contractor can do.',
  share_client: 'Read-only via a share link — land data is never mutated from a client share.',
}

/** Role permission matrix — who may perform each land action. */
const MATRIX: Record<LandAction, readonly LandRole[]> = {
  'parcel.view': ['contractor', 'supervisor', 'client', 'finance', 'admin', 'share_client'],
  'parcel.create': ['contractor', 'admin'],
  'parcel.update': ['contractor', 'admin'],
  'parcelDoc.attach': ['contractor', 'supervisor', 'admin'],
  'search.request': ['contractor', 'admin'],
  'search.receive': ['contractor', 'admin'],
  'search.review': ['contractor', 'admin'],
}

export function landCan(role: LandRole, action: LandAction): boolean {
  return (MATRIX[action] ?? []).includes(role)
}
