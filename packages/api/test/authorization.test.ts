import { describe, expect, it } from "vitest";
import { createApp, type RoutingHealth } from "../src/app.js";

const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const app = createApp({ db: { query: async () => ({ rows: [], rowCount: 0 }) }, routing: routingUp, config: { serverEpoch: "authorization-test" } });
const authorizationEvidence = new Map([
  ["ALL /*", "rejects unauthenticated requests for protected routes"],
  ["GET /health", "returns an empty successful health response with the configured epoch"],
  ["POST /auth/login", "returns the same login error for unknown and incorrect credentials"],
  ["GET /auth/me", "rejects unauthenticated requests for protected routes"],
  ["GET /auth/sessions", "rejects unauthenticated requests for protected routes"],
  ["POST /auth/logout", "creates labeled per-device sessions, sets a secure cookie, and logs out"],
  ["GET /users", "lets Oficina manage users and immediately invalidates a disabled user's sessions"],
  ["POST /users", "lets Oficina manage users and immediately invalidates a disabled user's sessions"],
  ["PATCH /users/:id/password", "lets Oficina manage users and immediately invalidates a disabled user's sessions"],
  ["PATCH /users/:id/disable", "lets Oficina manage users and immediately invalidates a disabled user's sessions"],
  ["POST /auth/totp/enrol", "keeps an Oficina password login in a pending state outside TOTP, me and logout while the Chofer login stays as before"],
  ["POST /auth/totp/verify", "keeps an Oficina password login in a pending state outside TOTP, me and logout while the Chofer login stays as before"],
  ["PATCH /users/:id/persistent-session", "lets only the Oficina change the persistent-session setting of Oficina accounts and logs each change"],
  ["GET /users/:id/sessions", "lists and revokes a user's device sessions only for the Oficina and only by a matching user and session"],
  ["DELETE /users/:id/sessions/:sessionId", "lists and revokes a user's device sessions only for the Oficina and only by a matching user and session"],
  ["GET /destinations", "allows only an authenticated Oficina user to create or list Destinos"],
  ["POST /destinations", "allows only an authenticated Oficina user to create or list Destinos"],
  ["PATCH /destinations/:id", "lets only the Oficina order a Recorrido or edit a Destino's Tolerancia de llegada"],
  ["GET /vehicle-features", "lets only Oficina create, list and edit Adaptaciones with unique names and change log entries"],
  ["POST /vehicle-features", "lets only Oficina create, list and edit Adaptaciones with unique names and change log entries"],
  ["PATCH /vehicle-features/:id", "lets only Oficina create, list and edit Adaptaciones with unique names and change log entries"],
  ["GET /vehicles", "creates, edits and deactivates Vehículos with seats, front: 1, Adaptaciones and transactional change log"],
  ["POST /vehicles", "creates, edits and deactivates Vehículos with seats, front: 1, Adaptaciones and transactional change log"],
  ["PATCH /vehicles/:id", "creates, edits and deactivates Vehículos with seats, front: 1, Adaptaciones and transactional change log"],
  ["PATCH /vehicles/:id/deactivate", "creates, edits and deactivates Vehículos with seats, front: 1, Adaptaciones and transactional change log"],
  ["GET /drivers", "links each Chofer 1:1 to a driver user, requires home address and pin visible only to Oficina, validates usual Vehículo and logs writes"],
  ["POST /drivers", "links each Chofer 1:1 to a driver user, requires home address and pin visible only to Oficina, validates usual Vehículo and logs writes"],
  ["PATCH /drivers/:id", "links each Chofer 1:1 to a driver user, requires home address and pin visible only to Oficina, validates usual Vehículo and logs writes"],
  ["GET /passengers", "lets only the Oficina create, list, edit, deactivate and reactivate Pasajeros and logs each write in the same transaction"],
  ["POST /passengers", "lets only the Oficina create, list, edit, deactivate and reactivate Pasajeros and logs each write in the same transaction"],
  ["PATCH /passengers/:id", "lets only the Oficina create, list, edit, deactivate and reactivate Pasajeros and logs each write in the same transaction"],
  ["PATCH /passengers/:id/deactivate", "lets only the Oficina create, list, edit, deactivate and reactivate Pasajeros and logs each write in the same transaction"],
  ["PATCH /passengers/:id/reactivate", "lets only the Oficina create, list, edit, deactivate and reactivate Pasajeros and logs each write in the same transaction"],
  ["GET /passengers/:id/authorized-adults", "lets only the Oficina add, edit and remove Adultos autorizados and record the Consentimiento, logging each write"],
  ["POST /passengers/:id/authorized-adults", "lets only the Oficina add, edit and remove Adultos autorizados and record the Consentimiento, logging each write"],
  ["PATCH /authorized-adults/:id", "lets only the Oficina add, edit and remove Adultos autorizados and record the Consentimiento, logging each write"],
  ["DELETE /authorized-adults/:id", "lets only the Oficina add, edit and remove Adultos autorizados and record the Consentimiento, logging each write"],
  ["GET /passengers/:id/consent", "lets only the Oficina add, edit and remove Adultos autorizados and record the Consentimiento, logging each write"],
  ["POST /passengers/:id/consent", "lets only the Oficina add, edit and remove Adultos autorizados and record the Consentimiento, logging each write"],
  ["POST /geocode", "answers Suggest pin through an Oficina-only POST with a validated query and returns only lat, lng and displayName"],
  ["POST /daily-plans", "lets only the Oficina read and write the Plan diario"],
  ["GET /daily-plans/:date", "lets only the Oficina read and write the Plan diario"],
  ["POST /daily-plans/:date/transfers", "lets only the Oficina read and write the Plan diario"],
  ["PATCH /transfers/:id", "lets only the Oficina read and write the Plan diario"],
  ["POST /transfers/:id/absence", "lets only the Oficina read and write the Plan diario"],
  ["POST /daily-plans/:date/routes", "lets only the Oficina read and write the Plan diario"],
  ["PATCH /routes/:id", "lets only the Oficina read and write the Plan diario"],
  ["PATCH /routes/:id/stops", "lets only the Oficina read and write the Plan diario"],
  ["POST /routes/:id/order", "lets only the Oficina order a Recorrido or edit a Destino's Tolerancia de llegada"],
  ["POST /daily-plans/:date/driver-days", "lets only the Oficina read and write the Plan diario"],
  ["POST /routes/:id/publish", "lets only the Oficina publish and read Versiones del plan"],
  ["GET /routes/:id/versions", "lets only the Oficina publish and read Versiones del plan"],
  ["POST /daily-plans/:date/publish", "lets only the Oficina publish and read Versiones del plan"],
]);

describe("API route authorization coverage", () => {
  it("maps every registered API route to an authorization test", () => {
    const uncovered = app.routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((route) => !authorizationEvidence.has(route));
    const registered = new Set(app.routes.map((route) => `${route.method} ${route.path}`));
    const stale = [...authorizationEvidence.keys()].filter((route) => !registered.has(route));
    expect({ uncovered, stale }).toEqual({ uncovered: [], stale: [] });
  });

  it("rejects unauthenticated requests for protected routes", async () => {
    const probes: Array<[string, string, unknown?]> = [
      ["GET", "/auth/me"],
      ["GET", "/auth/sessions"],
      ["GET", "/users"],
      ["POST", "/users", { username: "new", password: "secret", role: "driver" }],
      ["PATCH", "/users/1/password", { password: "new-secret" }],
      ["PATCH", "/users/1/disable", {}],
      ["POST", "/auth/totp/enrol", {}],
      ["POST", "/auth/totp/verify", { code: "123456" }],
      ["PATCH", "/users/1/persistent-session", { persistent: true }],
      ["GET", "/users/1/sessions"],
      ["DELETE", "/users/1/sessions/1"],
      ["GET", "/destinations"],
      ["POST", "/destinations", { name: "Escuela", kind: "school", address: "Calle Inventada 101", lat: -26.8, lng: -65.2 }],
      ["PATCH", "/destinations/1", { arrivalToleranceMinutes: 10 }],
      ["GET", "/vehicle-features"],
      ["POST", "/vehicle-features", { name: "rampa para silla de ruedas" }],
      ["PATCH", "/vehicle-features/1", { name: "rampa hidráulica" }],
      ["GET", "/vehicles"],
      ["POST", "/vehicles", { plate: "AA101BB", model: "Furgón Sintético", seats: 5, featureIds: [] }],
      ["PATCH", "/vehicles/1", { plate: "AA101BB", model: "Furgón Sintético", seats: 5, featureIds: [] }],
      ["PATCH", "/vehicles/1/deactivate", {}],
      ["GET", "/drivers"],
      ["POST", "/drivers", { userId: 1, name: "Chofer Sintético", homeAddress: "Calle Inventada 101", homeLat: -26.8, homeLng: -65.2 }],
      ["PATCH", "/drivers/1", { name: "Chofer Sintético", homeAddress: "Calle Inventada 101", homeLat: -26.8, homeLng: -65.2 }],
      ["GET", "/passengers"],
      ["POST", "/passengers", { name: "Pasajero Sintético", homeAddress: "Calle Inventada 101", homeLat: -26.8, homeLng: -65.2 }],
      ["PATCH", "/passengers/1", { name: "Pasajero Sintético", homeAddress: "Calle Inventada 101", homeLat: -26.8, homeLng: -65.2 }],
      ["PATCH", "/passengers/1/deactivate", {}],
      ["PATCH", "/passengers/1/reactivate", {}],
      ["GET", "/passengers/1/authorized-adults"],
      ["POST", "/passengers/1/authorized-adults", { name: "Madre Sintética", dni: "-1000001", relation: "madre", phone: "381-000-0001", legalGuardian: true }],
      ["PATCH", "/authorized-adults/1", { name: "Madre Sintética", dni: "-1000001", relation: "madre", phone: "381-000-0001", legalGuardian: true }],
      ["DELETE", "/authorized-adults/1"],
      ["GET", "/passengers/1/consent"],
      ["POST", "/passengers/1/consent", { signedByAdultId: 1, signedAt: "2026-10-01", otherAdultAllowed: false }],
      ["POST", "/geocode", { query: "Calle Inventada 101" }],
      ["POST", "/daily-plans", { date: "2026-11-02" }],
      ["GET", "/daily-plans/2026-11-02"],
      ["POST", "/daily-plans/2026-11-02/transfers", { passengerId: 1, direction: "entrada", destinationId: 1, targetTime: "08:00" }],
      ["PATCH", "/transfers/1", { companions: 1 }],
      ["POST", "/transfers/1/absence", {}],
      ["POST", "/daily-plans/2026-11-02/routes", { driverId: 1, startTime: "07:00", endTime: "09:00" }],
      ["PATCH", "/routes/1", { vehicleId: 1 }],
      ["PATCH", "/routes/1/stops", { stopIds: [1, 2] }],
      ["POST", "/routes/1/order"],
      ["POST", "/daily-plans/2026-11-02/driver-days", { driverId: 1, transferIds: [1] }],
    ];
    for (const [method, path, body] of probes) {
      const response = await app.request(path, {
        method,
        headers: { Origin: "http://localhost", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});
