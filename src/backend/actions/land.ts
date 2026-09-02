// MjengoOS Land & Property actions — parcel lifecycle + title-search evidence flow.
// Dispatched from lib/mjengo.ts applyAction(), which auto-writes the
// AuditEvent for every success — never log manually here.
//
// House rules:
//  - Parcel status is an honest RECORD state (searching / verified / flagged);
//    "verified" means documents + registry result AGREE — never "government
//    verified".
//  - transcriptionMatch mismatch is an anomaly flag for human review, never an
//    accusation.
//  - Clients are read-only on land data (enforced in /api/actions + the store;
//    see src/backend/modules/land/policy.ts for the matrix).
//
// Thin controller, fat service: this dispatcher only routes + validates the
// action shape; every rule lives in src/backend/modules/land/service.ts.

import {
  createParcel,
  updateParcel,
  setParcelStatus,
  attachParcelDocument,
  requestTitleSearch,
  receiveTitleSearch,
  reviewTitleSearch,
} from '@/backend/modules/land/service'

export const LAND_ACTIONS = [
  'parcel.create', // { plotNumber, county, town?, lat?, lng?, approxArea?, tenureType? }
  'parcel.update', // { id, town?, approxArea?, tenureType?, notes?... }
  'parcel.setStatus', // { id, status: 'searching'|'verified'|'flagged', note? }
  'parcelDoc.attach', // { parcelId, kind: 'title_deed'|'search_cert'|'survey_map'|'other', fileName, storageKey, extractedText?, issuedOn? }
  'search.request', // { parcelId, searchRef? } — registry title search requested
  'search.receive', // { id, resultSummary } — registry result recorded; auto consistency check vs deed transcription
  'search.review', // { id, decision: 'accept'|'flag', note? } — human reviewed the received result / mismatch
] as const

// ---------------- dispatcher ----------------

export async function applyLandAction(type: string, payload: any, projectId: string): Promise<any> {
  switch (type) {
    case 'parcel.create':
      return createParcel(projectId, payload ?? {})
    case 'parcel.update':
      return updateParcel(projectId, payload ?? {})
    case 'parcel.setStatus':
      return setParcelStatus(projectId, payload ?? {})
    case 'parcelDoc.attach':
      return attachParcelDocument(projectId, payload ?? {})
    case 'search.request':
      return requestTitleSearch(projectId, payload ?? {})
    case 'search.receive':
      return receiveTitleSearch(projectId, payload ?? {})
    case 'search.review':
      return reviewTitleSearch(projectId, payload ?? {})
    default:
      throw new Error(`Unknown land action: ${type}`)
  }
}
