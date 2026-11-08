#!/bin/sh
set -eu
image=$1
archive=$2
expected=$3
local_image=$4
log=$(mktemp)
trap 'rm -f "$log"' EXIT

test -f "$archive"
docker load --input "$archive"
docker tag "$image" "$local_image"
docker push "$local_image" > "$log"
actual=$(sed -n 's/.*digest: \(sha256:[0-9a-f]*\) size:.*/\1/p' "$log")
test -n "$expected"
test "$actual" = "$expected"
printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
docker push "$image"
