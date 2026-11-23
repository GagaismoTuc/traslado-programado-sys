---
status: accepted (decided by an agent under the human's delegation of 2026-11-23; the human confirms or vetoes)
---

# Live position comes from the Chofer's phone, through the driver PWA, only in the foreground

The Oficina's live map needs a position fresher than the last Marca, the client's STRIX trackers are switched off, and the December field demo must cost nothing (`docs/research/gps-costs/README.md`, option E vs A–D). We decided that the position comes from the Chofer's own phone, captured by the existing driver PWA with the browser's Geolocation API (`watchPosition`) only while one of the Chofer's Recorridos is en curso and the app is visible, kept awake with the Screen Wake Lock API. A Pasajero's own device is never tracked: the Oficina follows a Pasajero through the Recorrido that carries them. This is the real feature behind the existing domain (Recorrido en curso, live map), not a throwaway demo mode.

## Considered Options

- **Driver PWA, foreground only (chosen).** $0, no store, no new app to install, reuses the session, the offline machinery and the Recorrido lifecycle. Limit: the W3C Geolocation spec delivers positions only to visible documents, so with the screen off or the app in the background the Seguimiento stops and the Oficina sees a Posición desactualizada.
- **Traccar Client on the Chofer's phone plus self-hosted Traccar.** Real background tracking on Android and iOS at $0 in licences, but a second app, a second server, a second identity for each phone to map to a Chofer, and iOS still stops when the user swipes the app away. Kept as the next step if the field test shows foreground-only is not enough.
- **Own native app (or Traccar SDK).** The only fully continuous path on both systems, but store accounts (Apple's is paid), review and a second codebase. Spec #7 already lists it as plan B.
- **Vehicle GPS trackers (STRIX or new hardware).** Not free and not about phones, which is what the human asked to track.

## Consequences

- Positions stop when the screen locks or the app is hidden; the map must show the age of the last Posición and never present an old one as live.
- Battery drain with screen on and high-accuracy GPS is real; the field test measures it and Choferes are expected to use a car charger (`inferido`).
- Whether a home-screen PWA on iOS keeps the Wake Lock and the location permission across launches is UNKNOWN / MUST VERIFY on real phones.
