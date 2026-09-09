// Wallet HTTP helpers (spec §38) — shared by the /api/v1 routes.
// Uniform JSON contract: { ok: true, data } | { ok: false, error }.

import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/backend/lib/db'

export function jsonOk(data: unknown, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: true, data, ...extra })
}

export function jsonErr(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status })
}

// ---------------------------------------------------------------- idempotency

/**
 * sha256 fingerprint of the request payload (issue #75 / BE-9): stored next
 * to an idempotent result so a key reused with a DIFFERENT payload can be
 * detected and refused (409) instead of silently replaying the old result.
 */
export function payloadFingerprint(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex')
}

/**
 * Stored record envelope (v2): the original result body plus the payload
 * fingerprint that produced it. Written as JSON into IdempotencyRecord.
 * responseBody (a TEXT column holding a JSON string — no schema change
 * needed). Legacy records (plain JSON of the result, e.g. from
 * /api/actions' own §57 replay) carry no envelope and replay unchanged.
 */
type StoredEnvelope = { payloadHash: string; body: unknown }

const HASH_64 = /^[0-9a-f]{64}$/

/** Parse a stored responseBody as the v2 envelope; null = legacy/plain record. */
function parseStoredEnvelope(raw: string | null | undefined): StoredEnvelope | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = parsed as { payloadHash?: unknown; body?: unknown }
      if (
        typeof candidate.payloadHash === 'string' &&
        HASH_64.test(candidate.payloadHash) &&
        'body' in candidate
      ) {
        return { payloadHash: candidate.payloadHash, body: candidate.body }
      }
    }
  } catch {
    // not JSON — legacy corner; treat as plain
  }
  return null
}

/**
 * Idempotency-Key handling for money-mutating v1 endpoints (spec §57/§38):
 * a repeated key replays the stored response body; the first successful run
 * persists the record. Failures are never recorded (retry stays possible).
 *
 * Payload-mismatch 409 (issue #75 / BE-9): when the route passes the
 * validated request payload, its fingerprint is stored with the result and
 * compared on every keyed replay. A key reused with a DIFFERENT payload is
 * a client bug — silently replaying the old result would diverge the
 * client's intent from the ledger, so the route answers 409 with the v1
 * error shape ({ error }) and does NOT replay. Same payload → replay
 * verbatim. Routes that pass no payload keep the historical unconditional
 * replay (legacy records always do).
 */
export async function withIdempotency(
  req: NextRequest,
  scope: string,
  projectId: string | null,
  run: () => Promise<unknown>,
  payload?: unknown,
): Promise<NextResponse> {
  // Canonical header is Idempotency-Key; the x-idempotency-key variant is
  // accepted too (clients send both spellings — money dedupes either way).
  const key =
    req.headers.get('idempotency-key')?.trim() || req.headers.get('x-idempotency-key')?.trim()
  if (!key) {
    const data = await run()
    return jsonOk(data)
  }
  const existing = await db.idempotencyRecord.findUnique({ where: { key } })
  if (existing) {
    const envelope = parseStoredEnvelope(existing.responseBody)
    if (envelope && payload !== undefined && envelope.payloadHash !== payloadFingerprint(payload)) {
      // Same key, different request → refuse. Never silently replay money.
      return NextResponse.json(
        {
          error:
            'Idempotency-Key was already used with a different payload — the stored result was NOT replayed. ' +
            'Send a new key for a new request.',
        },
        { status: 409 },
      )
    }
    let replayed: unknown = null
    if (envelope) {
      replayed = envelope.body
    } else {
      try {
        replayed = JSON.parse(existing.responseBody ?? 'null')
      } catch {
        replayed = null
      }
    }
    return jsonOk(replayed, { replayed: true, scope: existing.scope })
  }
  const data = await run()
  try {
    await db.idempotencyRecord.create({
      data: {
        key,
        scope,
        projectId,
        responseBody:
          payload !== undefined
            ? JSON.stringify({ payloadHash: payloadFingerprint(payload), body: data ?? null })
            : JSON.stringify(data ?? null),
      },
    })
  } catch {
    // Unique collision = concurrent duplicate already stored — the original
    // result stands; this response matches it.
  }
  return jsonOk(data)
}
