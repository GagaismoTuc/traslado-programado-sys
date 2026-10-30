import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCapacityExceeded } from "@traslado/shared";
import { createApp, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const app = createApp({ db: appPool, routing: routingUp, config: { serverEpoch: "fleet-test" } });

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

async function seedUser(username: string, role: "office" | "driver") {
  const result = await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role",
    [username, await hashPassword(`${username}-password`), role],
  );
  return result.rows[0] as { id: number; username: string; role: "office" | "driver" };
}

async function signIn(username: string, role: "office" | "driver") {
  const user = await seedUser(username, role);
  const response = await request("/auth/login", "POST", {
    username,
    password: `${username}-password`,
    deviceLabel: "Test browser",
  });
  const token = response.headers.get("set-cookie")?.match(/^session=([^;]+)/)?.[1];
  if (!token) throw new Error("session cookie was not set");
  return { cookie: `session=${token}`, user };
}

beforeAll(async () => {
  await appPool.query("SELECT 1");
});

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

describe("Adaptaciones (vehicle features)", () => {
  it("lets only Oficina create, list and edit Adaptaciones with unique names and change log entries", async () => {
    const { cookie: driver } = await signIn("driver-feat", "driver");
    const { cookie: office } = await signIn("office-feat", "office");

    expect((await request("/vehicle-features", "GET")).status).toBe(401);
    expect((await request("/vehicle-features", "POST", { name: "rampa para silla de ruedas" })).status).toBe(401);
    expect((await request("/vehicle-features", "GET", undefined, driver)).status).toBe(403);
    expect((await request("/vehicle-features", "POST", { name: "rampa para silla de ruedas" }, driver)).status).toBe(403);
    expect((await request("/vehicle-features/1", "PATCH", { name: "otra" }, driver)).status).toBe(403);

    for (const invalid of [{}, { name: "   " }, { name: "x".repeat(201) }, { name: 42 }]) {
      expect((await request("/vehicle-features", "POST", invalid, office)).status).toBe(400);
    }

    const created = await request("/vehicle-features", "POST", { name: "  rampa para silla de ruedas  " }, office);
    expect(created.status).toBe(201);
    const feature = (await created.json()).feature;
    expect(feature).toEqual({
      id: expect.any(Number),
      name: "rampa para silla de ruedas",
      createdAt: expect.any(String),
    });

    const duplicate = await request("/vehicle-features", "POST", { name: "Rampa para silla de ruedas" }, office);
    expect(duplicate.status).toBe(409);

    const updated = await request(`/vehicle-features/${feature.id}`, "PATCH", { name: "rampa hidráulica" }, office);
    expect(updated.status).toBe(200);
    expect((await updated.json()).feature).toMatchObject({ id: feature.id, name: "rampa hidráulica" });

    expect((await request("/vehicle-features/9999", "PATCH", { name: "inexistente" }, office)).status).toBe(404);

    const listed = await request("/vehicle-features", "GET", undefined, office);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      features: [{ id: feature.id, name: "rampa hidráulica", createdAt: feature.createdAt }],
    });

    const log = await migrationPool.query(
      "SELECT action, before_data, after_data FROM change_log WHERE entity = 'vehicle_feature' ORDER BY id",
    );
    expect(log.rows).toEqual([
      { action: "created", before_data: null, after_data: { name: "rampa para silla de ruedas" } },
      { action: "updated", before_data: { name: "rampa para silla de ruedas" }, after_data: { name: "rampa hidráulica" } },
    ]);

    await migrationPool.query("REVOKE INSERT ON change_log FROM traslado_app");
    let withoutLog: Response;
    try {
      withoutLog = await request("/vehicle-features", "POST", { name: "cinturón postural" }, office);
    } finally {
      await migrationPool.query("GRANT INSERT ON change_log TO traslado_app");
    }
    expect(withoutLog!.status).toBe(500);
    const count = await migrationPool.query("SELECT count(*)::int AS count FROM vehicle_features");
    expect(count.rows[0].count).toBe(1);
  });
});

describe("Vehículos", () => {
  it("creates, edits and deactivates Vehículos with seats, front: 1, Adaptaciones and transactional change log", async () => {
    const { cookie: driver } = await signIn("driver-veh", "driver");
    const { cookie: office } = await signIn("office-veh", "office");

    const rampRes = await request("/vehicle-features", "POST", { name: "rampa para silla de ruedas" }, office);
    const beltRes = await request("/vehicle-features", "POST", { name: "cinturón postural" }, office);
    const rampId = (await rampRes.json()).feature.id as number;
    const beltId = (await beltRes.json()).feature.id as number;

    expect((await request("/vehicles", "GET")).status).toBe(401);
    expect((await request("/vehicles", "POST", { plate: "AA101BB", model: "Furgón Chico", seats: 5, featureIds: [] })).status).toBe(401);
    expect((await request("/vehicles", "GET", undefined, driver)).status).toBe(403);
    expect((await request("/vehicles", "POST", { plate: "AA101BB", model: "Furgón Chico", seats: 5, featureIds: [] }, driver)).status).toBe(403);
    expect((await request("/vehicles/1", "PATCH", { plate: "AA101BB", model: "Furgón Chico", seats: 5, featureIds: [] }, driver)).status).toBe(403);
    expect((await request("/vehicles/1/deactivate", "PATCH", {}, driver)).status).toBe(403);

    // Rule 2 & Rule 7: seats must be a positive integer; front must be 1 if supplied; featureIds must exist
    for (const invalid of [
      { plate: "", model: "Furgón", seats: 5, featureIds: [] },
      { plate: "AA101BB", model: "   ", seats: 5, featureIds: [] },
      { plate: "AA101BB", model: "Furgón", seats: 0, featureIds: [] },
      { plate: "AA101BB", model: "Furgón", seats: -3, featureIds: [] },
      { plate: "AA101BB", model: "Furgón", seats: 5.5, featureIds: [] },
      { plate: "AA101BB", model: "Furgón", seats: "5", featureIds: [] },
      { plate: "AA101BB", model: "Furgón", seats: 5, front: 0, featureIds: [] },
      { plate: "AA101BB", model: "Furgón", seats: 5, front: 2, featureIds: [] },
      { plate: "AA101BB", model: "Furgón", seats: 5, featureIds: [99999] },
      { plate: "AA101BB", model: "Furgón", seats: 5, featureIds: "not-an-array" },
    ]) {
      const response = await request("/vehicles", "POST", invalid, office);
      expect(response.status, JSON.stringify(invalid)).toBe(400);
    }

    // Small van (5 seats) with front: 1 and one Adaptación
    const smallCreated = await request("/vehicles", "POST", {
      plate: " aa101bb ",
      model: "Furgón Sintético Chico",
      seats: 5,
      featureIds: [rampId],
    }, office);
    expect(smallCreated.status).toBe(201);
    const small = (await smallCreated.json()).vehicle;
    expect(small).toEqual({
      id: expect.any(Number),
      plate: "AA101BB",
      model: "Furgón Sintético Chico",
      seats: 5,
      front: 1,
      capacity: { seats: 5, front: 1 },
      featureIds: [rampId],
      features: ["rampa para silla de ruedas"],
      deactivatedAt: null,
      createdAt: expect.any(String),
    });

    // Rule 7 compatibility with @traslado/shared isCapacityExceeded
    expect(isCapacityExceeded({ seats: 5, front: 1 }, small.capacity)).toBe(false);
    expect(isCapacityExceeded({ seats: 2, front: 2 }, small.capacity)).toBe(true);

    // Rule 1: A plate cannot be used by two active Vehículos
    const duplicateActive = await request("/vehicles", "POST", {
      plate: "aa101bb",
      model: "Otro Furgón",
      seats: 8,
      featureIds: [],
    }, office);
    expect(duplicateActive.status).toBe(409);

    // Big van (12 seats)
    const bigCreated = await request("/vehicles", "POST", {
      plate: "BB202CC",
      model: "Combi Sintética Grande",
      seats: 12,
      front: 1,
      featureIds: [rampId, beltId],
    }, office);
    expect(bigCreated.status).toBe(201);
    const big = (await bigCreated.json()).vehicle;

    // Editing big van onto small van's active plate is rejected with 409
    const duplicateOnEdit = await request(`/vehicles/${big.id}`, "PATCH", {
      plate: "AA101BB",
      model: "Combi Sintética Grande",
      seats: 12,
      featureIds: [rampId, beltId],
    }, office);
    expect(duplicateOnEdit.status).toBe(409);

    // Edit small van (seats, model, Adaptaciones)
    const editedRes = await request(`/vehicles/${small.id}`, "PATCH", {
      plate: "AA101BB",
      model: "Furgón Sintético Chico v2",
      seats: 6,
      featureIds: [beltId],
    }, office);
    expect(editedRes.status).toBe(200);
    expect((await editedRes.json()).vehicle).toMatchObject({
      id: small.id,
      plate: "AA101BB",
      model: "Furgón Sintético Chico v2",
      seats: 6,
      front: 1,
      capacity: { seats: 6, front: 1 },
      featureIds: [beltId],
      features: ["cinturón postural"],
    });

    // Deactivate small van, then reuse its plate on a new active Vehículo (Rule 1)
    expect((await request(`/vehicles/${small.id}/deactivate`, "PATCH", {}, office)).status).toBe(204);
    expect((await request(`/vehicles/${small.id}/deactivate`, "PATCH", {}, office)).status).toBe(204);
    expect((await request("/vehicles/99999/deactivate", "PATCH", {}, office)).status).toBe(404);

    const reusedPlate = await request("/vehicles", "POST", {
      plate: "AA101BB",
      model: "Reemplazo Sintético",
      seats: 9,
      featureIds: [],
    }, office);
    expect(reusedPlate.status).toBe(201);

    const listed = await request("/vehicles", "GET", undefined, office);
    expect(listed.status).toBe(200);
    const vehicles = (await listed.json()).vehicles as Array<{ id: number; deactivatedAt: string | null }>;
    expect(vehicles).toHaveLength(3);
    expect(vehicles.find((v) => v.id === small.id)?.deactivatedAt).toEqual(expect.any(String));

    // Verify DB check constraint on seats > 0 and front = 1
    await expect(
      appPool.query("INSERT INTO vehicles (plate, model, seats, front_seats) VALUES ('ZZ999ZZ', 'Direct', 0, 1)"),
    ).rejects.toThrow(/check constraint/i);

    // Verify change_log entries and transactional rollback
    const log = await migrationPool.query(
      "SELECT action FROM change_log WHERE entity = 'vehicle' ORDER BY id",
    );
    expect(log.rows.map((r) => r.action)).toEqual(["created", "created", "updated", "deactivated", "created"]);

    await migrationPool.query("REVOKE INSERT ON change_log FROM traslado_app");
    let withoutLog: Response;
    try {
      withoutLog = await request("/vehicles", "POST", { plate: "CC303DD", model: "Sin Log", seats: 5, featureIds: [] }, office);
    } finally {
      await migrationPool.query("GRANT INSERT ON change_log TO traslado_app");
    }
    expect(withoutLog!.status).toBe(500);
    const rolledBack = await migrationPool.query("SELECT id FROM vehicles WHERE plate = 'CC303DD'");
    expect(rolledBack.rows).toEqual([]);
  });
});

describe("Choferes", () => {
  it("links each Chofer 1:1 to a driver user, requires home address and pin visible only to Oficina, validates usual Vehículo and logs writes", async () => {
    const { cookie: driverCookie, user: driverUser1 } = await signIn("chofer-uno", "driver");
    const driverUser2 = await seedUser("chofer-dos", "driver");
    const { cookie: officeCookie, user: officeUser } = await signIn("oficina-choferes", "office");

    const activeVanRes = await request("/vehicles", "POST", {
      plate: "DD404EE",
      model: "Furgón Habitual",
      seats: 8,
      featureIds: [],
    }, officeCookie);
    const activeVan = (await activeVanRes.json()).vehicle as { id: number; plate: string };

    const inactiveVanRes = await request("/vehicles", "POST", {
      plate: "EE505FF",
      model: "Furgón Inactivo",
      seats: 5,
      featureIds: [],
    }, officeCookie);
    const inactiveVan = (await inactiveVanRes.json()).vehicle as { id: number };
    await request(`/vehicles/${inactiveVan.id}/deactivate`, "PATCH", {}, officeCookie);

    const validDriver = {
      userId: driverUser1.id,
      name: "Chofer Sintético Uno",
      homeAddress: "Calle Inventada 101",
      homeLat: -26.8241,
      homeLng: -65.2036,
      usualVehicleId: activeVan.id,
    };

    // Rule 4: visible and writable only by Oficina
    expect((await request("/drivers", "GET")).status).toBe(401);
    expect((await request("/drivers", "POST", validDriver)).status).toBe(401);
    expect((await request("/drivers", "GET", undefined, driverCookie)).status).toBe(403);
    expect((await request("/drivers", "POST", validDriver, driverCookie)).status).toBe(403);
    expect((await request("/drivers/1", "PATCH", validDriver, driverCookie)).status).toBe(403);

    // Validation: home address, numeric coordinates in range, role = 'driver' (Rule 6), active usualVehicleId (Rule 5)
    for (const invalid of [
      { ...validDriver, name: "   " },
      { ...validDriver, homeAddress: "" },
      { ...validDriver, homeLat: 90.001 },
      { ...validDriver, homeLat: -90.001 },
      { ...validDriver, homeLng: 180.001 },
      { ...validDriver, homeLng: -180.001 },
      { ...validDriver, homeLat: "-26.8241" },
      { ...validDriver, homeLat: null },
      { ...validDriver, homeLng: undefined },
      { ...validDriver, userId: officeUser.id }, // Rule 6: office user cannot be linked directly as Chofer
      { ...validDriver, userId: 99999 },
      { ...validDriver, usualVehicleId: 99999 },
      { ...validDriver, usualVehicleId: inactiveVan.id }, // Deactivated vehicle cannot be set as usual
    ]) {
      const response = await request("/drivers", "POST", invalid, officeCookie);
      expect(response.status, JSON.stringify(invalid)).toBe(400);
    }

    // Create Chofer with usual Vehículo
    const createdRes = await request("/drivers", "POST", validDriver, officeCookie);
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()).driver;
    expect(created).toEqual({
      id: expect.any(Number),
      userId: driverUser1.id,
      username: "chofer-uno",
      name: "Chofer Sintético Uno",
      homeAddress: "Calle Inventada 101",
      homeLat: -26.8241,
      homeLng: -65.2036,
      usualVehicleId: activeVan.id,
      usualVehiclePlate: "DD404EE",
      createdAt: expect.any(String),
    });

    // Rule 3: A user can be linked to at most one Chofer
    const duplicateUser = await request("/drivers", "POST", {
      ...validDriver,
      name: "Chofer Duplicado",
    }, officeCookie);
    expect(duplicateUser.status).toBe(409);

    // Optional usualVehicleId (replacement driver without dedicated van)
    const secondRes = await request("/drivers", "POST", {
      userId: driverUser2.id,
      name: "Chofer Sintético Reemplazo",
      homeAddress: "Pasaje de Prueba 202",
      homeLat: -26.83,
      homeLng: -65.21,
      usualVehicleId: null,
    }, officeCookie);
    expect(secondRes.status).toBe(201);
    const second = (await secondRes.json()).driver;
    expect(second).toMatchObject({
      userId: driverUser2.id,
      username: "chofer-dos",
      usualVehicleId: null,
      usualVehiclePlate: null,
    });

    // Edit Chofer (home address, pin, usualVehicleId); cannot relink userId to another user
    expect((await request(`/drivers/${created.id}`, "PATCH", {
      userId: driverUser2.id,
      name: "Intento Relink",
      homeAddress: "Calle Inventada 101",
      homeLat: -26.8241,
      homeLng: -65.2036,
      usualVehicleId: null,
    }, officeCookie)).status).toBe(400);

    const editedRes = await request(`/drivers/${created.id}`, "PATCH", {
      name: "Chofer Sintético Uno Editado",
      homeAddress: "Avenida Sintetica 303",
      homeLat: -26.81,
      homeLng: -65.19,
      usualVehicleId: null,
    }, officeCookie);
    expect(editedRes.status).toBe(200);
    expect((await editedRes.json()).driver).toMatchObject({
      id: created.id,
      userId: driverUser1.id,
      name: "Chofer Sintético Uno Editado",
      homeAddress: "Avenida Sintetica 303",
      homeLat: -26.81,
      homeLng: -65.19,
      usualVehicleId: null,
      usualVehiclePlate: null,
    });

    expect((await request("/drivers/99999", "PATCH", {
      name: "No Existe",
      homeAddress: "Avenida Sintetica 303",
      homeLat: -26.81,
      homeLng: -65.19,
      usualVehicleId: null,
    }, officeCookie)).status).toBe(404);

    // Driver still cannot read /drivers or see homeAddress/pin via /auth/me
    expect((await request("/drivers", "GET", undefined, driverCookie)).status).toBe(403);
    const meJson = await (await request("/auth/me", "GET", undefined, driverCookie)).json();
    expect(JSON.stringify(meJson)).not.toContain("Avenida Sintetica");
    expect(JSON.stringify(meJson)).not.toContain("-26.81");

    const listed = await request("/drivers", "GET", undefined, officeCookie);
    expect(listed.status).toBe(200);
    expect((await listed.json()).drivers).toHaveLength(2);

    // DB coordinate check constraints
    await expect(
      appPool.query(
        "INSERT INTO drivers (user_id, name, home_address, home_latitude, home_longitude) VALUES ($1, 'Direct', 'Calle', 95, 0)",
        [driverUser1.id],
      ),
    ).rejects.toThrow(/check constraint/i);

    // Change log & transactional rollback
    const log = await migrationPool.query(
      "SELECT action FROM change_log WHERE entity = 'driver' ORDER BY id",
    );
    expect(log.rows.map((r) => r.action)).toEqual(["created", "created", "updated"]);

    const driverUser3 = await seedUser("chofer-tres", "driver");
    await migrationPool.query("REVOKE INSERT ON change_log FROM traslado_app");
    let withoutLog: Response;
    try {
      withoutLog = await request("/drivers", "POST", {
        ...validDriver,
        userId: driverUser3.id,
        name: "Chofer Sin Log",
      }, officeCookie);
    } finally {
      await migrationPool.query("GRANT INSERT ON change_log TO traslado_app");
    }
    expect(withoutLog!.status).toBe(500);
    const rolledBack = await migrationPool.query("SELECT id FROM drivers WHERE user_id = $1", [driverUser3.id]);
    expect(rolledBack.rows).toEqual([]);
  });
});
