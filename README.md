# traslado-programado-sys
Sistema de Traslado Programado

## Requirements

- Node.js 24.14.0 and Corepack
- Docker Desktop with Compose (the integration tests start PostgreSQL with Testcontainers and the routing services with Compose)

## Setup

```sh
corepack enable
pnpm install
```

Set `SERVER_EPOCH`, `DATABASE_URL`, `OSRM_URL` and `VROOM_URL` before starting the API; `/health` answers 200 only when PostgreSQL, OSRM and VROOM all answer. Database connections use UTC. To create the migration and application roles, connect as a PostgreSQL administrator and run `pnpm --filter @traslado/api db:bootstrap` with `BOOTSTRAP_DATABASE_URL`, `MIGRATION_PASSWORD`, and `APPLICATION_PASSWORD` set. Run `pnpm db:migrate` as the migration role.

## Routing (OSRM + VROOM)

`docker compose up -d --wait` starts OSRM on `127.0.0.1:5000` and VROOM (vroom-express) on `127.0.0.1:3001` (override with `OSRM_PORT` and `VROOM_PORT`); point the API at them with `OSRM_URL=http://127.0.0.1:5000` and `VROOM_URL=http://127.0.0.1:3001`. The OSRM image is a GHCR package of this private repository, so run `docker login ghcr.io` first.

OSRM data is never preprocessed where it is served. The `OSRM artifact` workflow runs `infra/osrm/build.sh` on a CI runner: it downloads the pinned Geofabrik Argentina snapshot (`infra/osrm/source.env`), checks its MD5, cuts the Tucumán bounding box with osmium, runs the OSRM car-profile MLD pipeline and builds an image tagged with the artifact version, holding the data, its `VERSION` and `SHA256SUMS`. Pushes to `main` publish it to `ghcr.io/gagaismotuc/traslado-osrm`; a version that is already published is never overwritten, so changing the recipe means bumping `ARTIFACT_REVISION` (and the default tag in `compose.yaml`). The container verifies the checksums before serving and logs `OSRM artifact version: <version>`.

VROOM time windows constrain the start of a job's setup (the arrival), not the start of its service.

## Checks

```sh
pnpm typecheck
pnpm build && pnpm test
```
