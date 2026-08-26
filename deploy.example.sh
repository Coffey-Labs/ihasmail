#!/bin/bash
# Redeploy ihasmail on a single-host Docker setup, from a git checkout.
#
# Copy it, or run it as-is and set the variables below in the environment.
# Nothing here is specific to any one host: the defaults describe the shape of
# a deployment rather than anyone's particular one.
#
# Usage: ./deploy.sh [git-ref] [-y|--yes] [-n|--dry-run]
#
# Three guards stand between a careless run and production:
#
#   .deploy-hold  commits that must not reach prod yet, one per line. If the
#                 target contains one that is not already deployed, the deploy
#                 is refused outright -- `--yes` does not override it. Clearing
#                 a hold means deleting its line, which is a deliberate edit.
#
#   confirmation  anything introducing new commits is listed first and has to
#                 be confirmed. Over SSH, where there is no terminal to answer
#                 on, that means passing --yes: a bare `deploy.sh` cannot ship
#                 whatever main happens to have picked up since the last
#                 release.
#
#   --dry-run     runs both guards, says what it would deploy, and stops before
#                 building or touching the container.
#
# The container is replaced rather than restarted, because the image is rebuilt
# from the new checkout. Data lives in a named volume and survives that; the
# environment file is never read here, only handed to Docker.
set -euo pipefail

# --- what to deploy, and where ----------------------------------------------
# The checkout to deploy from. It must be a git clone: the version number is
# read from its history (see scripts/version.mjs).
APP="${IHASMAIL_APP:-$HOME/apps/ihasmail}"
# Environment file passed to the container. Keep it outside the repo's tracked
# files -- it holds APP_SECRET and the upstream URL. Never read by this script.
ENVF="${IHASMAIL_ENV:-$APP/.env.production}"
# Commits held back from production, one per line; blank or missing is fine.
HOLD="${IHASMAIL_HOLD:-$APP/.deploy-hold}"
# Container name, and where to publish it. The default binds to loopback only,
# for a reverse proxy in front (see Caddyfile.example / nginx.example.conf).
NAME="${IHASMAIL_NAME:-ihasmail}"
BIND="${IHASMAIL_BIND:-127.0.0.1:8090}"
# Named volume for /data (sessions).
VOLUME="${IHASMAIL_VOLUME:-ihasmail-data}"
# Image repository. Each build is tagged with its version as well, so an
# earlier one can be run again without rebuilding it.
IMAGE_REPO="${IHASMAIL_IMAGE:-ihasmail}"
# How long to wait for the new container to report healthy, in seconds.
HEALTH_TIMEOUT="${IHASMAIL_HEALTH_TIMEOUT:-30}"

# --- run from a copy, if this script lives in the checkout it resets ---------
# `git reset --hard` below rewrites the working tree, and this script may be
# part of it. Bash does not read a script all at once -- it reads as it goes,
# by byte offset -- so a file replaced underneath it makes the shell stop
# wherever it had reached. Silently, and with exit status 0: a deploy that
# stopped halfway would report success. Re-exec from a copy outside the tree so
# the file being run cannot change while it runs.
SELF="$(readlink -f "$0")"
APP_REAL="$(readlink -f "$APP" 2>/dev/null || printf '%s' "$APP")"
if [ -z "${IHASMAIL_REEXEC:-}" ] && [ "${SELF#"$APP_REAL"/}" != "$SELF" ]; then
  COPY="$(mktemp "${TMPDIR:-/tmp}/ihasmail-deploy.XXXXXX")"
  cat "$SELF" > "$COPY"
  chmod +x "$COPY"
  IHASMAIL_REEXEC=1 exec "$COPY" "$@"
fi
# The copy has served its purpose once we exit; the shell has finished reading
# it by then.
if [ -n "${IHASMAIL_REEXEC:-}" ]; then
  trap 'rm -f "$SELF"' EXIT
fi

REF=""
ASSUME_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *)
      if [ -n "$REF" ]; then echo "give at most one git-ref (got '$REF' and '$arg')" >&2; exit 2; fi
      REF="$arg" ;;
  esac
done
REF="${REF:-origin/main}"

cd "$APP"
git fetch --quiet origin

if ! TARGET=$(git rev-parse --verify --quiet "${REF}^{commit}"); then
  echo "!! no such commit: $REF" >&2
  exit 2
fi
CURRENT=$(git rev-parse --verify HEAD)

# --- guard 1: commits held back from production -----------------------------
if [ -f "$HOLD" ]; then
  blocked=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -z "$line" ] && continue
    if ! held=$(git rev-parse --verify --quiet "${line}^{commit}"); then
      echo "   (hold list names '$line', which this checkout does not know -- ignoring)" >&2
      continue
    fi
    # Only a problem if the target carries it and production does not already.
    if git merge-base --is-ancestor "$held" "$TARGET" && ! git merge-base --is-ancestor "$held" "$CURRENT"; then
      blocked="${blocked}      $(git log --oneline -1 "$held")"$'\n'
    fi
  done < "$HOLD"
  if [ -n "$blocked" ]; then
    echo "!! refusing to deploy $REF: it contains commits held back from production:" >&2
    printf '%s' "$blocked" >&2
    echo "   listed in $HOLD -- delete the line to clear the hold, or deploy a ref without it." >&2
    exit 1
  fi
fi

# --- guard 2: say what is being introduced, and get a yes --------------------
NEW=$(git log --oneline "$CURRENT..$TARGET")
if [ -n "$NEW" ]; then
  echo "==> $(git log --oneline -1 "$CURRENT") -> $(git log --oneline -1 "$TARGET")"
  echo "==> introduces:"
  printf '%s\n' "$NEW" | sed 's/^/      /'
  if [ "$ASSUME_YES" -ne 1 ]; then
    if [ -t 0 ]; then
      read -r -p "deploy these to production? [y/N] " reply
      case "$reply" in
        y|Y|yes|YES) ;;
        *) echo "aborted."; exit 1 ;;
      esac
    else
      echo "!! refusing: this introduces new commits and there is no terminal to confirm on." >&2
      echo "   re-run with --yes if that is what you mean, or name the ref you want." >&2
      exit 1
    fi
  fi
else
  echo "==> already at $(git log --oneline -1 "$TARGET"); rebuilding"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> dry run: would deploy $(git log --oneline -1 "$TARGET"); nothing was changed"
  exit 0
fi

git reset --hard --quiet "$TARGET"

# The version is worked out here, from the checkout, because the image build
# cannot: .dockerignore keeps .git out of the build context. Without this the
# build falls back to the base version in package.json and every deployment
# reports the same number -- see "Version numbers" in the README.
VERSION="$(node scripts/version.mjs)"
# A Docker tag may not contain "+", which a version for a commit that did not
# come through a pull request does: 2.16.57+g1fa6578. The image is tagged with
# the "+" turned into "-"; what the build is *told* it is keeps the real form,
# so About and /api/health still report it correctly.
TAG="${VERSION//+/-}"
echo "==> building $(git log --oneline -1) as v$VERSION"
docker build \
  --build-arg IHASMAIL_VERSION="$VERSION" \
  -t "$IMAGE_REPO:$TAG" \
  -t "$IMAGE_REPO:current" \
  .

echo "==> restarting container"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  -p "$BIND:8080" --env-file "$ENVF" -v "$VOLUME:/data" "$IMAGE_REPO:$TAG" >/dev/null

for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if health=$(curl -sf "http://$BIND/api/health"); then
    echo "==> healthy: $health"
    exit 0
  fi
  sleep 1
done

echo "!! did not become healthy after ${HEALTH_TIMEOUT}s; logs:" >&2
docker logs "$NAME" 2>&1 | tail -20 >&2
echo "!! the previous image is still tagged, if you need it back:" >&2
docker images "$IMAGE_REPO" --format '   {{.Repository}}:{{.Tag}}  {{.CreatedSince}}' | head -5 >&2
exit 1
