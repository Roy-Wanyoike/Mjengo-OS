/*
 * Central site configuration — names, URLs and shared constants.
 */

/** The dev origin every absolute URL falls back to (MW-9, audit WD-9). */
const DEV_ORIGIN = "http://localhost:3001";

/** Trimmed value with trailing slashes stripped ("" when absent/blank). */
function trimmed(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

/** True when the value is a parseable absolute URL (what normalizeOrigin bakes). */
function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeOrigin(raw: string | undefined, fallback: string): string {
  const value = trimmed(raw);
  if (!value || !isAbsoluteUrl(value)) return fallback;
  return new URL(value).toString().replace(/\/+$/, "");
}

/** "/website" → "/website", "website/" → "/website", "" → "". */
function normalizeBasePath(raw: string | undefined): string {
  const value = trimmed(raw);
  if (!value) return "";
  return value.startsWith("/") ? value : `/${value}`;
}

export const SITE = {
  name: "MjengoOS",
  tagline: "Build with evidence.",
  description:
    "From land verification to project completion, MjengoOS connects the people, materials, money and physical evidence behind your construction project.",
  positioning: "The operating system for real-world construction.",
  expansion: "Kenya first. Africa next. Global eventually.",
  /**
   * Canonical public origin (no trailing slash), from NEXT_PUBLIC_SITE_URL.
   * Deployments MUST set it (the website Dockerfile takes it as the
   * NEXT_PUBLIC_SITE_URL build arg) — otherwise every absolute URL the site
   * emits (sitemap.xml, robots.txt, canonicals, OG/Twitter, JSON-LD) falls
   * back to the dev origin http://localhost:3001. Local dev needs nothing.
   * A production STANDALONE build without a usable value warns at build
   * time (#149) — see siteUrlBuildWarning below; DEPLOYMENT.md §6.7 is the
   * launch-gate checklist.
   */
  url: normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL, DEV_ORIGIN),
  /**
   * Path prefix the site is served under — "/website" in integrated mode
   * (the web app proxies /website/* here; the Dockerfile bakes it as
   * NEXT_PUBLIC_BASE_PATH), "" for a standalone deployment on its own
   * domain. Absolute public URLs must join origin + basePath:
   * `${SITE.url}${SITE.basePath}/platform`. relative-canonical/OG metadata
   * resolves against metadataBase, which layout.tsx builds the same way.
   */
  basePath: normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH),
  /**
   * Where "Sign in" points — the MjengoOS application itself. Behind a
   * single-origin gateway the app lives at the bare "/" (same host, no
   * XTransformPort query), which is the default. Standalone deployments
   * set e.g. "https://app.mjengoos.com".
   */
  appUrl: (process.env.NEXT_PUBLIC_APP_URL ?? "/").replace(/\/$/, "") || "/",
  /**
   * Optional public contact mailbox. No real mailbox exists today (the old
   * hello@mjengoos.example.com was an RFC-2606 placeholder — undeliverable),
   * so the contact form (/contact) is the primary channel: privacy §8 and
   * terms §10 say exactly that. Set NEXT_PUBLIC_CONTACT_EMAIL at launch
   * when a real mailbox exists; consumers render it only when non-null.
   */
  contactEmail: (process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "").trim() || null,
  country: "Kenya",
  region: "East Africa",
} as const;

export type Site = typeof SITE;

/** The env slice the launch-gate warning decision reads (issue #149). */
export interface SiteUrlBuildWarningEnv {
  NODE_ENV?: string | undefined;
  NEXT_PUBLIC_BASE_PATH?: string | undefined;
  NEXT_PUBLIC_SITE_URL?: string | undefined;
}

/**
 * Launch-gate warning for `next build` (issue #149 / audit WD-9). SITE.url
 * falling back to the dev origin is CORRECT for local dev and harmless for
 * the un-indexed integrated default — the gap was that it reached an
 * indexed production deploy only as a doc footnote. This promotes it to a
 * build-time gate for the ONE combination that means "indexed site,
 * localhost URLs": a production build in standalone mode (no
 * NEXT_PUBLIC_BASE_PATH — i.e. its own domain, the mode crawlers index)
 * with no usable NEXT_PUBLIC_SITE_URL. Returns the message to print, or
 * null when the build should stay silent:
 *
 *  · NODE_ENV ≠ production (next dev, tests) → silent: localhost IS the
 *    honest dev origin;
 *  · basePath set (integrated mode) → silent: that is the compose
 *    zero-override default this repo deliberately keeps quiet (AC #3);
 *  · SITE_URL empty, or set to something no URL parser accepts (the same
 *    unparseable value normalizeOrigin silently falls back on) → WARN.
 *
 * Pure on its env argument so the root suite can pin the whole matrix;
 * next.config.ts is only the wiring (a warn, never a build failure — a
 * deliberate localhost build for internal use must still succeed, it just
 * says so). DEPLOYMENT.md §6.7 carries the human checklist.
 */
export function siteUrlBuildWarning(env: SiteUrlBuildWarningEnv): string | null {
  if (env.NODE_ENV !== "production") return null;
  if (normalizeBasePath(env.NEXT_PUBLIC_BASE_PATH)) return null;
  const siteUrl = trimmed(env.NEXT_PUBLIC_SITE_URL);
  if (siteUrl && isAbsoluteUrl(siteUrl)) return null;
  const why = siteUrl
    ? `set to "${siteUrl}", which is not a parseable absolute URL`
    : "not set";
  return (
    `[site-url] production build in standalone mode (NEXT_PUBLIC_BASE_PATH unset) ` +
    `with NEXT_PUBLIC_SITE_URL ${why} — every absolute URL this build bakes ` +
    `(sitemap.xml, robots.txt sitemap link, canonicals, OG/Twitter, JSON-LD) ` +
    `falls back to ${DEV_ORIGIN}, so an indexed site would tell crawlers its ` +
    `real pages live on localhost. Rebuild with the public origin as a build ` +
    `arg (--build-arg NEXT_PUBLIC_SITE_URL=https://yourdomain.example) before ` +
    `serving an indexed site — DEPLOYMENT.md §6.7 is the launch gate. ` +
    `Integrated /website builds (the compose default) and local dev stay silent by design.`
  );
}
