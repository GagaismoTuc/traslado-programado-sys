#!/bin/sh
# Passes only when every needed job finished in success
# (failure, cancelled and skipped all fail).
# Usage: ci-ok.sh <result>...
if [ $# -eq 0 ]; then
  echo "ci-ok: no job results" >&2
  exit 1
fi
status=0
for result in "$@"; do
  echo "ci-ok: $result"
  [ "$result" = success ] || status=1
done
exit $status
