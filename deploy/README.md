# Deployment

The edge Compose project is the only component that publishes ports 80 and 443. It joins two distinct ingress networks. Each application project has its own private network and database volume; only its gateway joins its ingress network. PostgreSQL, OSRM and VROOM are not published or attached to ingress. Staging shares no network or volume with production.

`Caddyfile` terminates HTTPS at the edge and forwards to the appropriate project's `Gateway.Caddyfile`. Each gateway sends `/api/*` to the API (removing `/api`) and the remaining paths to the office or driver PWA. `PRODUCTION_HOST` and `STAGING_HOST` are the office hostnames; driver hostnames are `driver.<office-hostname>`. Point all four DNS names to the server. The running API receives only application database credentials; the `bootstrap` and `migrate` services are opt-in tools.

## Configuration

Create `production` and `staging` directories outside the repository under `DEPLOY_ROOT`, readable only by the deployment operator. Copy `.env.example` separately to each directory as `.env` and replace every placeholder with independently generated values. Set `DEPLOY_PROJECT` to the matching project. Both files must contain the same `PRODUCTION_HOST` and `STAGING_HOST`; each `AUTH_ALLOWED_ORIGINS` must list that project's two exact HTTPS origins. Database URL passwords must be URL-encoded and match the corresponding bootstrap passwords. Do not copy production databases or dumps into staging.

Each project has fixed Docker subnets so the API can tell its proxies from clients: `DEPLOY_SUBNET` is the project's private network and `INGRESS_SUBNET` its ingress network from `edge.compose.yaml` (production `172.16.11.0/24` and `172.16.10.0/24`, staging `172.16.21.0/24` and `172.16.20.0/24`). Set `TRUSTED_PROXY_CIDRS` to both, `DEPLOY_SUBNET,INGRESS_SUBNET`, and never to `0.0.0.0/0` or a public range. The edge trusts no proxy, so it replaces any `X-Forwarded-For` a client sends with the client's address; the gateway trusts only `INGRESS_SUBNET` (Caddy's `servers > trusted_proxies`), so it keeps the edge's header and appends the edge's address; the API skips both proxies and limits logins by the client address. A host that already runs a project must recreate its networks (`down`, then `up`) when the subnets are first set.

Leave `CADDY_TLS` empty for public ACME certificates. For local testing, use `CADDY_TLS=tls internal` and configure the clients to trust Caddy's local CA, or use an explicitly insecure test client. The edge reads its settings from the production env file; never put credentials in a Docker image or in this repository.

## First setup

From the repository root, create the edge and its two ingress networks first:

```sh
export DEPLOY_ROOT=/srv/traslado
export IMAGE_TAG=<published-tag>
docker compose --project-name traslado-edge --env-file "$DEPLOY_ROOT/production/.env" -f deploy/edge.compose.yaml up -d
```

Create each database and provision its roles once, waiting until PostgreSQL is ready before running bootstrap:

```sh
docker compose --project-name traslado-production --env-file "$DEPLOY_ROOT/production/.env" -f deploy/compose.yaml up -d db
docker compose --project-name traslado-production --env-file "$DEPLOY_ROOT/production/.env" -f deploy/compose.yaml run --rm --no-deps bootstrap
```

For staging, replace both occurrences of `production` with `staging`. The env file for that project must set the matching `DEPLOY_PROJECT`. Recreate only the edge after changing its hostnames or TLS settings:

```sh
docker compose --project-name traslado-edge --env-file "$DEPLOY_ROOT/production/.env" -f deploy/edge.compose.yaml up -d --force-recreate edge
```

An application deployment never restarts the edge or the other application project.

## Deploy and rollback

Run `sh deploy/deploy.sh <tag> <production|staging>`. The script requires an existing, bootstrapped database; it pulls images, writes a pre-migration dump to the project's private `dumps` directory, migrates forward and restarts that project. It records the tag only after the API health check succeeds. Repeating a deployed tag checks health without migrating. A per-project lock rejects concurrent runs.

A health failure restores the previously recorded image, **not the database**. Every migration must be expand/contract compatible with the previous image before deployment; otherwise image rollback is unsafe. If an interrupted first deploy leaves `deploy-pending`, investigate the schema and image state manually before clearing it. Dumps contain sensitive data and need restricted access, retention and separately tested backup procedures.

After migrations, `sh deploy/seed-staging.sh` inserts a synthetic passenger into the staging project only. It never reads production dumps.

## Local staging

This temporary, synthetic-data-only environment uses Docker Desktop, Git Bash and
Cloudflare Quick Tunnels on the Windows PC. Install `cloudflared` and start Docker
Desktop. The script finds it on `PATH` or in `C:\Program Files (x86)\cloudflared`.
The GHCR images are private: first run `docker login ghcr.io` with a token that
has `read:packages`. Do not put the token in the repository or the staging env.

From the repository root run:

```sh
sh deploy/local-staging.sh up
sh deploy/local-staging.sh down
```

`up` pulls the three application images tagged with the current `origin/main`
commit and the pinned OSRM image, creates a synthetic database, and prints an
office URL and a driver URL. Set `IMAGE_TAG` before the first `up` to select a
different published application image tag. The driver username is
`synthetic-driver`; its generated password is in
`$HOME/traslado-staging/staging/driver-password`. The generated env and tunnel
state are alongside it, outside the repository; keep that directory private.
`DEPLOY_ROOT` may select a different external directory before the first `up`.

`down` stops the containers and tunnels but retains the staging database volume.
Never import production data into it. Quick Tunnels are temporary and have no
uptime guarantee; this setup is for testing, not the pilot. Their hostnames
change after a restart. On iOS, reinstall the driver PWA from the new URL after
each restart. To check on a phone, turn off Wi-Fi, open both printed URLs, and
sign in to the driver app with the synthetic account above.

## Local verification

`node --test deploy/tests/compose.test.mjs` checks the rendered Compose isolation. `deploy/tests/edge-smoke.ps1` creates and removes three disposable projects and checks HTTPS and network isolation using `deploy/tests/mock-osrm.Dockerfile`, a test-only stub. Build the local app images and mock first; the stub is not a substitute for the real OSRM artifact or a representative resource measurement. The real image and full-stack memory measurement remain pending until the registry grants `read:packages`.

On Windows with Docker Desktop, `deploy/tests/deploy-live.ps1` exercises an initial deployment and a forced failed deployment against a disposable PostgreSQL instance. It verifies that the previous image is restored and can answer health after the new schema migration. Build the three local app test images and the mock OSRM image before running it. The probe replaces bind-mounted config files with disposable volumes and simulates the pull of local tags; it does not verify a real registry pull or real OSRM. It refuses to run if its fixed disposable project or resource names are already in use.
