#!/bin/sh
# Runs the OSRM car-profile MLD pipeline inside the OSRM image.
# Usage: preprocess.sh <input .osm or .osm.pbf> <output dir> <artifact version>
# Peak memory per step is appended to $OSRM_STATS (default: stderr).
set -eu
input=$1
out=$2
version=$3
stats=${OSRM_STATS:-/dev/stderr}

case "$input" in
  *.osm.pbf) region="$out/region.osm.pbf" ;;
  *.osm) region="$out/region.osm" ;;
  *) echo "unsupported input: $input" >&2; exit 2 ;;
esac

rm -rf "$out"
mkdir -p "$out"
cp "$input" "$region"

measure() {
  step=$1
  shift
  /usr/bin/time -a -o "$stats" -f "$step: %e s, peak RSS %M kB" "$@"
}

measure osrm-extract osrm-extract -p /opt/car.lua "$region"
measure osrm-partition osrm-partition "$out/region.osrm"
measure osrm-customize osrm-customize "$out/region.osrm"
rm "$region"

printf '%s\n' "$version" > "$out/VERSION"
(cd "$out" && sha256sum VERSION region.osrm* > SHA256SUMS)
