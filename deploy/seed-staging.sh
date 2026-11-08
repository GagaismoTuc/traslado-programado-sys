#!/bin/sh
set -eu
if [ "$#" -ne 0 ]; then echo 'Usage: seed-staging.sh' >&2; exit 2; fi
DEPLOY_PROJECT=staging; export DEPLOY_PROJECT
: "${DEPLOY_ROOT:?DEPLOY_ROOT must point outside the repository}"
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
state=$(CDPATH='' cd -- "$DEPLOY_ROOT/staging" && pwd -P)
case "$state/" in "$root/"*) echo 'DEPLOY_ROOT must be outside the repository' >&2; exit 2;; esac
[ -f "$state/.env" ] || { echo 'Missing staging env file' >&2; exit 2; }
docker compose --project-name traslado-staging --env-file "$state/.env" -f "$root/deploy/compose.yaml" exec -T db sh -c 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL'
INSERT INTO passengers (name, home_address, home_latitude, home_longitude, companions, front_seat, wheelchair, max_ride_time_minutes, pickup_duration_minutes, dropoff_duration_minutes)
SELECT 'Synthetic Passenger 001', 'Synthetic address 001', -26.8241, -65.2036, 0, false, false, 60, 2, 2
WHERE NOT EXISTS (SELECT 1 FROM passengers WHERE name = 'Synthetic Passenger 001' AND home_address = 'Synthetic address 001');
SQL
