/*
 * Central site configuration — names, URLs and shared constants.
 */

export const SITE = {
  name: "MjengoOS",
  tagline: "Build with evidence.",
  description:
    "From land verification to project completion, MjengoOS connects the people, materials, money and physical evidence behind your construction project.",
  positioning: "The operating system for real-world construction.",
  expansion: "Kenya first. Africa next. Global eventually.",
  /** Canonical public origin (no trailing slash). */
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/$/, ""),
  /**
   * Where "Sign in" points — the MjengoOS application itself. Behind a
   * single-origin gateway the app lives at the bare "/" (same host, no
   * XTransformPort query), which is the default. Standalone deployments
   * set e.g. "https://app.mjengoos.com".
   */
  appUrl: (process.env.NEXT_PUBLIC_APP_URL ?? "/").replace(/\/$/, "") || "/",
  contactEmail: "hello@mjengoos.example.com",
  country: "Kenya",
  region: "East Africa",
} as const;

export type Site = typeof SITE;
