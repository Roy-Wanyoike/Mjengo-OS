// Land & Property actions — parcel lifecycle + title-search evidence flow.
// Dispatched from lib/mjengo.ts applyAction(), which auto-writes the
// AuditEvent for every success — never log manually here.
//
// House rules:
//  - Parcel status is an honest RECORD state (searching / verified / flagged);
//    "verified" means documents + registry result AGREE — never "government
//    verified".
//  - transcriptionMatch mismatch is an anomaly flag for human review, never an
//    accusation.
//  - Clients are read-only on land data.
//
// STUB (F-1): every action throws until agent 2-a lands the module.

export const LAND_ACTIONS = [
  'parcel.create', // { plotNumber, county, town?, lat?, lng?, approxArea?, tenureType? }
  'parcel.update', // { id, town?, approxArea?, tenureType?, notes?... }
  'parcel.setStatus', // { id, status: 'searching'|'verified'|'flagged', note? }
  'parcelDoc.attach', // { parcelId, kind: 'title_deed'|'search_cert'|'survey_map'|'other', fileName, storageKey, extractedText?, issuedOn? }
  'search.request', // { parcelId, searchRef? } — registry title search requested
  'search.receive', // { id, resultSummary } — registry result recorded; auto consistency check vs deed transcription
  'search.review', // { id, note? } — human reviewed the received result / mismatch
] as const

// ---------------- dispatcher (stub) ----------------

export async function applyLandAction(type: string, _payload: any, _projectId: string): Promise<any> {
  // Phase-2 (agent 2-a) implements the switch over LAND_ACTIONS here.
  throw new Error(`Not implemented yet — landing with phase 2 (land action: ${type})`)
}
