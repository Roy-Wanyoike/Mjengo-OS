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
  // Audit finding #3: baseline security headers on every response — the
  // marketing site already sends these (mjengoos-website/next.config.ts);
  // the app now matches. Deliberately NO X-Frame-Options and no CSP
  // frame-ancestors: the preview gateway embeds this app in a cross-site
  // iframe, so it must stay embeddable.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
