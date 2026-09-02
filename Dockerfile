# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# MjengoOS production image (multi-stage, both stages Debian bookworm amd64)
#
#  builder: node:20-slim + the official bun binary (copied from oven/bun:1 —
#           pinned by image tag, no curl|bash). `bun install --frozen-lockfile`
#           uses bun (the repo's package manager / bun.lock); `bunx prisma
#           generate` and `next build` then run under Node, exactly like the
#           GitHub Actions build job. (Bun's shell runs #!/usr/bin/env node
#           bins with node when node is present — verified locally; under
#           pure-bun it falls back to bun, which also works, but Node is the
#           zero-unknown runtime for `next build`.)
#
#  runner:  node:20-slim. The standalone server.js emitted by Next and the
#           prisma CLI (node_modules/prisma/build/index.js) are Node programs,
#           so Node is their officially supported runtime. Same Debian base
#           as the builder, so the Prisma engine binaries generated there
#           (libquery_engine-debian-openssl-3.0.x.so.node,
#           schema-engine-debian-openssl-3.0.x) run here unchanged.
#
#  startup: `prisma migrate deploy` (offline — CLI, engines, schema and
#           prisma/migrations are all COPYied into the image; no network,
#           no bunx download) then `node server.js`.
#
#  BUILD-time env is dummy (DATABASE_URL=file:build.db, NEXTAUTH_SECRET=dummy)
#  — building must never require real secrets. RUNTIME env (docker run /
#  compose): DATABASE_URL, NEXTAUTH_SECRET, optionally NEXTAUTH_URL /
#  AUTH_TRUST_HOST — see .env.example and DEPLOYMENT.md.
# ---------------------------------------------------------------------------

FROM oven/bun:1 AS bun

FROM node:20-slim AS builder
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Dependencies first (layer-cache friendly).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Application source — .dockerignore keeps the context secrets-free
# (.env* and db/ never enter an image).
COPY . .

# Prisma client + engine for this platform (idempotent; mirrors the CI job).
RUN bunx prisma generate

# Production build. The repo's build script already copies .next/static and
# public/ into .next/standalone — that is what the runner ships.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXTAUTH_SECRET=build-time-dummy-secret-0123456789abcdef \
    DATABASE_URL="file:build.db"
RUN bun run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Next standalone output: server.js, .next/, traced node_modules, public/.
COPY --from=builder --chown=node:node /app/.next/standalone ./

# Prisma, for `migrate deploy` at container start (fully offline):
#   node_modules/prisma   — the CLI (bin: build/index.js)
#   node_modules/@prisma  — schema + query engine binaries
#   node_modules/.prisma  — generated client. outputFileTracingIncludes in
#                           next.config.ts should already trace the client
#                           into the standalone tree; these COPYs are the
#                           belt-and-braces guarantee either way.
COPY --from=builder --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma

# Schema + migration history for `prisma migrate deploy`.
COPY --chown=node:node prisma/schema.prisma ./prisma/schema.prisma
COPY --chown=node:node prisma/migrations ./prisma/migrations

# Runtime state the non-root user must be able to write: the SQLite database
# (mount a volume at /app/db, set DATABASE_URL=file:/app/db/custom.db) and
# uploads (POST /api/upload → public/photos/upp-*.jpg; the documents module
# writes public/docs/ on demand).
RUN mkdir -p /app/db /app/public/photos /app/public/docs \
    && chown -R node:node /app/db /app/public

USER node
EXPOSE 3000

# Migrate, then serve. `migrate deploy` is a no-op when already up to date.
# Skip migrations for a specific run: docker run … mjengoos node server.js
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node server.js"]
