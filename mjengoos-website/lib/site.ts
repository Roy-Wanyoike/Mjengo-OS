/*
 * Central site configuration — names, URLs and shared constants.
 */

function normalizeOrigin(raw: string | undefined, fallback: string): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return fallback;
  try {
    return new URL(value).toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

/** "/website" → "/website", "website/" → "/website", "" → "". */
function normalizeBasePath(raw: string | undefined): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
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
   */
  url: normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL, "http://localhost:3001"),
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
