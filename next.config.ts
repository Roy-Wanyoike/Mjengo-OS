import type { NextConfig } from "next";

// Upstream origin of the marketing website (mjengoos-website/, a separate
// Next.js app) for the /website/* rewrite below. Local dev default is the
// site's own server on 127.0.0.1:3001; under docker-compose the service name
// resolves instead — docker-compose.yml sets WEBSITE_ORIGIN=http://website:3001
// on the app service.
const WEBSITE_ORIGIN = process.env.WEBSITE_ORIGIN ?? "http://127.0.0.1:3001";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  // Standalone-output runtime deps that the file tracer cannot discover
  // statically: Prisma's generated client (node_modules/.prisma) resolves
  // its engine via a dynamic path, and `prisma migrate deploy` (run by the
  // Docker entrypoint) needs the schema. Force-include them for every route.
  // Belt-and-braces: the Dockerfile also COPYies these into the runner image
  // explicitly, so the image stays correct even if tracing misses them.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/.prisma/**/*",
      "./node_modules/@prisma/client/**/*",
      "./prisma/schema.prisma",
    ],
  },
  // Integrated marketing-website serving: the website (a separate Next.js
  // app on port 3001, basePath=/website) is proxied through THIS app so the
  // whole product is reachable from one origin — the preview gateway only
  // reliably serves the default route (port 3000); a second app's assets
  // 502 through the query-param mechanism. With this proxy the website is
  // browsable at /website (pages, assets, hydration, API) and its
  // "Sign in" lands on this app's login screen at "/" — one origin, one
  // cookie domain. The website dev server must be running for /website.
  async rewrites() {
    return [
      { source: "/website", destination: `${WEBSITE_ORIGIN}/website` },
      { source: "/website/:path*", destination: `${WEBSITE_ORIGIN}/website/:path*` },
    ];
  },
  // Security headers, issue #178 / audit SEC-11 — the STATIC half of the set:
  // scheme-independent, no per-request values, applied to EVERY response
  // (including the paths src/proxy.ts skips: _next/static, /website,
  // /offline.html). The DYNAMIC half (nonce CSP, HSTS on https, the
  // frame-ancestors allowlist + conditional X-Frame-Options) lives in
  // src/proxy.ts — see src/backend/lib/security-headers.ts for the design.
  // Framing posture: the app IS embeddable by design (the preview gateway
  // embeds it in a cross-site iframe), so instead of X-Frame-Options the
  // proxy sends CSP frame-ancestors 'self' + EMBED_ORIGINS (env knob,
  // MUTATION_ORIGIN_ALLOWLIST's model) — the legit embedder is declared by
  // the operator, everything else is refused.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            // Lock-down with per-feature enables (issue #178): camera +
            // microphone stay enabled for THIS origin only (evidence capture
            // and the voice-notes copilot use getUserMedia — cross-origin
            // embedders additionally need their own iframe allow attribute);
            // everything sensitive the app never uses is denied outright.
            key: "Permissions-Policy",
            value:
              "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), nfc=(), idle-detection=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
