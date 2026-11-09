# syntax=docker/dockerfile:1.7
# Relay production images (multi-arch: linux/arm64 for the Oracle Ampere VM, linux/amd64 too).
# Build with infra/oracle/build.sh (docker buildx bake, see docker-bake.hcl). Targets:
#   web      Next.js standalone server, port 3000; includes apps/web/public and content/help. No ffmpeg (worker-only).
#   worker   background worker, health on 3001; ffmpeg/ffprobe for the video pipeline.
#   migrate  one-shot release job (roles -> migrations -> grants -> media bucket). Same layers as worker plus ~1 MB.
# All targets run as uid 10001 (non-root). No secrets are baked in: configuration comes from the environment at run time.
# The build stages run on the target platform (native on an arm64 host, QEMU emulation elsewhere) so native modules
# (sharp, esbuild) match the runtime architecture.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Optional egress-proxy CA for restricted build environments (BuildKit secret "extra_ca"); never copied to runtime images.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then cp /run/secrets/extra_ca /usr/local/share/extra-ca.crt; else touch /usr/local/share/extra-ca.crt; fi
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/extra-ca.crt
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS deps
ARG TARGETARCH
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/providers/package.json packages/providers/
COPY packages/services/package.json packages/services/
RUN --mount=type=cache,id=relay-pnpm-store-${TARGETARCH},target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

FROM deps AS build
# next.config.ts decides at build time whether to emit HSTS (APP_ENV=production). Runtime settings are separate.
ARG APP_ENV_AT_BUILD=production
COPY . .
RUN APP_ENV=${APP_ENV_AT_BUILD} pnpm --filter @social-lite/web build \
 && pnpm --filter @social-lite/worker build \
 && node infra/oracle/ops/build-ops.mjs /out/ops \
 && pnpm --filter @social-lite/worker deploy --prod --legacy /out/worker \
 && rm -rf /out/worker/src /out/worker/build.mjs

# ---------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG RELAY_VERSION=dev
LABEL org.opencontainers.image.title="Relay" org.opencontainers.image.version="${RELAY_VERSION}" \
      org.opencontainers.image.source="https://github.com/vitalos-technologies/relay"
ENV NODE_ENV=production APP_ENV=production APP_VERSION=${RELAY_VERSION} NEXT_TELEMETRY_DISABLED=1
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /app --shell /usr/sbin/nologin app
WORKDIR /app

FROM runtime AS web
ENV PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=10001:10001 /repo/apps/web/.next/static ./apps/web/.next/static
# The standalone output has no public/ folder and does not trace content read at run time (Help Centre).
COPY --from=build --chown=10001:10001 /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=10001:10001 /repo/content/help ./content/help
COPY --from=build --chown=10001:10001 /repo/packages/db/migrations ./packages/db/migrations
ENV HELP_CONTENT_DIR=/app/content/help MIGRATIONS_DIR=/app/packages/db/migrations
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

FROM runtime AS worker
# ffmpeg/ffprobe for the video pipeline. The optional proxy CA is mounted for apt only, never copied.
RUN --mount=type=secret,id=extra_ca,required=false \
    set -eu; APT_CA=""; \
    if [ -s /run/secrets/extra_ca ]; then APT_CA="-o Acquire::https::CAInfo=/run/secrets/extra_ca"; fi; \
    apt-get $APT_CA update \
 && apt-get $APT_CA install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && ffprobe -version >/dev/null
ENV MIGRATIONS_DIR=/app/migrations WORKER_HEALTH_PORT=3001 DB_ROLES_SQL=/app/roles.sql
COPY --from=build --chown=10001:10001 /out/worker/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /repo/apps/worker/dist ./dist
COPY --from=build --chown=10001:10001 /repo/packages/db/migrations ./migrations
COPY --from=build --chown=10001:10001 /repo/infra/postgres/roles.sql ./roles.sql
USER 10001:10001
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.mjs"]

FROM worker AS migrate
COPY --from=build --chown=10001:10001 /out/ops ./ops
COPY --chown=10001:10001 infra/oracle/ops/ensure-bucket.mjs infra/oracle/ops/release.sh ./ops/
HEALTHCHECK NONE
CMD ["sh", "ops/release.sh"]
