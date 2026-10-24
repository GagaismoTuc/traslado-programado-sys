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
  ["GET /destinations", "allows only an authenticated Oficina user to create or list Destinos"],
  ["POST /destinations", "allows only an authenticated Oficina user to create or list Destinos"],
  ["POST /geocode", "answers Suggest pin through an Oficina-only POST with a validated query and returns only lat, lng and displayName"],
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
      ["GET", "/destinations"],
      ["POST", "/destinations", { name: "Escuela", kind: "school", address: "Calle Inventada 101", lat: -26.8, lng: -65.2 }],
      ["POST", "/geocode", { query: "Calle Inventada 101" }],
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
