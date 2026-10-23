# traslado-programado-sys
Sistema de Traslado Programado

## Requirements

- Node.js 24.14.0 and Corepack
- Docker Desktop (the integration tests start PostgreSQL with Testcontainers)

## Setup

```sh
corepack enable
pnpm install
```

Set `SERVER_EPOCH` and `DATABASE_URL` before starting the API. Database connections use UTC. To create the migration and application roles, connect as a PostgreSQL administrator and run `pnpm --filter @traslado/api db:bootstrap` with `BOOTSTRAP_DATABASE_URL`, `MIGRATION_PASSWORD`, and `APPLICATION_PASSWORD` set. Run `pnpm db:migrate` as the migration role.

Browser mutations must include an allowed `Origin`. The API trusts the local Office/Driver Vite origins by default; set `AUTH_ALLOWED_ORIGINS` to a comma-separated list of exact origins in other deployments. Same-origin requests are always accepted.

## Checks

```sh
pnpm typecheck
pnpm build && pnpm test
```
