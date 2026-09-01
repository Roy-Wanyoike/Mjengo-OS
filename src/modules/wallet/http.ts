// Wallet HTTP helpers (spec §38) — shared by the /api/v1 routes.
// Uniform JSON contract: { ok: true, data } | { ok: false, error }.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export function jsonOk(data: unknown, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: true, data, ...extra })
}

export function jsonErr(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status })
}

/**
 * Idempotency-Key handling for money-mutating v1 endpoints (spec §57/§38):
 * a repeated key replays the stored response body; the first successful run
 * persists the record. Failures are never recorded (retry stays possible).
 */
export async function withIdempotency(
  req: NextRequest,
  scope: string,
  projectId: string | null,
  run: () => Promise<unknown>,
): Promise<NextResponse> {
  const key = req.headers.get('idempotency-key')?.trim()
  if (!key) {
    const data = await run()
    return jsonOk(data)
  }
  const existing = await db.idempotencyRecord.findUnique({ where: { key } })
  if (existing) {
    let replayed: unknown = null
    try {
      replayed = JSON.parse(existing.responseBody ?? 'null')
    } catch {
      replayed = null
    }
    return jsonOk(replayed, { replayed: true, scope: existing.scope })
  }
  const data = await run()
  try {
    await db.idempotencyRecord.create({
      data: { key, scope, projectId, responseBody: JSON.stringify(data ?? null) },
    })
  } catch {
    // Unique collision = concurrent duplicate already stored — the original
    // result stands; this response matches it.
  }
  return jsonOk(data)
}
