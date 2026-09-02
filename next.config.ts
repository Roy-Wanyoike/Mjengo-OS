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
};

export default nextConfig;
