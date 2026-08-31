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
#   --dry-run     checks the hold list, says what it would deploy, and stops
#                 before building or touching the container. It does not ask
#                 for confirmation: there is nothing to agree to when nothing
#                 changes, and needing a terminal would make it useless over
#                 SSH -- which is where wanting to look before leaping is most
#                 likely.
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
# Named volume for /data (sessions). Unused when running immutably.
VOLUME="${IHASMAIL_VOLUME:-ihasmail-data}"
# Run the container immutably: read-only root filesystem, no volume, sessions
# held in memory only. See "Running immutably" in the README. The server is told
# the same thing through IMMUTABLE=1 and checks it, so a half-applied switch --
# the flag without the read-only filesystem, or a SESSION_FILE still pointing
# somewhere -- refuses to start here instead of looking fine until the next
# redeploy signs everyone out.
#
# It defaults to on, and the reason is what happens when it does not. Forgetting
# the variable used to hand back a writable container with a volume mounted --
# quietly, and then report healthy. Nothing in the output said the immutability
# had gone; `docker inspect` was the only place it showed. So the safe posture
# is what you get by default, and giving it up is the half that has to be
# deliberate, which is the way round these two should always have been.
#
# The standing cost is that sessions do not outlive a deploy, because there is
# nowhere left to keep them. Going back is this variable and nothing else:
#
#   IHASMAIL_IMMUTABLE=0 ./ihasmail-deploy.sh --yes
#
# The named volume is never touched either way, so whatever was in it when the
# switch was thrown is still there to come back to.
IMMUTABLE="${IHASMAIL_IMMUTABLE:-1}"
# Image repository. Each build is tagged with its version as well, so an
# earlier one can be run again without rebuilding it.
IMAGE_REPO="${IHASMAIL_IMAGE:-ihasmail}"
# How long to wait for the new container to report healthy, in seconds.
HEALTH_TIMEOUT="${IHASMAIL_HEALTH_TIMEOUT:-30}"
# How many past versions to keep as images, for rolling back to. Each is around
# 650 MB, and a deploy adds one, so left alone they accumulate a gigabyte every
# couple of releases -- and `docker image prune` will not touch them, because
# they are tagged. 0 keeps every version.
KEEP_VERSIONS="${IHASMAIL_KEEP_VERSIONS:-3}"

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
    -h|--help) awk 'NR > 1 { if (/^#/) print; else exit }' "$0"; exit 0 ;;
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
else
  echo "==> already at $(git log --oneline -1 "$TARGET"); rebuilding"
fi

# A dry run has now said everything it has to say, so it stops here -- before
# the confirmation rather than after it. Asking whether to go ahead with
# something that is not going to happen is noise at a terminal; over SSH it was
# worse, because the refusal came out *instead of* the report above and a dry
# run could not be used from another machine at all. Which is the machine you
# are most likely to be on when you want one.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> dry run: would deploy $(git log --oneline -1 "$TARGET"); nothing was changed"
  exit 0
fi

if [ -n "$NEW" ] && [ "$ASSUME_YES" -ne 1 ]; then
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

git reset --hard --quiet "$TARGET"

# The version is worked out here, from the checkout, because the image build
# cannot: .dockerignore keeps .git out of the build context. Without this the
# build falls back to the base version in package.json and every deployment
# reports the same number -- see "Version numbers" in the README.
# Drop the oldest versioned images, keeping the newest KEEP_VERSIONS of them.
#
# Only ever runs after the new container reports healthy, so a rollback target
# is never removed while the thing replacing it is still unproven. The image in
# use is excluded outright rather than relied on to sort newest -- docker
# refuses to remove an image a container is using, but being refused is not the
# same as not having tried.
prune_old_images() {
  [ "$KEEP_VERSIONS" -gt 0 ] || return 0
  local in_use stale
  in_use="$(docker inspect "$NAME" --format '{{.Config.Image}}' 2>/dev/null || true)"
  # Newest first, tags only, skipping the moving ":current" pointer.
  stale="$(docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' \
    | grep -v ":current" \
    | sort -k2 -r \
    | cut -f1 \
    | grep -vxF "$in_use" \
    | tail -n +"$((KEEP_VERSIONS + 1))")"
  [ -n "$stale" ] || return 0
  echo "==> removing $(printf '%s\n' "$stale" | wc -l) old image(s), keeping the newest $KEEP_VERSIONS"
  printf '%s\n' "$stale" | xargs -r docker rmi >/dev/null 2>&1 || true
}

VERSION="$(node scripts/version.mjs)"
# A Docker tag may not contain "+", and every version has one now:
# 2026.8.30+pr129, or +g1fa6578 for a commit that did not come through a pull
# request. The image is tagged with the "+" turned into "-"; what the build is
# *told* it is keeps the real form, so About and /api/health still report it
# correctly.
TAG="${VERSION//+/-}"
echo "==> building $(git log --oneline -1) as v$VERSION"
docker build \
  --build-arg IHASMAIL_VERSION="$VERSION" \
  -t "$IMAGE_REPO:$TAG" \
  -t "$IMAGE_REPO:current" \
  .

RUN_ARGS=(-d --name "$NAME" --restart unless-stopped -p "$BIND:8080" --env-file "$ENVF")
if [ "$IMMUTABLE" = "1" ]; then
  # -e wins over --env-file, so this clears a SESSION_FILE set there or baked
  # into the image, rather than needing the environment file edited to match.
  RUN_ARGS+=(--read-only --tmpfs /tmp -e IMMUTABLE=1 -e SESSION_FILE=)
  echo "==> restarting container -- immutable: read-only, no volume, sessions in memory"
  echo "    (everyone signed in is signed out; IHASMAIL_IMMUTABLE=0 puts it back)"
else
  RUN_ARGS+=(-v "$VOLUME:/data")
  echo "==> restarting container"
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run "${RUN_ARGS[@]}" "$IMAGE_REPO:$TAG" >/dev/null

for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if health=$(curl -sf "http://$BIND/api/health"); then
    echo "==> healthy: $health"
    prune_old_images
    exit 0
  fi
  sleep 1
done

echo "!! did not become healthy after ${HEALTH_TIMEOUT}s; logs:" >&2
docker logs "$NAME" 2>&1 | tail -20 >&2
echo "!! the previous image is still tagged, if you need it back:" >&2
docker images "$IMAGE_REPO" --format '   {{.Repository}}:{{.Tag}}  {{.CreatedSince}}' | head -5 >&2
exit 1
