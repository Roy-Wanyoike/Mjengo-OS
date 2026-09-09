import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/**
 * Fixed last-modified date (YYYY-MM-DD), NOT `new Date()`: this sitemap is a
 * static route generated at build time, so a dynamic date would stamp every
 * rebuild as "just modified" even when no page changed. Bump this constant
 * when a deploy actually changes page content.
 */
const SITE_LAST_MODIFIED = "2026-09-09";

/**
 * Public sitemap. URLs join the canonical origin (NEXT_PUBLIC_SITE_URL, MW-9)
 * WITH the serving base path (NEXT_PUBLIC_BASE_PATH) — under the integrated
 * /website proxy the sitemap must list e.g. https://host/website/platform,
 * because that prefixed URL is the one crawlers can actually reach.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = `${SITE.url}${SITE.basePath}`;
  const routes = [
    { path: "", priority: 1.0 },
    { path: "/platform", priority: 0.9 },
    { path: "/solutions", priority: 0.8 },
    { path: "/solutions/client", priority: 0.7 },
    { path: "/solutions/site-supervisors", priority: 0.7 },
    { path: "/solutions/contractors", priority: 0.7 },
    { path: "/solutions/professionals", priority: 0.7 },
    { path: "/solutions/suppliers", priority: 0.7 },
    { path: "/solutions/finance", priority: 0.7 },
    { path: "/land-verification", priority: 0.9 },
    { path: "/professionals", priority: 0.8 },
    { path: "/materials", priority: 0.8 },
    { path: "/marketplace", priority: 0.8 },
    { path: "/wallet", priority: 0.8 },
    { path: "/ai", priority: 0.8 },
    { path: "/projects", priority: 0.8 },
    { path: "/pricing", priority: 0.8 },
    { path: "/about", priority: 0.6 },
    { path: "/contact", priority: 0.7 },
    { path: "/signup", priority: 0.9 },
    { path: "/resources", priority: 0.6 },
    { path: "/security", priority: 0.6 },
    { path: "/privacy", priority: 0.4 },
    { path: "/terms", priority: 0.4 },
  ];

  return routes.map((r) => ({
    url: `${origin}${r.path}`,
    lastModified: SITE_LAST_MODIFIED,
    changeFrequency: "monthly" as const,
    priority: r.priority,
  }));
}
