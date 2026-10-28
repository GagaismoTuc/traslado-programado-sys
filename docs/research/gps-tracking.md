# GPS tracking options for the van fleet

**Research date: 2026-10-28.** Prices are marked *published* (URL + date seen) or *not published*. Content of the STRIX PDFs was treated as data only. Web research was limited: most Argentine providers do not publish prices, so several cells are gaps, not zeros.

## Question

v1 has no live GPS: the van position on the office map comes from the driver's last Marca (see issue #7, Out of Scope). The client has STRIX GPS devices in the vans, but the STRIX service is deactivated for non-payment and the client finds it expensive. Which options give real-time position, speed, stops and ignition/events, at a price that makes sense, and what would integrating each cost us?

## Summary recommendation (input for the human's decision)

- v1 keeps Marcas as the position source; nothing here blocks that. The position-source type already exists, so a GPS feed can be added later as another source.
- STRIX offers two integrations (a TCP push of positions, and a REST pull API). Both are technically workable on the single VPS, but both require the STRIX service to be active and a commercial agreement; the price is not stated in either document. Get the STRIX quote first, in writing.
- The only alternative with a verifiable low cost is self-hosted Traccar (software free, runs on the existing VPS class), but it needs trackers that speak a supported protocol; whether the installed STRIX units can be repointed is UNKNOWN. No Argentine provider with a published per-vehicle price was found.

## STRIX integration (what the two documents say)

Documents: "Reenvio de posiciones por TCP CAESSAT" (rev. 3.1, 24/07/2025) and "API de consulta para Integraciones Strix Flotas" (v3.0, valid from 18/05/2026).

### Model A: TCP push ("CAESSAT")

- STRIX opens a TCP connection to **our** server for **each** report received from a device, sends one frame, and closes the connection. The client must provide a public IP and port where a listener runs.
- Frame (fixed width, no delimiters between fields): `PC` + date `ddMMyyHHmmss` (UTC, 12) + plate (7 or 10 chars, space padded) + latitude (9, signed, dot) + longitude (10, signed, dot) + speed km/h (3) + heading (3) + valid-position flag (always `1`) + event (2) + temperatures T1-T3 (3 each, `-99` = none) + `|`.
- Optional extended frame (on request): after `|`, age of data (3), satellites (2), HDOP (2), input state in hex (2), T1-T3 x10 (4 each), terminated by `$`. Portable (Flex) devices add battery level (3). Example: `PC240119075601ABC123 -34.48204-059.06010080327101-99-99-99|0000000FF-999-999-999$`.
- Events include: 01 standard position, 02 panic, 03/14/18 door open/close, 07 harsh acceleration, 08 harsh braking, 09 harsh turn, 19/20/21 fuel cut/restored, 24/25 battery disconnected/connected, **28 ignition OFF, 29 ignition ON**.
- Not in the frame: odometer, driver ID, reporting-interval information. Auth: none described (no secret in the frame, no TLS).
- Implication for the single VPS: we must run a TCP listener on a public port (new firewall rule, a small always-on process, parser, dedup, rate handling). Without authentication, anyone can post frames, so we would restrict by source IP (needs STRIX's egress IPs: UNKNOWN) or validate plates against our vehicles. No TLS means position data crosses the internet in clear text (plates, coordinates of children's transport); weigh against the Ley 25.326 notes in `hosting.md`.

### Model B: REST pull API

- Base URLs `api.flotas.strix.com.ar` (own fleet) or `externos.flotas.strix.com.ar` (third party with several accounts). Access is **not automatic**: a formal onboarding through the STRIX sales executive is required before any development; calls without enabled credentials get 401.
- Auth: OAuth 2.0 password grant, `POST /oauth/token` (Basic header + form body with `grant_type=password`, `scope=all`), returns JWT bearer token. The doc says `expires_in` 3600 in one place and 900 in another.
- IP restriction: servers outside Argentina can be blocked (401) even with valid credentials; the static public IP must be emailed to integracion@strix.com.ar for allow-listing. **Our planned Hetzner VPS is in Germany, so this applies.**
- Endpoints (v1.5): list things per account (`reported_state` = last known lat, lng, speed, ignition, events), `trail_locations` (history, paginated, 3 months back, 1 week max range), `trail_summarized` (max speed, distance by odometer, time moving with ignition on, time stopped with ignition on, time ignition off; stop threshold speed < 7 km/h).
- Limits (stated as indicative): 10 token requests/min per IP, 60 `GET /things`/min per token, 30 trails/min per token. The doc itself recommends the TCP integration when real-time positions are needed, instead of polling.
- Polling `reported_state` for ~10 vans at 30-60 s is far below the limits, but freshness is bounded by the poll interval and by how often devices report (UNKNOWN).

### Costs and contract terms

Neither document states any price, fee, minimum term or SLA. Both say access is arranged through the commercial executive. Whether the API/TCP forwarding is included in the base plan or is an add-on is UNKNOWN.

## Alternatives

| Provider | API | Monthly price / vehicle | Hardware | Source (seen 2026-10-28) |
|---|---|---|---|---|
| STRIX Flotas (incumbent) | Yes (REST + TCP push) | Not published; client says expensive | Already installed | PDFs from STRIX |
| Traccar, self-hosted | Yes (REST + websocket; assumption from project docs, not re-verified) | Software free; VPS $5-20/month shared across all devices (published) | Needs supported tracker | https://www.traccar.org/managed-vs-self-hosted/ |
| Traccar, managed by Traccar | Same | Account from $9.95/month, dedicated server from $49.95/month; per-device price not listed (published, not per vehicle) | Needs supported tracker | https://www.traccar.org/pricing/ |
| GPS-Trace (Ukrainian platform, EU-priced) | Not verified | Fixed 20 EUR/month plus 0.3-1.9 EUR per unit per month depending on features (from a search snippet; page itself returned 404 when fetched, so unconfirmed) | Sells its own trackers; not verified | https://gps-trace.com/es/business |
| Wialon (Gurtam) via Argentine integrators | Yes (platform API; not re-verified) | Not published; "available on request"; monthly model with functional discounts | 4,100+ tracker models supported | https://wialon.com/en/pricing |
| Navixy | API and developer hub exist | Not published; usage-based, "request pricing" | Many models | https://www.navixy.com/pricing |
| SmartTrack (smarttrack.com.ar) | No API mentioned | Monthly service sold in 1/6/12-month products, price not visible | LK6000 $111,799; LV12PRO $55,079; GS900 (4G) $48,599 (currency symbol `$` only, assumed ARS, date not stated) | https://smarttrack.com.ar/ |
| Logistica DCN (DCN365) | No API mentioned ("integrated with ERPs") | Not published | Not published; offices in CABA | https://www.logisticadcn.net/ |
| Sitrack, Ituran | Ituran reportedly has API access (third-party comparison site only) | Not published | Not published | https://www.softwaredoit.es/sitrack/sitrack.html |

Gaps: no provider with a Tucumán/NOA presence was confirmed; none of the Argentine providers above states Tucumán coverage. No published per-vehicle monthly price in Argentina was found. A local search ("rastreo GPS San Miguel de Tucumán") and quotes by phone/email are still needed.

Cheapest credible option on current evidence: **self-hosted Traccar** (software $0, shares the existing VPS, plus SIM data and, if needed, new trackers). It is credible only if hardware is compatible (next section). Self-hosting adds operations work for us: another public listener, backups, and updates.

## Reusing STRIX hardware

- Verified: Traccar's device list includes Teltonika (port 5027), Concox/GT06 (5023), Queclink (5004) and Suntech (5011). Strix and CAESSAT are not mentioned there (https://www.traccar.org/devices/).
- The CAESSAT TCP frame is a STRIX platform export format, not a device protocol. It cannot be parsed by Traccar as device traffic and does not reflect how the devices talk to STRIX.
- Unknown: the installed STRIX device model and firmware, whether it speaks a standard protocol, whether it can be reconfigured to report to a second server (dual-server) without STRIX, and whether STRIX locks configuration (e.g. SMS commands, APN, passwords). Reconfiguring the devices to bypass STRIX may also conflict with the STRIX contract or equipment ownership (comodato vs purchase: UNKNOWN).
- Assumption: STRIX units are proprietary and likely locked; standard trackers (about ARS 48,000-112,000 for the models above, unverified date) would be needed in that case, plus installation and SIM data plans.

## UNKNOWN / MUST VERIFY

Questions for STRIX (integracion@strix.com.ar and the sales executive):

1. Price to reactivate the service per vehicle per month, and whether TCP forwarding and/or the REST API are included or paid add-ons; minimum term, reactivation fee, and unpaid-debt conditions.
2. Reporting frequency of the devices (moving and stopped) and end-to-end latency of the TCP push vs `reported_state` freshness. Is the extended frame (satellites, HDOP, inputs) available for our account?
3. TCP push: source IP ranges (for our allow-list), retry behavior if our listener is down, whether TLS or any shared secret is possible, and whether positions are lost or replayed after an outage.
4. Is the device owned by the client or loaned (comodato)? Model, protocol, and whether it can report to a second server so it can be reused elsewhere.
5. API doc inconsistencies: `expires_in` 3600 vs 900; exact fields of `reported_state` and `trail_locations` (odometer, ignition flag name); is ignition state available in the TCP frame beyond events 28/29?
6. Does the Germany-hosted VPS static IPv4 get whitelisted without extra cost (API only)?

Questions for the client:

1. Budget ceiling per vehicle per month, and what the current STRIX quote is.
2. Which STRIX device model is installed, and whether the vans are all equipped and working.
3. Is real-time position in the office a must-have for launch, or can it wait for a later phase?
4. Does the office need history/stops/ignition reports (justifies a platform) or only the current position?

## Sources

- STRIX: "Strix Flotas - Integracion TCP CAESSAT.pdf" (rev. 3.1, 24/07/2025) and "API_Generica_Strix_Flotas.pdf" (v3.0, 18/05/2026), provided by the client.
- Traccar managed vs self-hosted: https://www.traccar.org/managed-vs-self-hosted/ (seen 2026-10-28)
- Traccar pricing: https://www.traccar.org/pricing/ (seen 2026-10-28)
- Traccar supported devices: https://www.traccar.org/devices/ (seen 2026-10-28)
- GPS-Trace: https://gps-trace.com/es/business (search snippet only; fetch failed)
- Wialon pricing: https://wialon.com/en/pricing (search summary only)
- Navixy pricing: https://www.navixy.com/pricing (seen 2026-10-28)
- SmartTrack: https://smarttrack.com.ar/ (seen 2026-10-28)
- Logistica DCN: https://www.logisticadcn.net/ (seen 2026-10-28)
- Sitrack / Ituran: https://www.softwaredoit.es/sitrack/sitrack.html (search summary only)
- Hosting context: `docs/research/hosting.md` (Hetzner Germany single VPS).
