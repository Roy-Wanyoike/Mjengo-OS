// Land & Property module — types for the `land` slice of the project payload.
//
// The slice carries every parcel tied to the project with its documents,
// registry searches and professional assignments so the Land tab can render
// parcel lists, detail timelines and the Property Passport without extra calls.
// Honest-language rule: statuses describe RECORD state (searching / verified /
// flagged), never government certification.

import type { LandParcel, ParcelDocument, TitleSearch, ParcelAssignment } from '@prisma/client'

// ---- domain enums (string-valued, matching prisma/schema.prisma comments) ----

export const PARCEL_STATUSES = ['searching', 'verified', 'flagged'] as const
export const PARCEL_DOCUMENT_KINDS = ['title_deed', 'search_cert', 'survey_map', 'other'] as const
export const TITLE_SEARCH_STATUSES = ['requested', 'received', 'reviewed'] as const
export const TRANSCRIPTION_MATCHES = ['pending', 'consistent', 'mismatch'] as const

export type ParcelStatus = (typeof PARCEL_STATUSES)[number]
export type ParcelDocumentKind = (typeof PARCEL_DOCUMENT_KINDS)[number]
export type TitleSearchStatus = (typeof TITLE_SEARCH_STATUSES)[number]
export type TranscriptionMatch = (typeof TRANSCRIPTION_MATCHES)[number]
export type AssignmentRole = 'surveyor' | 'advocate' | 'engineer' | 'qty_surveyor'
export type AssignmentStatus = 'active' | 'completed' | 'withdrawn'

// ---- display labels (shared by the service validation errors and the UI) ----

export const PARCEL_STATUS_LABELS: Record<ParcelStatus, string> = {
  searching: 'Searching',
  verified: 'Verified',
  flagged: 'Flagged',
}

export const DOC_KIND_LABELS: Record<ParcelDocumentKind, string> = {
  title_deed: 'Title deed',
  search_cert: 'Official search certificate',
  survey_map: 'Survey map',
  other: 'Document',
}

export const SEARCH_STATUS_LABELS: Record<TitleSearchStatus, string> = {
  requested: 'Requested',
  received: 'Received',
  reviewed: 'Reviewed',
}

export const MATCH_LABELS: Record<TranscriptionMatch, string> = {
  pending: 'Check pending',
  consistent: 'Consistent',
  mismatch: 'Mismatch — review required',
}

export const ASSIGNMENT_ROLE_LABELS: Record<string, string> = {
  surveyor: 'Licensed surveyor',
  advocate: 'Advocate',
  engineer: 'Engineer',
  qty_surveyor: 'Quantity surveyor',
}

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
