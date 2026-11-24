#!/bin/sh
set -eu

# One engine for the two local environments of ADR 0003: local staging and the Prueba de campo (issue #146), which
# keeps real Posiciones. deploy/prueba-de-campo.sh sources this file, so the project comes from the entry script that
# was run, never from the environment.
case "$0" in prueba-de-campo.sh|*/prueba-de-campo.sh|*\\prueba-de-campo.sh) entry=prueba-de-campo;; *) entry=staging;; esac
if [ "$entry" = prueba-de-campo ]; then
  name=prueba-de-campo; label='Prueba de campo'; title='Prueba de campo'; port=18790
  deploy_subnet=172.16.31.0/24; ingress_subnet=172.16.30.0/24
  case "$*" in up|down|borrar|'borrar --confirmar') ;; *) echo 'Usage: prueba-de-campo.sh <up|down|borrar [--confirmar]>' >&2; exit 2;; esac
else
  name=staging; label='local staging'; title='Staging'; port=18780
  deploy_subnet=172.16.21.0/24; ingress_subnet=172.16.20.0/24
  if [ "$#" -ne 1 ]; then echo 'Usage: local-staging.sh <up|down>' >&2; exit 2; fi
  case "$1" in up|down) ;; *) echo 'Usage: local-staging.sh <up|down>' >&2; exit 2;; esac
fi
action=$1
requested_tag=${IMAGE_TAG-}
unset IMAGE_TAG POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL MIGRATION_DATABASE_URL BOOTSTRAP_DATABASE_URL BOOTSTRAP_OFFICE_PASSWORD MIGRATION_PASSWORD APPLICATION_PASSWORD SERVER_EPOCH AUTH_ALLOWED_ORIGINS PRODUCTION_HOST STAGING_HOST DEPLOY_SUBNET INGRESS_SUBNET INGRESS_PREFIX TRUSTED_PROXY_CIDRS LOCAL_DRIVER_HOST LOCAL_GATEWAY_PORT COMPOSE_PROFILES COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES
DEPLOY_PROJECT=$name; export DEPLOY_PROJECT
LOCAL_GATEWAY_PORT=$port; export LOCAL_GATEWAY_PORT
compose_project=traslado-$name
volume=${compose_project}_database
ingress_network=traslado-local-ingress-$name
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
DEPLOY_ROOT=${DEPLOY_ROOT:-${HOME:?HOME is required}/traslado-staging}
export DEPLOY_ROOT
state=$DEPLOY_ROOT/$name
envfile=$state/.env
if [ "$name" != staging ]; then
  # Never act on staging's directory through a link, even when borrar is pointed at it.
  [ ! -L "$state" ] || { echo "$state is a link; the Prueba de campo only uses its own directory" >&2; exit 1; }
  if [ -d "$state" ] && [ -d "$DEPLOY_ROOT/staging" ] &&
     [ "$(CDPATH='' cd -- "$state" && pwd -P)" = "$(CDPATH='' cd -- "$DEPLOY_ROOT/staging" && pwd -P)" ]; then
    echo "$state is the staging directory; the Prueba de campo only uses its own directory" >&2; exit 1
  fi
fi
if [ -f "$envfile" ]; then
  project=$(sed -n 's/^DEPLOY_PROJECT=//p' "$envfile")
  [ "$project" = "$name" ] || { echo "$label only runs the $name project" >&2; exit 1; }
fi
remind() {
  [ "$name" = staging ] || echo 'The Prueba de campo database keeps real Posiciones: when the test ends, run sh deploy/prueba-de-campo.sh borrar --confirmar'
}
if [ "$action" = down ] && [ ! -e "$state/local-staging-active" ]; then remind; exit 0; fi
docker info >/dev/null 2>&1 || { echo 'Docker is not running: start Docker Desktop' >&2; exit 1; }
if [ "$action" = up ]; then
  cloudflared=$(command -v cloudflared || true)
  if [ -z "$cloudflared" ]; then
    programfiles=$(printenv 'ProgramFiles(x86)' 2>/dev/null || true)
    if [ -n "$programfiles" ] && command -v cygpath >/dev/null 2>&1; then programfiles=$(cygpath -u "$programfiles"); fi
    [ ! -f "$programfiles/cloudflared/cloudflared.exe" ] || cloudflared=$programfiles/cloudflared/cloudflared.exe
  fi
  [ -n "$cloudflared" ] || { echo 'cloudflared is required; install it or add it to PATH' >&2; exit 1; }
fi
umask 077
[ "$action" = borrar ] || mkdir -p "$state"
if [ -d "$state" ]; then
  state=$(CDPATH='' cd -- "$state" && pwd -P)
  case "$state/" in "$root/"*) echo 'DEPLOY_ROOT must be outside the repository' >&2; exit 2;; esac
fi
envfile=$state/.env
compose() { docker compose --project-name "$compose_project" --env-file "$envfile" -f "$root/deploy/compose.yaml" -f "$root/deploy/local-staging.compose.yaml" "$@"; }
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
if [ "$action" = down ]; then stop_all; remind; exit 0; fi
# What the Prueba de campo leaves on this PC, one item per line; fails when Docker cannot be read.
leftovers() {
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$compose_project") || return 1
  volumes=$(docker volume ls --format '{{.Name}}') || return 1
  networks=$(docker network ls --format '{{.Name}}') || return 1
  if [ -n "$ids" ]; then echo "containers of $compose_project:" $ids; fi
  if printf '%s\n' "$volumes" | grep -Fxq "$volume"; then echo "database volume $volume"; fi
  for network in "${compose_project}_default" "$ingress_network"; do
    if printf '%s\n' "$networks" | grep -Fxq "$network"; then echo "network $network"; fi
  done
  for tunnel in office driver; do
    if [ -e "$state/$tunnel.pid" ]; then echo "cloudflared $tunnel tunnel"; fi
  done
  if [ -e "$state" ]; then echo "state directory $state"; fi
}
if [ "$action" = borrar ]; then
  found=$(leftovers) || { echo 'Cannot inspect the Prueba de campo in Docker; nothing was deleted' >&2; exit 1; }
  if [ -z "$found" ]; then echo 'Nothing to delete: the Prueba de campo is already deleted'; exit 0; fi
  if [ "$#" -eq 1 ]; then
    echo 'borrar --confirmar would delete:'
    printf '%s\n' "$found" | sed 's/^/  /'
    echo 'Nothing was deleted. To delete it, run: sh deploy/prueba-de-campo.sh borrar --confirmar'
    exit 0
  fi
  failed=0
  stop_tunnel office || failed=1
  stop_tunnel driver || failed=1
  if ids=$(docker ps -aq --filter "label=com.docker.compose.project=$compose_project"); then
    if [ -n "$ids" ]; then docker rm -f $ids >/dev/null || failed=1; fi
  else
    failed=1
  fi
  if printf '%s\n' "$found" | grep -Fxq "database volume $volume"; then docker volume rm "$volume" >/dev/null || failed=1; fi
  for network in "${compose_project}_default" "$ingress_network"; do
    if printf '%s\n' "$found" | grep -Fxq "network $network"; then docker network rm "$network" >/dev/null || failed=1; fi
  done
  # The directory goes last: while anything else is left, its tunnel state and env are still needed to retry.
  if [ "$failed" -eq 0 ] && [ -e "$state" ]; then rm -rf -- "$state" || failed=1; fi
  left=$(leftovers) || { echo 'Cannot inspect the Prueba de campo in Docker to verify the deletion' >&2; exit 1; }
  if [ -n "$left" ]; then
    echo 'borrar could not delete everything; still left:' >&2
    printf '%s\n' "$left" | sed 's/^/  /' >&2
    echo 'Fix the cause and run sh deploy/prueba-de-campo.sh borrar --confirmar again' >&2
    exit 1
  fi
  echo 'Deleted:'
  printf '%s\n' "$found" | sed 's/^/  /'
  echo 'The Prueba de campo is deleted.'
  exit 0
fi
if [ ! -L "$state/office-password" ] && [ -f "$state/office-password" ] && [ -n "$(tr -d ' \t\r\n' < "$state/office-password")" ] && [ -f "$state/urls" ] && tunnel_alive office && tunnel_alive driver &&
   compose exec -T api node -e 'fetch("http://127.0.0.1:3000/health",{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
  cat "$state/urls"; exit 0
fi
if [ -f "$state/local-staging-active" ]; then stop_all; fi
if [ ! -f "$state/local-staging-owned" ]; then
  [ ! -f "$envfile" ] || { echo "Existing $name env is not owned by $label" >&2; exit 1; }
  volumes=$(docker volume ls --format '{{.Name}}') || { echo 'Cannot inspect Docker volumes' >&2; exit 1; }
  containers=$(docker ps -aq --filter "label=com.docker.compose.project=$compose_project") || { echo "Cannot inspect $name containers" >&2; exit 1; }
  networks=$(docker network ls --format '{{.Name}}') || { echo 'Cannot inspect Docker networks' >&2; exit 1; }
  if printf '%s\n' "$volumes" | grep -Fxq "$volume" ||
     [ -n "$containers" ] || printf '%s\n' "$networks" | grep -Fxq "$ingress_network"; then
    echo "Existing $name resources are not owned by $label" >&2; exit 1
  fi
  : > "$state/local-staging-owned"
fi
if [ ! -f "$envfile" ]; then
  postgres=$(openssl rand -hex 24); migration=$(openssl rand -hex 24); app=$(openssl rand -hex 24)
  epoch=$(openssl rand -hex 24); driver_password=$(openssl rand -hex 12)
  tag=${requested_tag:-$(git -C "$root" rev-parse origin/main)}
  case "$tag" in ''|*[!a-zA-Z0-9_.-]*) echo 'Invalid image tag' >&2; exit 1;; esac
  cat > "$envfile.tmp" <<ENV
DEPLOY_PROJECT=$name
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
DEPLOY_SUBNET=$deploy_subnet
INGRESS_SUBNET=$ingress_subnet
INGRESS_PREFIX=traslado-local-ingress
TRUSTED_PROXY_CIDRS=$deploy_subnet,$ingress_subnet
LOCAL_DRIVER_HOST=driver.invalid
ENV
  if [ "$name" = staging ]; then
    printf '%s\n' "$driver_password" > "$state/driver-password.tmp"
    mv "$state/driver-password.tmp" "$state/driver-password"
  fi
  mv "$envfile.tmp" "$envfile"
fi
[ "$name" != staging ] || [ -f "$state/driver-password" ] || { echo 'Missing local synthetic driver password' >&2; exit 1; }
value() {
  [ "$(grep -c "^$1=" "$envfile" || true)" = 1 ] || return 1
  sed -n "s/^$1=//p" "$envfile"
}
postgres=$(value POSTGRES_PASSWORD) || { echo "Invalid $label env" >&2; exit 1; }
migration=$(value MIGRATION_PASSWORD) || { echo "Invalid $label env" >&2; exit 1; }
app=$(value APPLICATION_PASSWORD) || { echo "Invalid $label env" >&2; exit 1; }
case "$postgres$migration$app" in *[!0-9a-f]*|'') echo "Invalid $label env" >&2; exit 1;; esac
[ "${#postgres}" -eq 48 ] && [ "${#migration}" -eq 48 ] && [ "${#app}" -eq 48 ] || { echo "Invalid $label env" >&2; exit 1; }
[ "$(value POSTGRES_USER)" = postgres ] && [ "$(value POSTGRES_DB)" = traslado ] &&
  [ "$(value DATABASE_URL)" = "postgresql://traslado_app:$app@db:5432/traslado" ] &&
  [ "$(value MIGRATION_DATABASE_URL)" = "postgresql://traslado_migrator:$migration@db:5432/traslado" ] &&
  [ "$(value BOOTSTRAP_DATABASE_URL)" = "postgresql://postgres:$postgres@db:5432/traslado" ] &&
  [ "$(value INGRESS_PREFIX)" = traslado-local-ingress ] &&
  [ "$(value DEPLOY_SUBNET)" = "$deploy_subnet" ] &&
  [ "$(value INGRESS_SUBNET)" = "$ingress_subnet" ] &&
  [ "$(value TRUSTED_PROXY_CIDRS)" = "$deploy_subnet,$ingress_subnet" ] || { echo "Invalid $label env" >&2; exit 1; }
tag=$(sed -n 's/^IMAGE_TAG=//p' "$envfile")
case "$tag" in ''|*[!a-zA-Z0-9_.-]*) echo 'Invalid image tag' >&2; exit 1;; esac
for image in api office driver; do
  docker pull "ghcr.io/gagaismotuc/traslado-$image:$tag" >&2 || { echo 'Image pull failed; see GHCR login in deploy/README.md' >&2; exit 1; }
done
docker pull ghcr.io/gagaismotuc/traslado-osrm:tucuman-260101-osrm26.4.0-r1 >&2 || { echo 'Image pull failed; see GHCR login in deploy/README.md' >&2; exit 1; }
compose --profile tools pull >&2 || { echo 'Compose image pull failed' >&2; exit 1; }
if ! docker network inspect "$ingress_network" >/dev/null 2>&1; then
  docker network create --subnet "$ingress_subnet" "$ingress_network" >&2
fi
: > "$state/local-staging-active"
cleanup() { code=$?; trap - EXIT; if [ "$code" -ne 0 ]; then stop_all || echo 'Cleanup failed; run down' >&2; fi; exit "$code"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
compose up -d --no-deps --pull never gateway >&2
start_tunnel() {
  "$cloudflared" tunnel --url "http://127.0.0.1:$port" > "$state/$1.log" 2>&1 &
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
# Only staging gets the synthetic passenger and driver; every person in the Prueba de campo comes from the demo seed.
if [ "$name" = staging ]; then
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
fi
office_password_file=$state/office-password
if [ -L "$office_password_file" ] || { [ -e "$office_password_file" ] && [ ! -f "$office_password_file" ]; }; then
  echo "Invalid $label office-password; remove $label state or run db:break-glass-office" >&2
  exit 1
fi
if [ -f "$office_password_file" ]; then
  office_password_existed=1
  BOOTSTRAP_OFFICE_PASSWORD=$(tr -d '\r\n' < "$office_password_file")
  if [ -z "$(printf '%s' "$BOOTSTRAP_OFFICE_PASSWORD" | tr -d ' \t')" ]; then
    unset BOOTSTRAP_OFFICE_PASSWORD
    echo "Empty $label office-password; remove $label state or run db:break-glass-office" >&2
    exit 1
  fi
else
  office_password_existed=0
  BOOTSTRAP_OFFICE_PASSWORD=$(openssl rand -hex 12)
fi
export BOOTSTRAP_OFFICE_PASSWORD
office_bootstrap_status=0
office_bootstrap_out=$(compose run --rm --no-deps -e BOOTSTRAP_OFFICE_PASSWORD bootstrap pnpm --filter @traslado/api db:bootstrap-office demo-oficina 2>&1) || office_bootstrap_status=$?
if [ "$office_bootstrap_status" -eq 0 ]; then
  if [ "$office_password_existed" -eq 0 ]; then
    rm -f "$office_password_file.tmp"
    printf '%s\n' "$BOOTSTRAP_OFFICE_PASSWORD" > "$office_password_file.tmp"
    chmod 600 "$office_password_file.tmp"
    mv "$office_password_file.tmp" "$office_password_file"
  fi
  unset BOOTSTRAP_OFFICE_PASSWORD
  [ -z "$office_bootstrap_out" ] || printf '%s\n' "$office_bootstrap_out" >&2
else
  unset BOOTSTRAP_OFFICE_PASSWORD
  if printf '%s\n' "$office_bootstrap_out" | grep -Fq 'An Office account already exists'; then
    if [ "$office_password_existed" -eq 1 ]; then
      printf '%s\n' "$office_bootstrap_out" >&2
    else
      echo "Office account already exists in $label, but office-password is missing; remove $label state or run db:break-glass-office" >&2
      exit 1
    fi
  else
    [ -z "$office_bootstrap_out" ] || printf '%s\n' "$office_bootstrap_out" >&2
    echo 'Office bootstrap failed' >&2
    exit 1
  fi
fi
compose up -d --pull never >&2
attempt=0
until compose exec -T api node -e 'fetch("http://127.0.0.1:3000/health",{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; do
  tunnel_alive office && tunnel_alive driver || { echo 'A cloudflared tunnel exited' >&2; exit 1; }
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "$title API health check timed out" >&2; exit 1; }
  sleep 2
done
tunnel_alive office && tunnel_alive driver || { echo 'A cloudflared tunnel exited' >&2; exit 1; }
printf 'office: %s\ndriver: %s\n' "$office" "$driver" > "$state/urls"
cat "$state/urls"
trap - EXIT HUP INT TERM
