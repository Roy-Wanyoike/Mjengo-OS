// Land & Property module — role permissions (stub, agent 2-a implements).
//
// Working rules from the Finder/roadmap specs (who MAY do what; the action
// dispatcher enforces, this module documents + checks):
//
//   contractor  · create/edit parcels · attach documents · request title searches
//                · receive registry results · mark reviews
//   supervisor  · attach documents · view everything (no registry receive)
//   client      · view parcels, documents, searches, Property Passport (read-only)
//   admin       · everything the contractor can do
//   share client· read-only (finder tab is client-relevant; land is read-only)
//
// Honest-language rule for every status this module emits:
//   "recorded", "anomaly", "review required" — NEVER "verified by government",
//   "thief", "fraud". AI recommends, humans decide.
//
// Implementation hint: export `can(role, action)` and call it at the top of
// each service function; throw with a clear message on denial.

export type LandRole = 'contractor' | 'supervisor' | 'client' | 'finance' | 'admin' | 'share_client'
export type LandAction =
  | 'parcel.view'
  | 'parcel.create'
  | 'parcel.update'
  | 'parcelDoc.attach'
  | 'search.request'
  | 'search.receive'
  | 'search.review'

/** Role permission matrix — stub, agent 2-a implements the real checks. */
export function landCan(_role: LandRole, _action: LandAction): boolean {
  return false // deny-by-default until phase 2 implements the matrix
}
