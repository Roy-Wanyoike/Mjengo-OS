import { execSync } from "node:child_process";
import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/**
 * lastModified derivation (issue #143 / audit WD-6) — replaces the frozen
 * `2026-09-09` constant nobody remembered to bump. This sitemap is a static
 * route generated at build time, so the ladder below runs once per build and
 * a rebuild without source changes keeps the same date (the old reason a
 * bare `new Date()` was rejected: it would stamp every rebuild as "just
 * modified"):
 *
 *   1. `SITEMAP_LAST_MODIFIED` — explicit ISO-8601 override, the Docker
 *      path: the repo's `.git` never enters the image build context, so
 *      image builds pass the date the builder already knows as a build ARG,
 *      e.g. `--build-arg SITEMAP_LAST_MODIFIED="$(git log -1 --format=%cI
 *      -- mjengoos-website)"`. Not a `NEXT_PUBLIC_*` var — it is read
 *      server-side at build, never inlined into client bundles.
 *   2. The last commit that touched this site — `git log -1 --format=%cI
 *      -- .` (cwd is the site root during `next build`, the same
 *      process.cwd() convention the contact route's data/ writes rely on).
 *      Truthful per deploy: the date only moves when the site's source
 *      actually changes.
 *   3. Neither (no git metadata and no override — e.g. building from an
 *      exported tree): omit lastModified entirely. A missing lastmod is
 *      honest and simply ignored by crawlers; an invented date trains them
 *      the field is noise — which was the bug.
 *
 * `changeFrequency` is deliberately gone: all 24 entries used to claim
 * "monthly" regardless of how often each page really changes, and Google
 * ignores the element outright — a uniform guess is worse than saying
 * nothing (#143 acceptance criteria).
 */
function lastModifiedDate(): Date | null {
  const override = (process.env.SITEMAP_LAST_MODIFIED ?? "").trim();
  if (override) {
    const parsed = new Date(override);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    // A set-but-unparseable override is a build misconfiguration, not a
    // reason to invent a date — say so visibly, then fall through to git.
    console.warn(
      `[sitemap] SITEMAP_LAST_MODIFIED is set but not a parseable date (${override}); falling back to git metadata`,
    );
  }
  try {
    const iso = execSync("git log -1 --format=%cI -- .", {
      encoding: "utf8",
      // stderr piped, not inherited: a missing .git (Docker build context)
      // must not pollute the build log — the failure is expected and handled.
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  } catch {
    // No git metadata here (image build context, exported source tarball).
  }
  return null;
}

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

  const lastModified = lastModifiedDate();
  return routes.map((r) => ({
    url: `${origin}${r.path}`,
    // Key absent (not null/undefined) when no truthful date could be derived.
    ...(lastModified ? { lastModified } : {}),
    priority: r.priority,
  }));
}
