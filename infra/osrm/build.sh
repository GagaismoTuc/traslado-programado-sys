#!/bin/sh
# Builds the Tucumán OSRM artifact away from the production server (CI or a temporary host).
# Usage: infra/osrm/build.sh <work dir>
# Needs only sh and Docker. Re-running reuses the verified download and rebuilds everything else.
# Result: image $ARTIFACT_REPOSITORY:$ARTIFACT_VERSION and <work dir>/image/data/SHA256SUMS.
set -eu
recipe=$(cd "$(dirname "$0")" && pwd)
. "$recipe/source.env"
work=${1:?usage: build.sh <work dir>}
mkdir -p "$work/cache"
work=$(cd "$work" && pwd)
stats="$work/build-stats.txt"
: > "$stats"
run="docker run --rm --user $(id -u):$(id -g)"

docker build -q -t traslado-osrm-cut -f "$recipe/cut.Dockerfile" "$recipe" > /dev/null

pbf="argentina-$OSM_SNAPSHOT.osm.pbf"
if [ ! -f "$work/cache/$pbf" ]; then
  $run -v "$work/cache:/cache" traslado-osrm-cut \
    sh -c "wget -q -O '/cache/$pbf.part' '$OSM_URL' && mv '/cache/$pbf.part' '/cache/$pbf'"
fi
if ! $run -v "$work/cache:/cache" traslado-osrm-cut \
  sh -c "echo '$OSM_MD5  /cache/$pbf' | md5sum -c --quiet"; then
  rm -f "$work/cache/$pbf"
  echo "checksum mismatch for $pbf; download removed" >&2
  exit 1
fi

$run -v "$work:/work" traslado-osrm-cut \
  /usr/bin/time -a -o /work/build-stats.txt -f "osmium-extract: %e s, peak RSS %M kB" \
  osmium extract --overwrite -b "$TUCUMAN_BBOX" -o /work/tucuman.osm.pbf "/work/cache/$pbf"

rm -rf "$work/image"
mkdir -p "$work/image"
$run -v "$work:/work" -v "$recipe:/recipe:ro" -e OSRM_STATS=/work/build-stats.txt \
  --entrypoint sh "$OSRM_IMAGE" /recipe/preprocess.sh /work/tucuman.osm.pbf /work/image/data "$ARTIFACT_VERSION"

cp "$recipe/Dockerfile" "$recipe/serve.sh" "$work/image/"
docker build -q --build-arg "OSRM_IMAGE=$OSRM_IMAGE" -t "$ARTIFACT_REPOSITORY:$ARTIFACT_VERSION" "$work/image" > /dev/null

ls -l "$work/tucuman.osm.pbf" | awk '{print "tucuman.osm.pbf: " $5 " bytes"}' >> "$stats"
du -sk "$work/image/data" | awk '{print "artifact data: " $1 " kB"}' >> "$stats"
cat "$stats"
echo "built $ARTIFACT_REPOSITORY:$ARTIFACT_VERSION"
