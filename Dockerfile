# CUTOS production image.
#
# The single most important line in this file is the `ffmpeg` install. CUTOS is
# a video editor: without ffmpeg and ffprobe every upload is accepted, stored,
# and then fails to probe, which is indistinguishable from "the site is broken"
# to the person holding the phone. A generic Node buildpack does not install
# them — so a deployment that auto-detects its own build cannot work, no matter
# how correct the application code is.
#
# Deliberately two plain stages rather than a finely-sliced dependency cache.
# pnpm workspaces put a `node_modules` in EVERY package (packages/media has its
# own `zod` symlink into the root `.pnpm` store), so hand-picking directories to
# copy between stages is an easy way to produce an image that builds and then
# fails to resolve a workspace dependency at runtime. Installing and building in
# one place and copying the result wholesale costs some layer caching and buys
# an image that cannot be subtly wrong.
#
# Node 20 is the floor declared in package.json; this pins 22 to match the
# development toolchain.

# ---------------------------------------------------------------------------
# Stage 1 — install and build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN corepack enable

# The commit being built. Zeabur exposes ZEABUR_GIT_COMMIT_SHA / _BRANCH to the
# build; passing them through as build args is what lets /api/version answer
# "which commit is this?" from an image that has no .git directory (it is
# excluded by .dockerignore). At runtime the platform's own variables take
# precedence over this stamp — see server/build-info.ts.
ARG ZEABUR_GIT_COMMIT_SHA=""
ARG ZEABUR_GIT_BRANCH=""
ARG CUTOS_GIT_SHA=""
ARG CUTOS_GIT_BRANCH=""
ENV ZEABUR_GIT_COMMIT_SHA=$ZEABUR_GIT_COMMIT_SHA \
    ZEABUR_GIT_BRANCH=$ZEABUR_GIT_BRANCH \
    CUTOS_GIT_SHA=$CUTOS_GIT_SHA \
    CUTOS_GIT_BRANCH=$CUTOS_GIT_BRANCH \
    NEXT_TELEMETRY_DISABLED=1

# Manifests first, so an unchanged dependency set still reuses this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/agent/package.json ./packages/agent/
COPY packages/edit-dsl/package.json ./packages/edit-dsl/
COPY packages/jobs/package.json ./packages/jobs/
COPY packages/media/package.json ./packages/media/
COPY packages/preview/package.json ./packages/preview/
COPY packages/project-store/package.json ./packages/project-store/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/semantic/package.json ./packages/semantic/
COPY packages/storage/package.json ./packages/storage/
COPY packages/timeline/package.json ./packages/timeline/

RUN pnpm install --frozen-lockfile

COPY . .

# `prebuild` stamps apps/web/.build-info.json from the args above.
# NODE_ENV is set only for the build itself: setting it earlier would make
# `pnpm install` skip devDependencies, and Next cannot build without them.
RUN NODE_ENV=production pnpm build

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# The reason this Dockerfile exists. `ffmpeg` provides both binaries;
# ca-certificates is needed for outbound TLS (the AIOS bridge). Both binaries
# are executed here so a broken image fails at build time rather than at a
# user's first upload.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    ffmpeg -version && ffprobe -version

RUN corepack enable

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    CUTOS_DATA_DIR=/data

# Everything: source, node_modules (all of them, including each package's own),
# and the built .next output.
COPY --from=build /app ./

# Uploads, the SQLite databases and exported media all land here. This default
# is only a default: if no volume is mounted at /data the directory lives in the
# container layer and every project vanishes on redeploy — which /api/health
# reports as DATA_DIR_EPHEMERAL rather than letting it pass silently.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 8080

# `/api/ready` is the gate: 200 only when the deployment can genuinely accept
# video work. Generous start-period because the first request builds the runtime.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The same command used in development and CI. `next start` reads PORT.
CMD ["pnpm", "start"]
