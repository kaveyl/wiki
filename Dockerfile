# syntax=docker/dockerfile:1
# Multi-stage build: install + build web and server, then a small runtime with git and only
# the native modules the server bundle keeps external (better-sqlite3, @parcel/watcher).

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# --ignore-scripts: better-sqlite3 ships prebuilt binaries; esbuild/rollup/watcher use optional platform packages.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.base.json LICENSE ./
COPY packages packages
COPY apps apps
# The user manual becomes the in-app help (/hilfe/…).
COPY docs/BENUTZERHANDBUCH.md docs/API.md docs/
COPY docs/handbuch docs/handbuch
# Translated manuals (AD-046), one folder per language.
COPY docs/i18n docs/i18n
# The example agent the manual offers as a download (/hilfe/beispiele/…).
COPY examples/incident-agent examples/incident-agent
# Licence texts of everything shipped (AD-064): written by npm run build into the web app.
COPY scripts/third-party-notices.mjs scripts/
COPY scripts/licenses scripts/licenses
COPY scripts/runtime-lock.mjs scripts/
# Runtime package.json + lockfile: the esbuild externals, pinned from package-lock.json (sec-011).
RUN npm run build \
 && node scripts/runtime-lock.mjs /src/runtime better-sqlite3 @parcel/watcher

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
ARG KAVEYL_WIKI_VERSION=dev
ARG BUILD_DATE=
# No source URL on purpose: the image may be passed on (AD-043).
LABEL org.opencontainers.image.title="Kaveyl Wiki" \
      org.opencontainers.image.description="Wiki mit Git als einzigem Speicher – Markdown in Repositories und Ordnern" \
      org.opencontainers.image.version="${KAVEYL_WIKI_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV NODE_ENV=production \
    KAVEYL_WIKI_VERSION=${KAVEYL_WIKI_VERSION} \
    PORT=8000 \
    DATA_PATH=/data \
    CONFIG_PATH=/config \
    WEB_ROOT=/app/web \
    LOCAL_ROOTS=/docs \
    BACKUP_ROOT=/backup
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini smbclient \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/runtime/package.json /src/runtime/package-lock.json ./
# npm ci: exactly the lockfile (integrity checked); prebuilt binaries ship in the packages. Then the package managers
# of the base image go: nothing runs them at runtime, and their bundled modules only add known vulnerabilities.
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /root/.npm
COPY --from=build /src/apps/server/dist/server.mjs ./server.mjs
# The file watcher runs in a process of its own (AD-054), started by the server from next to it.
COPY --from=build /src/apps/server/dist/watcher.mjs ./watcher.mjs
COPY --from=build /src/apps/server/dist/import-worker.mjs ./import-worker.mjs
COPY --from=build /src/apps/server/dist/markdown-worker.mjs ./markdown-worker.mjs
COPY --from=build /src/apps/web/dist ./web
# Licence of Kaveyl Wiki; the third-party licences are in web/THIRD-PARTY-NOTICES.txt (AD-064).
COPY LICENSE ./LICENSE
# The image's built-in "node" user (uid/gid 1000) matches the host user owning
# the mounted folders (data, config, docs).
USER node
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
