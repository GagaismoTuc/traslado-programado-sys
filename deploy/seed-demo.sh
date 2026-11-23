#!/bin/sh
# Demo seed (issue #141, ADR 0003): loads the synthetic demo data and publishes the Plan diario of one date through the
# API's public HTTP routes, as the synthetic Oficina account. The checks (project, date, environment up) live in
# packages/api/src/demo-seed.ts, which runs before it creates anything.
set -eu

if [ "$#" -ne 1 ]; then echo 'Uso: seed-demo.sh <AAAA-MM-DD>' >&2; exit 2; fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
project=${DEPLOY_PROJECT:-staging}
DEPLOY_ROOT=${DEPLOY_ROOT:-${HOME:?HOME is required}/traslado-staging}
state=$DEPLOY_ROOT/$project
script=$root/packages/api/src/demo-seed.ts
command -v node >/dev/null 2>&1 || { echo 'Se necesita node (la versión de package.json)' >&2; exit 1; }
if command -v cygpath >/dev/null 2>&1; then state=$(cygpath -w "$state"); script=$(cygpath -w "$script"); fi
umask 077
exec node --disable-warning=ExperimentalWarning "$script" "$project" "$state" "$1"
