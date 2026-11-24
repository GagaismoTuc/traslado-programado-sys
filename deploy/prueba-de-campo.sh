#!/bin/sh
# Prueba de campo (issue #146, ADR 0003): the December tracking test's own environment, separate from local staging
# and the only one that keeps real Posiciones. It runs the local staging engine, which takes its project, state
# directory, subnets and port from this script's name.
# Usage: sh deploy/prueba-de-campo.sh <up|down|borrar [--confirmar]>
. "$(dirname -- "$0")/local-staging.sh"
