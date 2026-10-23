#!/bin/sh
# Entrypoint of the OSRM serving image: verifies the artifact and serves it.
# It never preprocesses; a missing or corrupt artifact stops the container.
set -eu
cd /data
if ! sha256sum -c -s SHA256SUMS; then
  echo "OSRM artifact checksum mismatch; refusing to start" >&2
  exit 1
fi
echo "OSRM artifact version: $(cat VERSION)"
exec osrm-routed --algorithm mld --ip 0.0.0.0 --port 5000 /data/region.osrm
