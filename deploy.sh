#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

root="${BOORAN_ROOT:-/var/www/booran}"
backend_repo="$root/repositories/booran-sales-floor-backend"
web_repo="$root/repositories/booran-sales-floor"
export BOORAN_ROOT="$root"

for command in git node npm pm2 curl flock; do
  command -v "$command" >/dev/null || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }
done
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 ]] || { echo 'Node.js 22 is required.' >&2; exit 1; }
[[ -s "$root/shared/backend.env" ]] || { echo 'Create shared/backend.env before deploying.' >&2; exit 1; }
mkdir -p "$root/releases" "$root/shared/logs" "$root/shared/media"
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Another Booran deployment is already running.' >&2; exit 1; }

revision() {
  local repo="$1"
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null
  if [[ "${BOORAN_FETCH:-true}" == true ]]; then
    git -C "$repo" fetch --quiet origin refs/heads/main
    git -C "$repo" rev-parse 'FETCH_HEAD^{commit}'
  else
    git -C "$repo" rev-parse 'refs/heads/main^{commit}'
  fi
}

backend_sha="$(revision "$backend_repo")"
web_sha="$(revision "$web_repo")"
release="$(mktemp -d "$root/releases/$(date -u +%Y%m%dT%H%M%SZ)-${backend_sha:0:8}-${web_sha:0:8}-XXXX")"
mkdir "$release/backend" "$release/web"
git -C "$backend_repo" archive "$backend_sha" | tar -xf - -C "$release/backend"
git -C "$web_repo" archive "$web_sha" | tar -xf - -C "$release/web"
ln -s "$root/shared/backend.env" "$release/backend/.env"

echo "Building Booran backend $backend_sha and web $web_sha"
(
  cd "$release/backend"
  npm ci --omit=dev --no-audit --no-fund
  npm run check
)
(
  cd "$release/web"
  npm ci --include=dev --no-audit --no-fund
  export NEXT_TELEMETRY_DISABLED=1
  export NODE_OPTIONS="${BOORAN_BUILD_NODE_OPTIONS:---max-old-space-size=2048}"
  nice -n 10 npm run build
  test -f .next/standalone/server.js
)
(
  cd "$release/backend"
  npm run init:state
)

point_current() {
  local link="$root/.current.$$"
  ln -s "$1" "$link"
  mv -Tf "$link" "$root/current"
}

health() {
  local api='http://127.0.0.1:4103/api'
  local web='http://127.0.0.1:4101'
  for _ in {1..30}; do
    if curl -fsS --max-time 8 "$api/health" >/dev/null 2>&1 &&
      curl -fsS --max-time 8 "$web/" >/dev/null 2>&1 &&
      curl -fsS --max-time 8 "$web/manifest.webmanifest" >/dev/null 2>&1 &&
      curl -fsS --max-time 8 "$web/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo 'Booran health checks failed.' >&2
  return 1
}

reload() {
  pm2 startOrReload "$root/current/backend/deploy/ecosystem.config.js" --update-env
}

if [[ -e "$root/current" && ! -L "$root/current" ]]; then
  echo 'Expected current to be a release symlink.' >&2
  exit 1
fi
previous="$(readlink "$root/current" || true)"
point_current "$release"
if ! reload || ! health; then
  if [[ -n "$previous" ]]; then
    echo 'Rolling back to the previous Booran release.' >&2
    point_current "$previous"
    reload
    health
  else
    pm2 delete booran-sales-floor booran-sales-floor-backend || true
    unlink "$root/current"
  fi
  exit 1
fi

pm2 save
printf 'backend=%s\nweb=%s\n' "$backend_sha" "$web_sha" > "$release/revisions"
printf 'Booran is healthy on loopback. Release %s\n' "$release"
