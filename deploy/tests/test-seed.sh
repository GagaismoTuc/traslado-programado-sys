#!/bin/sh
set -eu
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/bin" "$root/state/staging"
touch "$root/state/staging/.env"
cat > "$root/bin/docker" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" > "$LOG"
cat > "$SQL"
MOCK
chmod +x "$root/bin/docker"
export PATH="$root/bin:$PATH" DEPLOY_ROOT="$root/state" LOG="$root/log" SQL="$root/sql"
sh /work/deploy/seed-staging.sh
grep -q -- '--project-name traslado-staging' "$LOG"
grep -q 'Synthetic Passenger' "$SQL"
if grep -Ei 'production|pg_restore|COPY ' "$SQL"; then echo 'seed may not copy production data' >&2; exit 1; fi
echo 'PASS: staging seed uses isolated staging project and synthetic passengers'
