#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then echo 'Usage: local-staging.sh <up|down>' >&2; exit 2; fi
case "$1" in up|down) ;; *) echo 'Usage: local-staging.sh <up|down>' >&2; exit 2;; esac
requested_tag=${IMAGE_TAG-}
unset IMAGE_TAG POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL MIGRATION_DATABASE_URL BOOTSTRAP_DATABASE_URL MIGRATION_PASSWORD APPLICATION_PASSWORD SERVER_EPOCH AUTH_ALLOWED_ORIGINS PRODUCTION_HOST STAGING_HOST DEPLOY_SUBNET INGRESS_SUBNET INGRESS_PREFIX TRUSTED_PROXY_CIDRS LOCAL_DRIVER_HOST COMPOSE_PROFILES COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES
DEPLOY_PROJECT=staging; export DEPLOY_PROJECT
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
DEPLOY_ROOT=${DEPLOY_ROOT:-${HOME:?HOME is required}/traslado-staging}
export DEPLOY_ROOT
state=$DEPLOY_ROOT/staging
envfile=$state/.env
if [ -f "$envfile" ]; then
  project=$(sed -n 's/^DEPLOY_PROJECT=//p' "$envfile")
  [ "$project" = staging ] || { echo 'local staging only runs the staging project' >&2; exit 1; }
fi
if [ "$1" = down ] && [ ! -e "$state/local-staging-active" ]; then exit 0; fi
docker info >/dev/null 2>&1 || { echo 'Docker is not running: start Docker Desktop' >&2; exit 1; }
if [ "$1" = up ]; then
  cloudflared=$(command -v cloudflared || true)
  if [ -z "$cloudflared" ]; then
    programfiles=$(printenv 'ProgramFiles(x86)' 2>/dev/null || true)
    if [ -n "$programfiles" ] && command -v cygpath >/dev/null 2>&1; then programfiles=$(cygpath -u "$programfiles"); fi
    [ ! -f "$programfiles/cloudflared/cloudflared.exe" ] || cloudflared=$programfiles/cloudflared/cloudflared.exe
  fi
  [ -n "$cloudflared" ] || { echo 'cloudflared is required; install it or add it to PATH' >&2; exit 1; }
fi
umask 077
mkdir -p "$state"
state=$(CDPATH='' cd -- "$state" && pwd -P)
case "$state/" in "$root/"*) echo 'DEPLOY_ROOT must be outside the repository' >&2; exit 2;; esac
envfile=$state/.env
compose() { docker compose --project-name traslado-staging --env-file "$envfile" -f "$root/deploy/compose.yaml" -f "$root/deploy/local-staging.compose.yaml" "$@"; }
process_stamp() { [ -r "/proc/$1/stat" ] && awk '{print $22}' "/proc/$1/stat"; }
tunnel_alive() {
  [ -f "$state/$1.pid" ] || return 1
  read -r pid stamp < "$state/$1.pid" || return 2
  case "$pid:$stamp" in *[!0-9:]*|:*|*:) return 2;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  current=$(process_stamp "$pid") || { echo 'Cannot inspect cloudflared process' >&2; return 2; }
  [ "$current" = "$stamp" ]
}
stop_tunnel() {
  if tunnel_alive "$1"; then
    kill "$pid" 2>/dev/null || return 1
  else
    status=$?
    [ "$status" -ne 2 ] || return 1
  fi
  rm -f "$state/$1.pid" "$state/$1.log"
}
stop_all() {
  stop_tunnel office || return 1
  stop_tunnel driver || return 1
  compose down --remove-orphans >&2 || return 1
  rm -f "$state/local-staging-active" "$state/urls"
}
if [ "$1" = down ]; then stop_all; exit 0; fi
if [ -f "$state/urls" ] && tunnel_alive office && tunnel_alive driver &&
   compose exec -T api node -e 'fetch("http://127.0.0.1:3000/health",{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
  cat "$state/urls"; exit 0
fi
if [ -f "$state/local-staging-active" ]; then stop_all; fi
if [ ! -f "$state/local-staging-owned" ]; then
  [ ! -f "$envfile" ] || { echo 'Existing staging env is not owned by local staging' >&2; exit 1; }
  volumes=$(docker volume ls --format '{{.Name}}') || { echo 'Cannot inspect Docker volumes' >&2; exit 1; }
  containers=$(docker ps -aq --filter label=com.docker.compose.project=traslado-staging) || { echo 'Cannot inspect staging containers' >&2; exit 1; }
  networks=$(docker network ls --format '{{.Name}}') || { echo 'Cannot inspect Docker networks' >&2; exit 1; }
  if printf '%s\n' "$volumes" | grep -Fxq traslado-staging_database ||
     [ -n "$containers" ] || printf '%s\n' "$networks" | grep -Fxq traslado-local-ingress-staging; then
    echo 'Existing staging resources are not owned by local staging' >&2; exit 1
  fi
  : > "$state/local-staging-owned"
fi
if [ ! -f "$envfile" ]; then
  postgres=$(openssl rand -hex 24); migration=$(openssl rand -hex 24); app=$(openssl rand -hex 24)
  epoch=$(openssl rand -hex 24); driver_password=$(openssl rand -hex 12)
  tag=${requested_tag:-$(git -C "$root" rev-parse origin/main)}
  case "$tag" in ''|*[!a-zA-Z0-9_.-]*) echo 'Invalid image tag' >&2; exit 1;; esac
  cat > "$envfile.tmp" <<ENV
DEPLOY_PROJECT=staging
IMAGE_TAG=$tag
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$postgres
POSTGRES_DB=traslado
DATABASE_URL=postgresql://traslado_app:$app@db:5432/traslado
MIGRATION_DATABASE_URL=postgresql://traslado_migrator:$migration@db:5432/traslado
BOOTSTRAP_DATABASE_URL=postgresql://postgres:$postgres@db:5432/traslado
MIGRATION_PASSWORD=$migration
APPLICATION_PASSWORD=$app
SERVER_EPOCH=$epoch
AUTH_ALLOWED_ORIGINS=https://office.invalid,https://driver.invalid
PRODUCTION_HOST=production.invalid
STAGING_HOST=staging.invalid
DEPLOY_SUBNET=172.16.21.0/24
INGRESS_SUBNET=172.16.20.0/24
INGRESS_PREFIX=traslado-local-ingress
TRUSTED_PROXY_CIDRS=172.16.21.0/24,172.16.20.0/24
LOCAL_DRIVER_HOST=driver.invalid
ENV
  printf '%s\n' "$driver_password" > "$state/driver-password.tmp"
  mv "$state/driver-password.tmp" "$state/driver-password"
  mv "$envfile.tmp" "$envfile"
fi
[ -f "$state/driver-password" ] || { echo 'Missing local synthetic driver password' >&2; exit 1; }
value() {
  [ "$(grep -c "^$1=" "$envfile" || true)" = 1 ] || return 1
  sed -n "s/^$1=//p" "$envfile"
}
postgres=$(value POSTGRES_PASSWORD) || { echo 'Invalid local staging env' >&2; exit 1; }
migration=$(value MIGRATION_PASSWORD) || { echo 'Invalid local staging env' >&2; exit 1; }
app=$(value APPLICATION_PASSWORD) || { echo 'Invalid local staging env' >&2; exit 1; }
case "$postgres$migration$app" in *[!0-9a-f]*|'') echo 'Invalid local staging env' >&2; exit 1;; esac
[ "${#postgres}" -eq 48 ] && [ "${#migration}" -eq 48 ] && [ "${#app}" -eq 48 ] || { echo 'Invalid local staging env' >&2; exit 1; }
[ "$(value POSTGRES_USER)" = postgres ] && [ "$(value POSTGRES_DB)" = traslado ] &&
  [ "$(value DATABASE_URL)" = "postgresql://traslado_app:$app@db:5432/traslado" ] &&
  [ "$(value MIGRATION_DATABASE_URL)" = "postgresql://traslado_migrator:$migration@db:5432/traslado" ] &&
  [ "$(value BOOTSTRAP_DATABASE_URL)" = "postgresql://postgres:$postgres@db:5432/traslado" ] &&
  [ "$(value INGRESS_PREFIX)" = traslado-local-ingress ] &&
  [ "$(value DEPLOY_SUBNET)" = 172.16.21.0/24 ] &&
  [ "$(value INGRESS_SUBNET)" = 172.16.20.0/24 ] &&
  [ "$(value TRUSTED_PROXY_CIDRS)" = 172.16.21.0/24,172.16.20.0/24 ] || { echo 'Invalid local staging env' >&2; exit 1; }
tag=$(sed -n 's/^IMAGE_TAG=//p' "$envfile")
case "$tag" in ''|*[!a-zA-Z0-9_.-]*) echo 'Invalid image tag' >&2; exit 1;; esac
for image in api office driver; do
  docker pull "ghcr.io/gagaismotuc/traslado-$image:$tag" >&2 || { echo 'Image pull failed; see GHCR login in deploy/README.md' >&2; exit 1; }
done
docker pull ghcr.io/gagaismotuc/traslado-osrm:tucuman-260101-osrm26.4.0-r1 >&2 || { echo 'Image pull failed; see GHCR login in deploy/README.md' >&2; exit 1; }
compose --profile tools pull >&2 || { echo 'Compose image pull failed' >&2; exit 1; }
if ! docker network inspect traslado-local-ingress-staging >/dev/null 2>&1; then
  docker network create --subnet 172.16.20.0/24 traslado-local-ingress-staging >&2
fi
: > "$state/local-staging-active"
cleanup() { code=$?; trap - EXIT; if [ "$code" -ne 0 ]; then stop_all || echo 'Cleanup failed; run down' >&2; fi; exit "$code"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
compose up -d --no-deps --pull never gateway >&2
start_tunnel() {
  "$cloudflared" tunnel --url http://127.0.0.1:18780 > "$state/$1.log" 2>&1 &
  pid=$!
  stamp=$(process_stamp "$pid" || true)
  [ -n "$stamp" ] || { kill "$pid" 2>/dev/null || true; echo 'Cannot identify cloudflared process' >&2; return 1; }
  printf '%s %s\n' "$pid" "$stamp" > "$state/$1.pid"
  count=0
  while [ "$count" -lt 60 ]; do
    url=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$state/$1.log" | head -n 1 || true)
    [ -z "$url" ] || { printf '%s' "$url"; return 0; }
    tunnel_alive "$1" || { echo 'cloudflared exited before reporting a URL' >&2; return 1; }
    count=$((count + 1)); sleep 1
  done
  echo 'Timed out waiting for cloudflared' >&2; return 1
}
office=$(start_tunnel office)
driver=$(start_tunnel driver)
[ "$office" != "$driver" ] || { echo 'Tunnel URLs must be distinct' >&2; exit 1; }
driver_host=${driver#https://}
sed -e "s|^AUTH_ALLOWED_ORIGINS=.*|AUTH_ALLOWED_ORIGINS=$office,$driver|" -e "s|^LOCAL_DRIVER_HOST=.*|LOCAL_DRIVER_HOST=$driver_host|" "$envfile" > "$envfile.tmp"
mv "$envfile.tmp" "$envfile"
compose up -d --no-deps --pull never gateway >&2
compose up -d --wait --pull never db >&2
compose run --rm --no-deps bootstrap >&2
compose run --rm --no-deps migrate >&2
sh "$root/deploy/seed-staging.sh" >&2
SYNTHETIC_PASSWORD=$(cat "$state/driver-password"); export SYNTHETIC_PASSWORD
hash=$(compose run --rm --no-deps -e SYNTHETIC_PASSWORD api node -e 'const {argon2,randomBytes}=require("node:crypto");const salt=randomBytes(16);argon2("argon2id",{message:process.env.SYNTHETIC_PASSWORD,nonce:salt,parallelism:1,tagLength:32,memory:65536,passes:3},(err,hash)=>{if(err)throw err;console.log(`$app$argon2id$m=65536,t=3,p=1$${salt.toString("base64url")}$${hash.toString("base64url")}`)})')
unset SYNTHETIC_PASSWORD
compose exec -T db psql -v ON_ERROR_STOP=1 -v "hash=$hash" -U postgres traslado >&2 <<'SQL'
INSERT INTO users (username, password_hash, role) VALUES ('synthetic-driver', :'hash', 'driver') ON CONFLICT (username) DO NOTHING;
INSERT INTO drivers (user_id, name, home_address, home_latitude, home_longitude)
SELECT id, 'Synthetic Driver 001', 'Synthetic address 002', -26.8241, -65.2036
FROM users WHERE username = 'synthetic-driver' AND role = 'driver'
ON CONFLICT (user_id) DO NOTHING;
SQL
compose up -d --pull never >&2
attempt=0
until compose exec -T api node -e 'fetch("http://127.0.0.1:3000/health",{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; do
  tunnel_alive office && tunnel_alive driver || { echo 'A cloudflared tunnel exited' >&2; exit 1; }
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo 'Staging API health check timed out' >&2; exit 1; }
  sleep 2
done
tunnel_alive office && tunnel_alive driver || { echo 'A cloudflared tunnel exited' >&2; exit 1; }
printf 'office: %s\ndriver: %s\n' "$office" "$driver" > "$state/urls"
cat "$state/urls"
trap - EXIT HUP INT TERM
