import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const app = createApp({ db: appPool, routing: routingUp, config: { serverEpoch: "destinations-test" } });

// Synthetic place: a fictitious school on a fictitious street inside the Tucumán test bounds.
const validDestination = {
  name: "Escuela Sintetica 1",
  kind: "school",
  address: "Calle Inventada 101",
  accessNotes: "Entrada por el portón lateral",
  lat: -26.8241,
  lng: -65.2036,
};

async function request(path: string, method: string, body?: unknown, cookie?: string) {
  return await app.request(path, {
    method,
    headers: {
      Origin: "http://localhost",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function signIn(username: string, role: "office" | "driver") {
  await migrationPool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)", [
    username,
    await hashPassword(`${username}-password`),
    role,
  ]);
  if (role === "office") return (await signInOffice(app, migrationPool, username, `${username}-password`)).cookie;
  const response = await request("/auth/login", "POST", { username, password: `${username}-password`, deviceLabel: "Test browser" });
  return getSessionCookie(response).cookie;
}

async function counts() {
  const result = await migrationPool.query(
    "SELECT (SELECT count(*)::int FROM destinations) AS destinations, (SELECT count(*)::int FROM change_log WHERE entity = 'destination') AS changes",
  );
  return result.rows[0] as { destinations: number; changes: number };
}

beforeAll(async () => {
  await appPool.query("SELECT 1");
});
afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

describe("Destinos", () => {
  it("creates a Destino only with numeric coordinates inside the valid ranges", async () => {
    const office = await signIn("office", "office");
    const invalid: Array<Record<string, unknown>> = [
      { lat: 90.0001 },
      { lat: -90.0001 },
      { lng: 180.0001 },
      { lng: -180.0001 },
      { lat: "-26.8241" },
      { lng: "-65.2036" },
      { lat: null },
      { lng: null },
      { lat: undefined },
      { lng: undefined },
    ];
    for (const change of invalid) {
      const response = await request("/destinations", "POST", { ...validDestination, ...change }, office);
      expect(response.status, JSON.stringify(change)).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request" });
    }
    expect(await counts()).toEqual({ destinations: 0, changes: 0 });

    for (const edge of [{ lat: 90, lng: 180 }, { lat: -90, lng: -180 }]) {
      const response = await request("/destinations", "POST", { ...validDestination, ...edge }, office);
      expect(response.status, JSON.stringify(edge)).toBe(201);
      expect((await response.json()).destination).toMatchObject(edge);
    }
    expect(await counts()).toEqual({ destinations: 2, changes: 2 });
  });

  it("validates name, address text, access notes and kind before creating a Destino", async () => {
    const office = await signIn("office", "office");
    const invalid: Array<Record<string, unknown>> = [
      { name: "   " },
      { name: "n".repeat(201) },
      { name: 7 },
      { address: "  " },
      { address: "a".repeat(501) },
      { address: undefined },
      { accessNotes: "x".repeat(1001) },
      { accessNotes: 3 },
      { kind: "hospital" },
      { kind: "School" },
      { kind: undefined },
    ];
    for (const change of invalid) {
      const response = await request("/destinations", "POST", { ...validDestination, ...change }, office);
      expect(response.status, JSON.stringify(change)).toBe(400);
    }
    expect(await counts()).toEqual({ destinations: 0, changes: 0 });

    const longest = await request("/destinations", "POST", {
      ...validDestination,
      name: ` ${"n".repeat(200)} `,
      address: "a".repeat(500),
      accessNotes: "x".repeat(1000),
    }, office);
    expect(longest.status).toBe(201);
    expect((await longest.json()).destination).toMatchObject({ name: "n".repeat(200), address: "a".repeat(500), accessNotes: "x".repeat(1000) });

    for (const kind of ["school", "clinic", "therapy", "day_centre", "other"]) {
      const { accessNotes: _omitted, ...withoutNotes } = validDestination;
      const response = await request("/destinations", "POST", { ...withoutNotes, kind }, office);
      expect(response.status, kind).toBe(201);
      expect((await response.json()).destination).toMatchObject({ kind, accessNotes: null });
    }

    const column = await migrationPool.query(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'destinations' AND column_name = 'kind'",
    );
    expect(column.rows).toEqual([{ data_type: "text" }]);
    await expect(appPool.query(
      "INSERT INTO destinations (name, kind, address, latitude, longitude) VALUES ('Direct', 'hospital', 'Calle Inventada 101', 0, 0)",
    )).rejects.toThrow(/check constraint/i);
  });

  it("allows only an authenticated Oficina user to create or list Destinos", async () => {
    const driver = await signIn("driver", "driver");
    const office = await signIn("office", "office");

    expect((await request("/destinations", "GET")).status).toBe(401);
    expect((await request("/destinations", "POST", validDestination)).status).toBe(401);
    expect((await request("/destinations", "GET", undefined, driver)).status).toBe(403);
    expect((await request("/destinations", "POST", validDestination, driver)).status).toBe(403);
    expect(await counts()).toEqual({ destinations: 0, changes: 0 });

    const created = await request("/destinations", "POST", validDestination, office);
    expect(created.status).toBe(201);
    const destination = (await created.json()).destination;
    expect(destination).toEqual({ id: expect.any(Number), ...validDestination, createdAt: expect.any(String) });
    const listed = await request("/destinations", "GET", undefined, office);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ destinations: [destination] });
  });

  it("writes one Registro de cambios row with each Destino in the same transaction", async () => {
    const office = await signIn("office", "office");
    const created = await request("/destinations", "POST", validDestination, office);
    const destination = (await created.json()).destination;
    const log = await migrationPool.query(
      "SELECT u.username, c.entity_id, c.action, c.before_data, c.after_data FROM change_log c JOIN users u ON u.id = c.actor_user_id WHERE c.entity = 'destination'",
    );
    expect(log.rows).toEqual([{
      username: "office",
      entity_id: String(destination.id),
      action: "created",
      before_data: null,
      after_data: { name: "Escuela Sintetica 1", kind: "school", address: "Calle Inventada 101", accessNotes: "Entrada por el portón lateral", lat: -26.8241, lng: -65.2036 },
    }]);

    await migrationPool.query("REVOKE INSERT ON change_log FROM traslado_app");
    let withoutLog: Response;
    try {
      withoutLog = await request("/destinations", "POST", { ...validDestination, name: "Sin registro" }, office);
    } finally {
      await migrationPool.query("GRANT INSERT ON change_log TO traslado_app");
    }
    expect(withoutLog!.status).toBe(500);

    await migrationPool.query("REVOKE INSERT ON destinations FROM traslado_app");
    let withoutRow: Response;
    try {
      withoutRow = await request("/destinations", "POST", { ...validDestination, name: "Sin fila" }, office);
    } finally {
      await migrationPool.query("GRANT INSERT ON destinations TO traslado_app");
    }
    expect(withoutRow!.status).toBe(500);
    expect(await counts()).toEqual({ destinations: 1, changes: 1 });
  });

  it("allows two Destinos with the same name", async () => {
    const office = await signIn("office", "office");
    const first = await request("/destinations", "POST", validDestination, office);
    const second = await request("/destinations", "POST", validDestination, office);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect((await first.json()).destination.id).not.toBe((await second.json()).destination.id);
    expect(await counts()).toEqual({ destinations: 2, changes: 2 });
  });
});
