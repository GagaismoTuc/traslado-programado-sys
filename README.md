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

Set `SERVER_EPOCH`, `DATABASE_URL`, `OSRM_URL` and `VROOM_URL` before starting the API; it listens on `PORT` (default `3000`) of `HOST` (default `0.0.0.0`, every interface); `/health` answers 200 only when PostgreSQL, OSRM and VROOM all answer. Database connections use UTC. To create the migration and application roles, connect as a PostgreSQL administrator and run `pnpm --filter @traslado/api db:bootstrap` with `BOOTSTRAP_DATABASE_URL`, `MIGRATION_PASSWORD`, and `APPLICATION_PASSWORD` set. Run `pnpm db:migrate` as the migration role.

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

"Order" on a Borrador Recorrido (`POST /routes/:id/order`) sends it to VROOM. The engine minimises km and keeps every Pasajero within their Tiempo máximo a bordo minus `RIDE_TIME_BUFFER_MINUTES` (default 5). VROOM's durations are scaled by the factor of the time band the Recorrido starts in, set with `SPEED_FACTORS` as `HH:MM=factor,...` (default `00:00=1`, factors above 0 and up to 5). Traslados the engine cannot place leave the Recorrido, and the response gives the reason for each. The start is not before the previous Recorrido's planned end: OSRM's `/route` adds the drive from its last Parada to where it ends (the Chofer's home when the Oficina set it to end there) and from there to this start, when they differ. If VROOM or OSRM does not answer, Order returns 502 and changes nothing; if anything the engine was given changes while it works (the Recorrido, the Chofer's Recorridos right before and after it, their Traslados, Pasajeros, Destinos or the Vehículo), it returns 409 and changes nothing; a change sent after that last check waits until Order has saved. The start and end of each Recorrido default to the Chofer's home, or to where the previous Recorrido ended, and the Oficina can override them. Each Destino has a Tolerancia de llegada that the Oficina can edit.

During the day the Oficina can change a Recorrido En curso and publish it again as the next Versión del plan. A done Parada (a pickup marked Subió, Ausente or Entregado, or a drop-off marked Entregado) never changes: done Paradas stay first, in the order of the latest version, with its legs and planned times, and moving one by hand returns 409. The Oficina can add a Traslado to it, such as an early pickup at a Destino, and change its Vehículo when the same Chofer carries on in a replacement van; its Chofer stays. The validator checks what is still to come: Entregado and Ausente Traslados are left out, and a Pasajero on board rides from their actual Subió. "Order" on a Recorrido En curso goes on from its last done Parada; each Pasajero on board is only a drop-off, in this Vehículo, by their Subió plus the Tiempo máximo a bordo minus `RIDE_TIME_BUFFER_MINUTES`, and is never left out. From version 2 on, the Chofer app lists what changed (Vehículo, Traslados added or removed, planned times) since the version the Chofer acknowledged, or since the previous one.

## Checks

```sh
pnpm typecheck
pnpm build && pnpm test
```

`pnpm test:e2e` runs the C3 browser tests (Playwright on Chromium) against the real API and a PostgreSQL container; it needs Docker and `pnpm --filter @traslado/office exec playwright install chromium` once. The tests fail on any request that leaves localhost, use a local empty map style and seed the Oficina session directly instead of signing in. CI runs them in the separate `e2e` job.
