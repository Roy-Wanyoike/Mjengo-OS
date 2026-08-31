// Land & Property module — types for the `land` slice of the project payload.
//
// The slice carries every parcel tied to the project with its documents,
// registry searches and professional assignments so the Land tab can render
// parcel lists, detail timelines and the Property Passport without extra calls.
// Honest-language rule: statuses describe RECORD state (searching / verified /
// flagged), never government certification.

import type { LandParcel, ParcelDocument, TitleSearch, ParcelAssignment } from '@prisma/client'

// ---- domain enums (string-valued, matching prisma/schema.prisma comments) ----

export type ParcelStatus = 'searching' | 'verified' | 'flagged'
export type ParcelDocumentKind = 'title_deed' | 'search_cert' | 'survey_map' | 'other'
export type TitleSearchStatus = 'requested' | 'received' | 'reviewed'
export type TranscriptionMatch = 'pending' | 'consistent' | 'mismatch'
export type AssignmentRole = 'surveyor' | 'advocate' | 'engineer' | 'qty_surveyor'
export type AssignmentStatus = 'active' | 'completed' | 'withdrawn'

// ---- slice shapes ----

/** A parcel assignment flattened for display (professional name/category inline). */
export interface AssignmentSummary extends ParcelAssignment {
  professionalName: string
  professionalCategory: string
}

/** Parcel with everything the parcel detail view needs. */
export interface ParcelDetail extends LandParcel {
  documents: ParcelDocument[]
  searches: TitleSearch[]
  assignments: AssignmentSummary[]
}

/** The `land` slice of ProjectPayload — populated by repository.loadLandSlice. */
export interface LandSlice {
  parcels: ParcelDetail[]
}

export const EMPTY_LAND_SLICE: LandSlice = { parcels: [] }
