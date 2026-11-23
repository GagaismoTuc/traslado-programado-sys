---
status: accepted (decided by an agent under the human's delegation of 2026-11-23; the human confirms or vetoes)
---

# Posiciones live in their own table, separate from Marcas, and are purged after 90 days

A Posición is location data about a person (the Chofer) taken every few seconds, while a Marca is the permanent, append-only proof given to families and institutions. Spec #7 already set the rule for "a future position source": its own table, purged after 90 days, so Marcas are never purged and the application role never needs UPDATE or DELETE on them. We keep that rule: Posiciones go in their own table keyed to the Recorrido (and the Chofer who sent them), the application role can insert and delete but never update them, the API purges those older than 90 days (`inferido`: from spec #7, not yet confirmed by the client, whose own retention answer was "hasta que lo dice el contador"), and the phone deletes each Posición once the server has confirmed it.

## Considered Options

- **Own table, purged at 90 days (chosen).** Matches spec #7; keeps the Marca table's guarantees intact; bounded growth (11 vans × 10 h × 240 Posiciones/h ≈ 26 000 rows a day, ≈ 2.4 M at 90 days, fine without PostGIS).
- **Store Posiciones as Marcas of a new kind.** Rejected: Marcas are kept forever and are proof; mixing them would either keep location data forever or break the append-only rule.
- **Keep only the latest Posición per Recorrido.** Rejected: the Oficina wants to follow the Rastro, and it is what the field test needs to judge accuracy and gaps.
- **Never store, only relay in memory.** Rejected: the live map polls, a restart would lose everything, and the Rastro could not be drawn.

## Consequences

- Only synthetic data and volunteers who agreed to it go into a non-production environment; the demo database is deleted after the field test.
- Retention is a constant to confirm with the client and the accountant before the pilot.
