#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
for target in api office driver; do
  available=$(df -Pk "$root" | awk 'NR == 2 {print $4}')
  if [ "$available" -lt 1572864 ]; then
    echo "Less than 1.5 GiB available; refusing to build" >&2
    exit 1
  fi
  docker build --target "$target" -t "traslado-test-$target:local" "$root"
done
test "$(docker run --rm --network none traslado-test-api:local node --version)" = v24.22.1
test "$(docker run --rm --network none traslado-test-api:local pnpm --version)" = 11.28.4
for target in office driver; do
  docker run --rm --network none --entrypoint sh "traslado-test-$target:local" -c 'caddy validate --config /etc/caddy/Caddyfile'
  docker run --rm --network none --entrypoint sh "traslado-test-$target:local" -c 'grep -rq /api /srv/assets'
done
