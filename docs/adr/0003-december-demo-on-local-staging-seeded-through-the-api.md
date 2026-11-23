---
status: accepted (decided by an agent under the human's delegation of 2026-11-23; the human confirms or vetoes)
---

# The December tracking demo runs on local staging behind Quick Tunnels, seeded through the public API

The demo must cost nothing and use only synthetic data. We run it on the existing local staging (`deploy/local-staging.sh`: Docker Desktop on Lautaro's PC, two Cloudflare Quick Tunnels giving the HTTPS origins that geolocation requires), with the same images as `main` and the real OSRM and VROOM. The demo data (Destinos, Vehículos, Choferes with accounts, Pasajeros with Adultos autorizados and Consentimiento, and a published Plan diario with Recorridos for a chosen date) is created by a seed command that calls the API's own HTTP routes as a synthetic Office account, so every validation, the routing engine, the route validator and the publication run exactly as for a real Oficina. Local staging creates that Office account; the seed enrols its TOTP second factor, keeps the TOTP secret beside the other generated passwords in the private state directory outside the repository, and prints the enrolment URI so the human adds it to any free authenticator app once. TOTP stays on; nothing in the API is relaxed for the demo.

## Considered Options

- **Local staging + Quick Tunnels (chosen).** $0, already built and tested, same stack as production. Limits: the PC must stay on and online during the test; tunnel URLs change on every restart (iOS needs the driver PWA reinstalled), and there is no uptime guarantee.
- **Paid VPS (Hostinger, PR #127).** Rejected for the demo: not free. It is the pilot's target.
- **Free cloud tiers (Oracle Always Free, Render, Fly.io, Railway).** Rejected: need a card or have no free Postgres, OSRM and VROOM do not fit their free memory, and data region and signup are new risks for a one-day test.
- **Named Cloudflare Tunnel or a free ngrok static domain.** Stable URLs, but a domain costs money (Cloudflare) or only one free hostname exists (ngrok) while the stack needs two origins.
- **Seed with SQL, as `deploy/seed-staging.sh` does.** Rejected for the Plan diario: a published Recorrido needs Versiones del plan, legs and stops that the API builds through the validator; copying that into SQL would duplicate its invariants and drift.
- **A demo-only login without TOTP.** Rejected: it would add a bypass to the production image.
