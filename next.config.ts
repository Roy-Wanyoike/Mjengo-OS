import type { NextConfig } from "next";

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
    const upstream = process.env.WEBSITE_UPSTREAM || "http://127.0.0.1:3001";
    return [
      { source: "/website", destination: `${upstream}/website` },
      { source: "/website/:path*", destination: `${upstream}/website/:path*` },
    ];
  },
};

export default nextConfig;
