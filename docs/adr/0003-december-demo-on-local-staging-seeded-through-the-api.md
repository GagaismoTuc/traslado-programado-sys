---
status: accepted (decided by an agent under the human's delegation of 2026-11-23; the human confirms or vetoes; the Prueba de campo environment was decided by the human on 2026-11-23, PR #143)
---

# The December tracking demo runs on a separate Prueba de campo environment, built like local staging and seeded through the public API

The demo must cost nothing, and the phones it follows belong to real team members, so their Posiciones are real personal data. `AGENTS.md` keeps staging, development and CI synthetic-only and names one exception: the **Prueba de campo** environment. It is a separate environment, on the same machine and with the same tooling as the existing local staging (`deploy/local-staging.sh`: Docker Desktop on Lautaro's PC, two Cloudflare Quick Tunnels giving the HTTPS origins that geolocation requires), with the same images as `main` and the real OSRM and VROOM, but it shares nothing with staging:

- its own Compose project (`traslado-prueba-de-campo`) and project name (`DEPLOY_PROJECT=prueba-de-campo`), hence its own database volume, private network and ingress network, with its own fixed subnets distinct from production's and staging's;
- its own private state directory outside the repository (`$DEPLOY_ROOT/prueba-de-campo`), with its own generated passwords, Office TOTP secret and tunnel URLs;
- its own gateway port on the loopback interface and its own two Quick Tunnels, so it can run while staging is up or down without touching it.

It is started by its own entry point (`deploy/prueba-de-campo.sh <up|down|borrar>`, name `inferido`) that reuses the code of `local-staging.sh`, parameterised by project, instead of copying it: the image pulls, tunnel handling, health checks and the synthetic Office account (#134) stay in one place. Each script refuses the other's project and state directory. `down` keeps the data between test days; `borrar` removes the containers, the database volume and the state directory, and is run when the test ends. The field-test ticket (sub-issue of #132, blocking #142) builds it.

The person records are synthetic even there: the demo data (Destinos, Vehículos, Choferes with accounts, Pasajeros with Adultos autorizados and Consentimiento, and a published Plan diario with Recorridos for a chosen date) is created by a seed command that calls the API's own HTTP routes as a synthetic Office account, so every validation, the routing engine, the route validator and the publication run exactly as for a real Oficina. The only real data is where the team members' phones were. The environment creates that Office account; the seed enrols its TOTP second factor, keeps the TOTP secret beside the other generated passwords in the environment's private state directory, and prints the enrolment URI so the human adds it to any free authenticator app once. TOTP stays on; nothing in the API is relaxed for the demo. The same seed runs against local staging, where everything, Posiciones included, stays synthetic.

When the test ends: the participants sign out of the driver app (which wipes any Posiciones still buffered on the phone) and uninstall it, and the operator runs `borrar` and checks that the volume and the state directory are gone. The written acceptances stay outside the repository and the system; the field-test issue records only how many participants accepted and that the data was deleted.

## Considered Options

- **Separate Prueba de campo environment built like local staging (chosen).** $0, reuses tested code, same stack as production, and keeps real locations out of staging as `AGENTS.md` requires. Limits: the PC must stay on and online during the test; tunnel URLs change on every restart (iOS needs the driver PWA reinstalled), and there is no uptime guarantee.
- **Run the field test on local staging itself (first version of this ADR).** Rejected 2026-11-23: real Posiciones in staging break the synthetic-only rule (codex review of PR #143), and staging's `down` retains the volume, so deletion would depend on someone remembering a manual step against the environment everybody else tests on.
- **Only synthetic Posiciones, simulated phones.** Rejected: the test exists to measure real phones (GPS accuracy, Wake Lock, battery, data).
- **Paid VPS (Hostinger, PR #127).** Rejected for the demo: not free. It is the pilot's target.
- **Free cloud tiers (Oracle Always Free, Render, Fly.io, Railway).** Rejected: need a card or have no free Postgres, OSRM and VROOM do not fit their free memory, and data region and signup are new risks for a one-day test.
- **Named Cloudflare Tunnel or a free ngrok static domain.** Stable URLs, but a domain costs money (Cloudflare) or only one free hostname exists (ngrok) while the stack needs two origins.
- **A copy of `local-staging.sh` for the field test.** Rejected: two copies of the tunnel and ownership checks would drift.
- **Seed with SQL, as `deploy/seed-staging.sh` does.** Rejected for the Plan diario: a published Recorrido needs Versiones del plan, legs and stops that the API builds through the validator; copying that into SQL would duplicate its invariants and drift.
- **A demo-only login without TOTP.** Rejected: it would add a bypass to the production image.

## Change history

- 2026-11-23: the first version ran the demo, with the volunteers' real Posiciones, on local staging. Codex's review of PR #143 flagged it against the `AGENTS.md` rule "Never use real personal data in development, CI, or staging; use synthetic test data only". The human chose, verbatim, "Entorno \"prueba de campo\"": a separate environment, named in `AGENTS.md` as the only exception, with real location only of team members who accept in writing, synthetic names, and its database deleted when the test ends. The file name is kept so existing references still resolve.
