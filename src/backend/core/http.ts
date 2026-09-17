import { NextRequest, NextResponse } from 'next/server'

/**
 * Backend HTTP toolkit — the vocabulary every route speaks.
 *
 * Conventions:
 *  · Services throw `ApiError(status, message)` for every expected failure;
 *    the guard / route boundary converts it into `{ error: message }` JSON.
 *  · Unexpected exceptions NEVER leak internals: they are logged server-side
 *    and returned as a generic 500.
 *  · Success bodies stay backward-compatible with the existing UI
 *    (`{ ok: true, ... }` for mutations, plain payloads for reads).
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 400 — the caller sent something invalid. */
export function badRequest(message: string): never {
  throw new ApiError(400, message)
}

/** 404 — the thing being asked for does not exist. */
export function notFound(message: string): never {
  throw new ApiError(404, message)
}

/** 403 — authenticated but not permitted. */
export function accessDenied(message: string): never {
  throw new ApiError(403, message)
}

/** Convert any thrown value into a safe HTTP response. */
export function apiErrorResponse(e: unknown, tag = 'api'): NextResponse {
  if (e instanceof ApiError) {
    return NextResponse.json({ error: e.message }, { status: e.status })
  }
  console.error(`[${tag}]`, e)
  return NextResponse.json(
    { error: 'Something went wrong on our side — please try again.' },
    { status: 500 },
  )
}

/** Parse a JSON body defensively — malformed JSON becomes `{}`. */
export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Standard response for an unrecognized `action` discriminator. */
export function unknownAction(): NextResponse {
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

/* ------------------------------------------------------------------ *
 * Field validators — deterministic, with UX-critical messages that   *
 * match the existing UI copy exactly. Throwing ApiError keeps the    *
 * error surface identical to the old inline validation.             *
 * ------------------------------------------------------------------ */

/** Required non-empty trimmed string. */
export function fieldStr(value: unknown, message: string): string {
  const s = String(value ?? '').trim()
  if (!s) badRequest(message)
  return s
}

/** Required positive finite number (coerces numeric strings). */
export function fieldPos(value: unknown, message: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) badRequest(message)
  return n
}

/** Required number ≥ 0 (e.g. delivered quantity can legitimately be 0). */
export function fieldNonNeg(value: unknown, message: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) badRequest(message)
  return n
}

/** Optional id: empty/null/undefined → null, otherwise a trimmed string. */
export function optionalId(value: unknown): string | null {
  const s = String(value ?? '').trim()
  return s || null
}

/** Normalise a registry-style reference: collapse whitespace, uppercase. */
export function normalizeReference(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
}
