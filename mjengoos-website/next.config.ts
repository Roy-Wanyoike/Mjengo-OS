import type { NextConfig } from "next";

/**
 * Base path for the integrated serving mode: the web app (port 3000) proxies
 * `/website/*` to this server, so the site must generate all its URLs under
 * that prefix (pages, assets, API). Set NEXT_PUBLIC_BASE_PATH=/website for
 * sandbox/preview use; leave unset for a standalone deployment on its own
 * domain. Trailing slashes are stripped defensively.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, "") || undefined;

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
