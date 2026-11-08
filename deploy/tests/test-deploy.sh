#!/bin/sh
set -eu
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/state/production"
printf 'PLACEHOLDER=value\n' > "$root/state/production/.env"
cat > "$root/bin/docker" <<'MOCK'
#!/bin/sh
printf '%s | %s\n' "${IMAGE_TAG-}" "$*" >> "$LOG"
case "$*" in
  *' run --rm --no-deps migrate'*) [ "${FAIL_MIGRATE-}" != 1 ] || exit 1 ;;
  *pg_dump*) [ "${FAIL_DUMP-}" != 1 ] || exit 1; echo synthetic-dump ;;
  *' exec -T api node '*) [ "${IMAGE_TAG-}" != "${FAIL_TAG-unset}" ] || exit 1 ;;
esac
exit 0
MOCK
cat > "$root/bin/sleep" <<'MOCK'
#!/bin/sh
exit 0
MOCK
chmod +x "$root/bin/docker" "$root/bin/sleep"
export PATH="$root/bin:$PATH" DEPLOY_ROOT="$root/state" LOG="$root/log"
export FAIL_DUMP=1
if sh /work/deploy/deploy.sh new production; then echo 'dump failure must fail deploy' >&2; exit 1; fi
grep -q pg_dump "$LOG"
if grep -E 'run --rm --no-deps migrate| up ' "$LOG"; then echo 'dump failure must not migrate or restart' >&2; exit 1; fi
echo 'PASS: dump failure stops before migration and restart'
unset FAIL_DUMP
printf 'old\n' > "$root/state/production/deployed-tag"
export FAIL_MIGRATE=1
if sh /work/deploy/deploy.sh new production; then echo 'migration failure must fail deploy' >&2; exit 1; fi
[ -f "$root/state/production/deploy-pending" ] || { echo 'migration intent must survive interruption' >&2; exit 1; }
unset FAIL_MIGRATE
rm -f "$root/state/production/deploy-pending"
printf 'old\n' > "$root/state/production/deployed-tag"
: > "$LOG"
sh /work/deploy/deploy.sh old production
[ "$(wc -l < "$LOG")" -eq 1 ]
grep -q 'exec -T api node' "$LOG"
( flock -n 8; touch "$root/locked"; /bin/sleep 4 ) 8>"$root/state/production/deploy.lock" &
pid=$!
while [ ! -f "$root/locked" ]; do /bin/sleep 0.1; done
if sh /work/deploy/deploy.sh new production; then echo 'concurrent deploy must fail' >&2; exit 1; fi
wait "$pid"
echo 'PASS: same tag only checks health and concurrent deploy is refused'
: > "$LOG"
export FAIL_TAG=new
if sh /work/deploy/deploy.sh new production; then echo 'unhealthy deployment must fail' >&2; exit 1; fi
[ "$(cat "$root/state/production/deployed-tag")" = old ]
grep -q '^new | .*run --rm --no-deps migrate' "$LOG"
dump_line=$(grep -n pg_dump "$LOG" | cut -d: -f1)
migrate_line=$(grep -n 'run --rm --no-deps migrate' "$LOG" | cut -d: -f1)
[ "$dump_line" -lt "$migrate_line" ]
grep -q synthetic-dump "$root"/state/production/dumps/*.sql
grep -q '^old | .* up -d' "$LOG"
if grep -Ei 'migrate.*down|rollback.*database' "$LOG"; then echo 'schema rollback is forbidden' >&2; exit 1; fi
echo 'PASS: failed health restores old image without a down migration'
