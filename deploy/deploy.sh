#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then echo 'Usage: deploy.sh <tag> <production|staging>' >&2; exit 2; fi
tag=$1
project=$2
case "$tag" in ''|*[!a-zA-Z0-9_.-]*) echo 'Invalid image tag' >&2; exit 2;; esac
case "$project" in production|staging) ;; *) echo 'Invalid project' >&2; exit 2;; esac
DEPLOY_PROJECT=$project; export DEPLOY_PROJECT
: "${DEPLOY_ROOT:?DEPLOY_ROOT must point outside the repository}"
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
state=$(CDPATH='' cd -- "$DEPLOY_ROOT/$project" && pwd -P)
case "$state/" in "$root/"*) echo 'DEPLOY_ROOT must be outside the repository' >&2; exit 2;; esac
envfile=$state/.env
[ -f "$envfile" ] || { echo 'Missing project env file' >&2; exit 2; }
umask 077
exec 9>"$state/deploy.lock"
flock -n 9 || { echo 'A deployment is already running' >&2; exit 1; }
compose() { docker compose --project-name "traslado-$project" --env-file "$envfile" -f "$root/deploy/compose.yaml" "$@"; }
health() { compose exec -T api node -e 'fetch("http://127.0.0.1:3000/health",{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; }
wait_health() {
  count=0
  while [ "$count" -lt 30 ]; do
    health && return 0
    count=$((count + 1)); sleep 2
  done
  return 1
}
previous=''
[ ! -f "$state/deployed-tag" ] || previous=$(cat "$state/deployed-tag")
if [ -f "$state/deploy-pending" ]; then
  [ -n "$previous" ] || { echo 'Interrupted first deployment requires manual recovery' >&2; exit 1; }
  IMAGE_TAG=$previous; export IMAGE_TAG
  compose up -d
  wait_health || { echo 'Recovery health check failed' >&2; exit 1; }
  rm -f "$state/deploy-pending"
fi
if [ "$tag" = "$previous" ]; then
  IMAGE_TAG=$tag; export IMAGE_TAG
  health
  exit $?
fi
IMAGE_TAG=$tag; export IMAGE_TAG
compose pull
mkdir -p "$state/dumps"
dump="$state/dumps/$(date -u +%Y%m%dT%H%M%SZ)-$$.sql"
if ! compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$dump"; then
  rm -f "$dump"
  echo 'Database dump failed; deployment stopped' >&2
  exit 1
fi
printf '%s\n' "$tag" > "$state/deploy-pending"
compose run --rm --no-deps migrate
if compose up -d && wait_health; then
  printf '%s\n' "$tag" > "$state/deployed-tag.tmp"
  mv "$state/deployed-tag.tmp" "$state/deployed-tag"
  rm -f "$state/deploy-pending"
  echo "Deployed $tag"
  exit 0
fi
echo 'Health check failed; restoring previous image without reverting schema' >&2
if [ -n "$previous" ]; then
  IMAGE_TAG=$previous; export IMAGE_TAG
  if compose up -d && wait_health; then rm -f "$state/deploy-pending"; else echo 'Rollback health check failed' >&2; fi
fi
exit 1
