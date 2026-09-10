# ---- build stage ----
FROM node:26-alpine AS build
# What this build calls itself: 2.16.<PR>, worked out by whoever runs the
# build. It cannot be worked out in here -- .dockerignore keeps .git out of the
# context on purpose, and git is not installed either. `node scripts/version.mjs`
# in a checkout prints the right answer; ihasmail-deploy.sh passes it through.
# Left empty, the build falls back to the base version from package.json.
ARG IHASMAIL_VERSION=""
ENV IHASMAIL_VERSION=$IHASMAIL_VERSION
# The subpath the app will be served from, e.g. /mail. Empty -- the default --
# is the domain root and is what every deployment gets unless it asks
# otherwise. Unlike the rest of ihasmail's configuration this cannot wait for
# the process to start: the web build writes its own asset URLs into
# index.html, so a build that does not know the prefix produces a shell that
# cannot load itself under one. It is therefore a build argument here and an
# environment variable in the runtime stage, from the same value.
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:26-alpine AS runtime
# Re-declared: an ARG does not cross stages.
ARG IHASMAIL_VERSION=""
ARG BASE_PATH=""
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/web/dist \
    SESSION_FILE=/data/sessions.json \
    IHASMAIL_VERSION=$IHASMAIL_VERSION \
    BASE_PATH=$BASE_PATH
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
# config.ts reads the version through this at startup. With IHASMAIL_VERSION
# set it never looks further; without it, it falls back to package.json rather
# than failing, since there is no git in here to ask.
COPY scripts/ ./scripts/
# Only what the server loads at runtime: hono and its Node adapter, about 4 MB.
# The build stage's tree is 132 MB of vite, TypeScript, esbuild and React that
# never executes here but shipped anyway -- and showed up in every CVE scan.
RUN npm ci --ignore-scripts --omit=dev --workspace server \
    && rm -rf /root/.npm /tmp/*
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
# /data is the only path the process may write. /app stays root-owned and
# read-only to the runtime user on purpose; the previous `chown -R /app`
# re-wrote every file and, on overlayfs, duplicated the whole tree into a
# second 173 MB layer.
RUN mkdir -p /data && chown node:node /data \
    # The base image ships a package manager the server never calls. Anyone who
    # gets code execution should not find one waiting for them.
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
              /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
# No `VOLUME ["/data"]`. It reads like documentation for where the session file
# goes, but Docker acts on it: a container started without `-v` gets an
# anonymous volume mounted there anyway, and that mount stays writable even
# under `--read-only`. So the directive quietly put a writable hole in a
# container meant to be immutable, and left an orphaned volume behind every
# time one was replaced -- while never persisting anything across a redeploy,
# since each new container got a fresh empty volume of its own. Deployments
# that want the sessions to survive say so themselves: docker-compose.yml and
# deploy.example.sh both mount a *named* volume at /data, which is unaffected.
EXPOSE 8080
# Shell form, so $BASE_PATH is expanded by the container rather than baked in
# empty at build time: the health endpoint moves with the mount.
#
# The two substitutions repeat, in sh, what scripts/basePath.mjs does in
# JavaScript -- drop a trailing slash, add a leading one -- because this runs
# before there is a Node process to ask. It is worth the duplication: an
# operator who writes BASE_PATH=mail/ gets a working server, and without this
# a healthcheck that says the working server is unhealthy and has Docker
# restart it forever.
HEALTHCHECK --interval=30s --timeout=5s CMD BP="${BASE_PATH%/}"; case "$BP" in ""|/*) ;; *) BP="/$BP";; esac; wget -qO- "http://127.0.0.1:8080$BP/api/health" || exit 1
CMD ["node", "server/dist/index.js"]
