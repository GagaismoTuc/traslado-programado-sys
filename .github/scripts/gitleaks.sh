#!/bin/sh
# Scans the commits in <base>..<head> for secrets with a pinned gitleaks image,
# so CI and a local run use the same version and configuration.
# Usage: gitleaks.sh <base-sha> <head-sha> [repo-dir]
base=$1
head=$2
repo=${3:-.}
if [ -z "$base" ] || [ -z "$head" ]; then
  echo "gitleaks: no PR commits to scan"
  exit 0
fi

image=ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854
# Git Bash on Windows rewrites /repo into a Windows path unless told not to.
export MSYS_NO_PATHCONV=1
dir=$(cd "$repo" && { pwd -W 2>/dev/null || pwd; })
docker run --rm -v "$dir:/repo" "$image" \
  git /repo --log-opts="$base..$head" --redact --no-banner --verbose
