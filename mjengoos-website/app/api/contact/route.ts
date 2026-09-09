import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { SITE } from "@/lib/site";

/**
 * Contact / demo-request endpoint (§45), hardened per audit MW-10:
 *
 *  · Same-site Origin/Referer gate when the browser sends one (curl/tests
 *    send neither and pass — they are not browser CSRF/abuse vectors).
 *  · 5 submissions per hour, keyed per client — but x-forwarded-for is
 *    trusted ONLY when TRUST_PROXY is set, mirroring the main app's
 *    rate-limit.ts TRUST_PROXY pattern: with exactly one appending reverse
 *    proxy in front, the LAST XFF value is that proxy's view of the client;
 *    without the flag the header is client-spoofable (rotate XFF → fresh
 *    buckets), so it is ignored and all traffic shares ONE bucket — a
 *    conservative dev posture that fails closed in an unconfigured deploy.
 *  · Raw-body size cap (~16KB) checked BEFORE JSON.parse (Content-Length
 *    honored, actual bytes re-verified after reading) — same shape as the
 *    main app's route-kit audit-#4 fix.
 *  · Honeypot field "companyWebsite": a visually-hidden input humans never
 *    fill; a filled one is a bot and the submission is rejected.
 *  · data/submissions.json is capped at 500 stored entries (oldest dropped
 *    on write) so the gitignored runtime PII file cannot grow unbounded.
 *
 * Still no third-party service is contacted; validation stays server-side.
 */

interface Submission {
  id: string;
  ts: string;
  source: string;
  name: string;
  email: string;
  phone?: string;
  organization?: string;
  role?: string;
  country?: string;
  projectType?: string;
  message?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+0-9 ()-]{7,20}$/;

/** ~16KB — real form payloads are well under 2KB. */
const MAX_BODY_BYTES = 16 * 1024;
/** Retention cap for data/submissions.json (gitignored runtime file). */
const MAX_STORED_SUBMISSIONS = 500;

const REQUESTS = new Map<string, number[]>();
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_HOUR = 5;

/** True when TRUST_PROXY is explicitly enabled (non-empty, not 0/false). */
function isTrustProxyEnabled(): boolean {
  const v = process.env.TRUST_PROXY;
  if (!v || !v.trim()) return false;
  const lower = v.trim().toLowerCase();
  return lower !== "0" && lower !== "false";
}

/**
 * Rate-limit key (see the file header): with TRUST_PROXY set we take the
 * proxy-appended (last) x-forwarded-for entry; without it we deliberately
 * ignore the spoofable header and rate-limit everyone as one bucket.
 */
function rateLimitKey(request: Request): string {
  if (!isTrustProxyEnabled()) return "single-bucket";
  const values = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length > 0 ? `ip:${values[values.length - 1]}` : "anon";
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (REQUESTS.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  REQUESTS.set(key, hits);
  return hits.length > MAX_PER_HOUR;
}

/**
 * Same-site Origin/Referer gate (MW-10). Browsers send Origin on cross-site
 * POST fetches; when either header is present its host must match a host we
 * know we are served from: the request's own Host, the x-forwarded-host the
 * app's /website proxy adds, or the configured public origin. Absent both
 * headers (curl, tests, health probes) → allowed.
 */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (!origin && !referer) return true;

  const allowedHosts = new Set<string>();
  for (const header of ["host", "x-forwarded-host"]) {
    const host = request.headers.get(header)?.toLowerCase();
    if (host) allowedHosts.add(host);
  }
  try {
    allowedHosts.add(new URL(SITE.url).host.toLowerCase());
  } catch {
    // SITE.url is normalized in lib/site.ts; skip on a parse failure.
  }

  const candidates: string[] = [];
  for (const headerValue of [origin, referer]) {
    if (!headerValue) continue;
    try {
      candidates.push(new URL(headerValue).host.toLowerCase());
    } catch {
      return false; // present but unparseable (e.g. "Origin: null") → reject
    }
  }
  return candidates.every((host) => allowedHosts.has(host));
}

function str(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validate(body: Record<string, unknown>): { errors: Record<string, string>; data: Omit<Submission, "id" | "ts"> } {
  const errors: Record<string, string> = {};

  const name = str(body.name, 80);
  const email = str(body.email, 120).toLowerCase();
  const phone = str(body.phone, 20);
  const organization = str(body.organization, 80);
  const role = str(body.role, 40);
  const country = str(body.country, 60);
  const projectType = str(body.projectType, 60);
  const message = str(body.message, 2000);
  const source = str(body.source, 40) || "contact";

  if (name.length < 2) errors.name = "Please enter your name (at least 2 characters).";
  if (!EMAIL_RE.test(email)) errors.email = "Please enter a valid email address.";
  if (phone && !PHONE_RE.test(phone)) errors.phone = "Please enter a valid phone number.";
  if (source !== "signup" && message.length < 10) {
    errors.message = "Please tell us a little about your project (at least 10 characters).";
  }
  if (source === "signup" && !role) {
    errors.role = "Please choose your role.";
  }

  return { errors, data: { source, name, email, phone: phone || undefined, organization: organization || undefined, role: role || undefined, country: country || undefined, projectType: projectType || undefined, message: message || undefined } };
}

export async function POST(request: Request) {
  if (!originAllowed(request)) {
    return NextResponse.json(
      { ok: false, error: "This form only accepts submissions from the MjengoOS website." },
      { status: 403 },
    );
  }

  const key = rateLimitKey(request);
  if (rateLimited(key)) {
    return NextResponse.json(
      { ok: false, error: "Too many submissions from this address. Please try again later." },
      { status: 429 },
    );
  }

  // Raw-size cap BEFORE any parse (route-kit audit-#4 shape): honor the
  // declared Content-Length, then re-check the actual bytes — a lying client
  // still cannot push an oversized payload into JSON.parse.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "That message is too large — please shorten it and try again." },
      { status: 413 },
    );
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "That message is too large — please shorten it and try again." },
      { status: 413 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  // Honeypot: "companyWebsite" is a visually-hidden field humans never see
  // or fill. Anything in it means an automated submitter → reject quietly.
  if (str(body.companyWebsite, 100)) {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const { errors, data } = validate(body);
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ ok: false, errors }, { status: 400 });
  }

  const submission: Submission = {
    id: `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    ...data,
  };

  try {
    const file = path.join(process.cwd(), "data", "submissions.json");
    let existing: Submission[] = [];
    try {
      existing = JSON.parse(await fs.readFile(file, "utf8")) as Submission[];
      if (!Array.isArray(existing)) existing = [];
    } catch {
      // First submission — file doesn't exist yet.
    }
    existing.push(submission);
    // Retention cap (MW-10): keep only the most recent entries so the
    // plaintext contact data on disk stays bounded.
    if (existing.length > MAX_STORED_SUBMISSIONS) {
      existing = existing.slice(existing.length - MAX_STORED_SUBMISSIONS);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(existing, null, 2), "utf8");
  } catch (err) {
    console.error("[contact] failed to persist submission:", err);
    return NextResponse.json(
      { ok: false, error: "We couldn't save your message. Please try again in a moment." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, id: submission.id });
}
