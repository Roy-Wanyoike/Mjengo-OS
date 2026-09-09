# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# MjengoOS marketing website (mjengoos-website/) production image —
# multi-stage, mirroring the root Dockerfile's conventions.
#
#  bun:     oven/bun:1, pinned by image tag — only the bun binary is copied
#           into the stages below (no curl|bash installer).
#  deps:    node:20-slim + bun. `bun install --frozen-lockfile` from the
#           site's own package.json + bun.lock. The site is an independent
#           app: no Prisma, no auth, no database — nothing to generate.
#  builder: `next build` under Node (exactly like CI). The two NEXT_PUBLIC_*
#           vars are BUILD args because Next.js inlines them at build time —
#           switching serving modes means rebuilding the image, not re-running
#           it. Defaults are the integrated mode (basePath /website,
#           same-origin "Sign in") so the compose stack needs zero overrides.
#           Building requires no secrets — the site has none to dummy out
#           (no DATABASE_URL / NEXTAUTH_* involved).
#  runner:  node:20-slim, non-root `node` user, standalone server.js from
#           .next/standalone + .next/static + public/ (the copies that the
#           root app performs in its build script happen here instead — this
#           app's build script stays a plain `next build`). PORT=3001.
#           The contact-form API appends to data/submissions.json, so
#           /app/data is created writable for the non-root user.
#
#  BUILD-time env = the two NEXT_PUBLIC_* ARGs above (no secrets).
#  RUNTIME env (docker run / compose): none required. PORT/HOSTNAME are
#  preset; the web app reaches this container as WEBSITE_ORIGIN in its
#  next.config.ts rewrite (http://website:3001 under compose).
# ---------------------------------------------------------------------------

FROM oven/bun:1 AS bun

FROM node:20-slim AS deps
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Dependencies first (layer-cache friendly).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS builder
WORKDIR /app

# Application source — .dockerignore keeps the context secrets-free
# (.env*, node_modules, .next, data/ never enter an image).
COPY . .

# Integrated mode by default (the web app on :3000 proxies /website/* here):
#   NEXT_PUBLIC_BASE_PATH=/website, "Sign in" → same-origin "/".
# Standalone mode on its own domain instead:
#   docker build --build-arg NEXT_PUBLIC_BASE_PATH= \
#                --build-arg NEXT_PUBLIC_APP_URL=https://app.yourdomain.example …
ARG NEXT_PUBLIC_BASE_PATH=/website
ARG NEXT_PUBLIC_APP_URL=/
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}

# Production build; then place the static assets + public/ inside the
# standalone tree (what the root app's build script does with cp — done
# here so the site's package.json stays untouched).
RUN bun run build \
    && cp -r .next/static .next/standalone/.next/ \
    && cp -r public .next/standalone/

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Next standalone output: server.js, .next/, traced node_modules, public/.
COPY --from=builder --chown=node:node /app/.next/standalone ./

# Runtime state the non-root user must be able to write: the contact-form
# API (POST /api/contact → /website/api/contact) appends here.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3001

CMD ["node", "server.js"]
