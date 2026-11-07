# syntax=docker/dockerfile:1.7
# Multi-stage build for Social Lite. Targets:
#   web    — Next.js standalone server (port 3000)
#   worker — background worker (health on 3001); also runs migrations: `node dist/migrate.mjs migrate`
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Optional egress proxy CA for restricted build environments (BuildKit secret "extra_ca"); not copied to runtime images.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then cp /run/secrets/extra_ca /usr/local/share/extra-ca.crt; else touch /usr/local/share/extra-ca.crt; fi
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/extra-ca.crt
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/providers/package.json packages/providers/
COPY packages/services/package.json packages/services/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @social-lite/web build && pnpm --filter @social-lite/worker build \
 && pnpm --filter @social-lite/worker deploy --prod --legacy /out/worker

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# ffmpeg/ffprobe for the V1.1 video pipeline (probe, poster frame, transcode). Uses the optional build-time
# proxy CA (BuildKit secret "extra_ca") for apt only; it is mounted, never copied into the runtime image.
RUN --mount=type=secret,id=extra_ca,required=false \
    set -eu; APT_CA=""; \
    if [ -s /run/secrets/extra_ca ]; then APT_CA="-o Acquire::https::CAInfo=/run/secrets/extra_ca"; fi; \
    apt-get $APT_CA update \
 && apt-get $APT_CA install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && ffprobe -version >/dev/null
RUN useradd --uid 10001 --create-home app
COPY --from=build --chown=app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app /repo/packages/db/migrations ./packages/db/migrations
USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations WORKER_HEALTH_PORT=3001
WORKDIR /app
# ffmpeg/ffprobe for the V1.1 video pipeline (probe, poster frame, transcode). Uses the optional build-time
# proxy CA (BuildKit secret "extra_ca") for apt only; it is mounted, never copied into the runtime image.
RUN --mount=type=secret,id=extra_ca,required=false \
    set -eu; APT_CA=""; \
    if [ -s /run/secrets/extra_ca ]; then APT_CA="-o Acquire::https::CAInfo=/run/secrets/extra_ca"; fi; \
    apt-get $APT_CA update \
 && apt-get $APT_CA install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && ffprobe -version >/dev/null
RUN useradd --uid 10001 --create-home app
COPY --from=build --chown=app /out/worker/node_modules ./node_modules
COPY --from=build --chown=app /repo/apps/worker/dist ./dist
COPY --from=build --chown=app /repo/packages/db/migrations ./migrations
USER app
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.mjs"]
