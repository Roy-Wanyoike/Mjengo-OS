import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Liveness + readiness probe. Public (no auth): exposes service identity
 * and a DB round-trip only — never project data.
 */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { ok: true, service: "MjengoOS", db: "ok", time: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, service: "MjengoOS", db: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
