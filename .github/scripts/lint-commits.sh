#!/bin/sh
# Lints the header of every commit in <base>..<head> with .githooks/commit-msg,
# so the local hook and CI apply exactly the same rule.
# Without a range (a push to main has no PR commits to review) there is nothing to lint.
# Usage: lint-commits.sh <base-sha> <head-sha>
base=$1
head=$2
if [ -z "$base" ] || [ -z "$head" ]; then
  echo "lint-commits: no PR commits to lint"
  exit 0
fi

hook=$(cd "$(dirname "$0")/../.." && pwd)/.githooks/commit-msg
msg=$(mktemp)
trap 'rm -f "$msg"' EXIT
status=0
for sha in $(git rev-list --reverse "$base..$head"); do
  git log -1 --format=%B "$sha" > "$msg"
  if ! sh "$hook" "$msg"; then
    echo "lint-commits: commit $sha" >&2
    status=1
  fi
done
exit $status
