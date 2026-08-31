import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

/**
 * Contact / demo-request endpoint (§45).
 *
 * Validates server-side, rate-limits per IP (in-memory — single-node dev
 * posture, documented in README), and appends the submission to
 * data/submissions.json. No third-party service is contacted.
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

const REQUESTS = new Map<string, number[]>();
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_HOUR = 5;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (REQUESTS.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  REQUESTS.set(ip, hits);
  return hits.length > MAX_PER_HOUR;
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
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many submissions from this address. Please try again later." },
      { status: 429 },
    );
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
