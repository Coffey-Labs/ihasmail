# ---- build stage ----
FROM node:22-alpine AS build
# What this build calls itself: 2.16.<PR>, worked out by whoever runs the
# build. It cannot be worked out in here -- .dockerignore keeps .git out of the
# context on purpose, and git is not installed either. `node scripts/version.mjs`
# in a checkout prints the right answer; ihasmail-deploy.sh passes it through.
# Left empty, the build falls back to the base version from package.json.
ARG IHASMAIL_VERSION=""
ENV IHASMAIL_VERSION=$IHASMAIL_VERSION
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
# Re-declared: an ARG does not cross stages.
ARG IHASMAIL_VERSION=""
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/web/dist \
    SESSION_FILE=/data/sessions.json \
    IHASMAIL_VERSION=$IHASMAIL_VERSION
WORKDIR /app
COPY package.json ./
COPY server/package.json server/
# config.ts reads the version through this at startup. With IHASMAIL_VERSION
# set it never looks further; without it, it falls back to package.json rather
# than failing, since there is no git in here to ask.
COPY scripts/ ./scripts/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server/dist/index.js"]
