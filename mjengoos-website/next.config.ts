import type { NextConfig } from "next";
import { siteUrlBuildWarning } from "./lib/site";

/**
 * Base path for the integrated serving mode: the web app (port 3000) proxies
 * `/website/*` to this server, so the site must generate all its URLs under
 * that prefix (pages, assets, API). Set NEXT_PUBLIC_BASE_PATH=/website for
 * sandbox/preview use; leave unset for a standalone deployment on its own
 * domain. Trailing slashes are stripped defensively.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, "") || undefined;

// Launch gate (issue #149 / audit WD-9): a production build in STANDALONE
// mode (no base path — the own-domain serving mode crawlers index) with no
// usable NEXT_PUBLIC_SITE_URL bakes the dev origin http://localhost:3001
// into every absolute URL (sitemap.xml, robots.txt, canonicals, OG/Twitter,
// JSON-LD). Warn at build time — the one moment it is still a one-line fix.
// The decision lives in lib/site.ts (pure, pinned by the root suite); this
// is only the wiring. A warn, never a failure: the integrated zero-override
// default (basePath set) and local dev stay silent by design, and a
// deliberate localhost build for internal use still succeeds — it just
// says so. DEPLOYMENT.md §6.7 carries the human launch checklist.
// Next 16 evaluates next.config.ts once in the main process and again in
// the page-data worker (a separate process), so a standalone build log
// shows this line twice — once per evaluation, no cross-process dedupe
// exists, and a repeated loud warning beats a missed one.
const siteUrlWarning = siteUrlBuildWarning(process.env);
if (siteUrlWarning) console.warn(siteUrlWarning);

const nextConfig: NextConfig = {
  // Emit .next/standalone/server.js like the main app (root next.config.ts)
  // so the Docker runner image ships only the traced runtime — not the
  // 600+ MB node_modules tree (`next start` keeps working locally: Next 16
  // still produces the full .next/ build output alongside the standalone copy).
  output: "standalone",
  // Pin the standalone/tracing root to THIS directory. Next 16 otherwise
  // infers a workspace root by walking up for lockfiles/.git — inside the
  // repo that is the monorepo root, and the standalone output then nests
  // under .next/standalone/mjengoos-website/ (context-dependent). Pinning
  // keeps the layout deterministic everywhere: server.js + the traced
  // node_modules land directly in .next/standalone/, exactly what the
  // Dockerfile's runner stage copies. Builds always run from this dir
  // (package.json script / Docker WORKDIR).
  outputFileTracingRoot: process.cwd(),
  basePath,
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Baseline security headers for every response (mirrors the app's posture).
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
        ],
      },
    ];
  },
};

export default nextConfig;
