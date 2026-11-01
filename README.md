# traslado-programado-sys
Sistema de Traslado Programado

## Requirements

- Node.js 24.22.1 and Corepack
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

After migrations are applied, create the initial Office account once with `pnpm --filter @traslado/api db:bootstrap-office <username>`, using `BOOTSTRAP_DATABASE_URL` and `BOOTSTRAP_OFFICE_PASSWORD` in the environment. The command refuses if an active Office account already exists (disabled ones are ignored, but their usernames cannot be reused) and records the actor as `bootstrap`; do not pass the password on the command line.

## Sessions and two-factor authentication

Office accounts sign in with a password and then a TOTP code from an authenticator app. Until the code is entered the session is pending: it lasts 10 minutes and every route except `/auth/totp/enrol`, `/auth/totp/verify`, `GET /auth/me` and logout answers 401 with `code: "second_factor_required"`. An account without TOTP enrols first (QR code and key in the Office app). "Remember this device" skips the code on that device for 30 days; revoking the device session forgets it, logging out does not.

Sessions of Office users with the persistent-session setting never expire; other Office sessions expire after 12 hours without use and Driver sessions after 30 days without use. A failed session answers 401 with `code: "session_expired"` (sign in again) or `code: "session_revoked"` (the device was revoked, the account disabled or reset by break-glass). Disable a Driver only after their queue for the day is confirmed: a revoked phone wipes its data, including pending Marcas.

If nobody can sign in to the Office, reset an active Office account's password and TOTP from the server with `pnpm --filter @traslado/api db:break-glass-office <username>`, using `BOOTSTRAP_DATABASE_URL` and `BREAK_GLASS_OFFICE_PASSWORD` in the environment. It ends that account's sessions and remembered devices, records the actor as `break-glass`, and refuses unknown, Driver and disabled accounts. The last active Office account cannot be disabled.

Browser mutations must include an allowed `Origin`. The API trusts the local Office/Driver Vite origins by default; set `AUTH_ALLOWED_ORIGINS` to a comma-separated list of exact origins in other deployments. Same-origin requests are always accepted.

The Office "Suggest pin" button geocodes an address through the API. Geocoding is off unless `GEOCODER=nominatim`; then the API calls `NOMINATIM_URL` (default `https://nominatim.openstreetmap.org`) with the `NOMINATIM_USER_AGENT` header, at most once per second for the whole process, caching repeated queries. Tests, CI and development keep it off. The Office map loads its style from `VITE_MAP_STYLE_URL` (OpenFreeMap Liberty by default).

The Office plans each day at `/plan`. Giving a Chofer their whole day cuts it into Recorridos wherever two consecutive target times are more than `ROUTE_GAP_MINUTES` apart (default 60).

## Checks

```sh
pnpm typecheck
pnpm build && pnpm test
```

`pnpm test:e2e` runs the C3 browser tests (Playwright on Chromium) against the real API and a PostgreSQL container; it needs Docker and `pnpm --filter @traslado/office exec playwright install chromium` once. The tests fail on any request that leaves localhost, use a local empty map style and seed the Oficina session directly instead of signing in. CI runs them in the separate `e2e` job.
