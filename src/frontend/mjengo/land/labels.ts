import type { TranslateFn } from '@/frontend/i18n/types'

/**
 * Land + professionals enum → dict-key label helpers (issue #107).
 *
 * The backend modules own the EN label maps (land/types.ts,
 * professionals/types.ts — server copy, unchanged); the UI renders the SAME
 * enums through the i18n dicts so a Kiswahili locale sees Kiswahili. Enum
 * VALUES (parcel statuses, doc kinds, check methods…) are server data and
 * never change — only their rendered labels localize. Unknown values fall
 * back to the raw value, mirroring the `?? 'Document'` tolerance the
 * components already had.
 */

// ---------------- parcels ----------------

export const parcelStatusLabel = (t: TranslateFn, status: string): string =>
  t(`land.parcelStatus.${status}`)

export const matchLabel = (t: TranslateFn, match: string): string =>
  t(`land.match.${match}`)

export const searchStatusLabel = (t: TranslateFn, status: string): string =>
  t(`land.searchStatus.${status}`)

export const docKindLabel = (t: TranslateFn, kind: string): string =>
  t(`land.docKind.${kind}`)

export const assignRoleLabel = (t: TranslateFn, role: string): string =>
  t(`land.assignRole.${role}`)

export const assignStatusLabel = (t: TranslateFn, status: string): string =>
  t(`land.assignStatus.${status}`)

// ---------------- professionals ----------------

export const proCategoryLabel = (t: TranslateFn, category: string): string =>
  t(`land.proCategory.${category}`)

export const licenceBodyLabel = (t: TranslateFn, body: string): string =>
  t(`land.licenceBody.${body}`)

export const checkMethodLabel = (t: TranslateFn, method: string): string =>
  t(`land.checkMethod.${method}`)

export const ladderLabel = (t: TranslateFn, level: number): string =>
  t(`land.ladder.${level}.label`)

export const ladderHint = (t: TranslateFn, level: number): string =>
  t(`land.ladder.${level}.hint`)
