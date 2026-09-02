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
