import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Router, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };

type Point = { lat: number; lng: number };
const key = (point: Point) => `${point.lat},${point.lng}`;
// Stand-in for OSRM: 1 m per 0.00001 degree of lat plus lng, at 10 m/s, plus the extra metres of a one-way detour.
const oneWayExtra = new Map<string, number>();
const routerCalls: string[][] = [];
let routingDown = false;
const fakeRouter: Router = async (points) => {
  routerCalls.push(points.map(key));
  if (routingDown) throw new Error("OSRM is down");
  return points.slice(1).map((to, index) => {
    const from = points[index];
    const meters = Math.round((Math.abs(from.lat - to.lat) + Math.abs(from.lng - to.lng)) * 100000)
      + (oneWayExtra.get(`${key(from)}>${key(to)}`) ?? 0);
    return { distanceMeters: meters, durationSeconds: meters / 10 };
  });
};
const app = createApp({ db: appPool, routing: routingUp, router: fakeRouter, config: { serverEpoch: "publication-test" } });

const DAY = "2026-11-02";
// Synthetic places only: home H, a second home H2, the school D and a therapy centre T.
const H = { lat: -26.83, lng: -65.21 };
const H2 = { lat: -26.84, lng: -65.22 };
const D = { lat: -26.82, lng: -65.2 };

beforeEach(() => {
  oneWayExtra.clear();
  routerCalls.length = 0;
  routingDown = false;
});

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

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
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
    [username, await hashPassword(`${username}-password`), role],
  );
  return Number(result.rows[0].id);
}

async function ok(response: Response | Promise<Response>, status = 201) {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return await resolved.json();
}

async function refused(response: Response | Promise<Response>, status: number) {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return await resolved.json();
}

async function stored(sql: string, values: unknown[] = []) {
  return (await migrationPool.query(sql, values)).rows;
}

/** An Oficina session with one Plan diario, the school D and helpers to add Pasajeros, Choferes, Recorridos and Traslados. */
async function setup(name: string) {
  const officeId = await seedUser(`oficina-${name}`, "office");
  const office = (await signInOffice(app, migrationPool, `oficina-${name}`, `oficina-${name}-password`)).cookie;
  const post = async (path: string, body: unknown, status = 201) => await ok(request(path, "POST", body, office), status);
  const destination = async (place: Point, label: string) =>
    (await post("/destinations", { name: label, kind: "school", address: "Avenida Sintetica 303", ...place })).destination.id as number;
  const school = await destination(D, `Escuela ${name}`);
  let plates = 0;
  const vehicle = async () =>
    (await post("/vehicles", { plate: `${name.slice(0, 3).toUpperCase()}${String(++plates).padStart(3, "0")}`, model: "Furgón Sintético", seats: 8 })).vehicle.id as number;
  let drivers = 0;
  const driver = async (usualVehicleId: number) => {
    const username = `chofer-${name}-${++drivers}`;
    const userId = await seedUser(username, "driver");
    return (await post("/drivers", {
      userId, name: `Chofer ${username}`, homeAddress: "Pasaje de Prueba 202", homeLat: -26.85, homeLng: -65.23, usualVehicleId,
    })).driver.id as number;
  };
  // Each Pasajero gets a Consentimiento, which a Traslado needs before it can be assigned to a Recorrido.
  const passenger = async (overrides: Record<string, unknown> = {}, home: Point = H) => {
    const id = (await post("/passengers", {
      name: `Pasajero Sintético ${name}`, homeAddress: "Calle Inventada 101", homeLat: home.lat, homeLng: home.lng,
      companions: 1, frontSeat: false, wheelchair: false, maxRideTimeMinutes: 60, pickupDurationMinutes: 5, dropoffDurationMinutes: 5,
      ...overrides,
    })).passenger.id as number;
    const signer = (await post(`/passengers/${id}/authorized-adults`, {
      name: "Madre Sintética", dni: "-1000001", relation: "madre", phone: "381-000-0001", legalGuardian: true,
    })).adult.id as number;
    await post(`/passengers/${id}/consent`, { signedByAdultId: signer, signedAt: "2026-10-01", otherAdultAllowed: false });
    return id;
  };
  await post("/daily-plans", { date: DAY });
  const route = async (driverId: number, startTime: string, endTime: string, vehicleId?: number) =>
    (await post(`/daily-plans/${DAY}/routes`, { driverId, startTime, endTime, ...(vehicleId ? { vehicleId } : {}) })).route.id as number;
  const transfer = async (passengerId: number, targetTime: string, routeId: number | null, extra: Record<string, unknown> = {}) => {
    const created = (await post(`/daily-plans/${DAY}/transfers`, {
      passengerId, direction: "entrada", destinationId: school, targetTime, ...extra,
    })).transfer.id as number;
    if (routeId !== null) await ok(request(`/transfers/${created}`, "PATCH", { routeId }, office), 200);
    return created;
  };
  const publish = (routeId: number, body: unknown = {}) => request(`/routes/${routeId}/publish`, "POST", body, office);
  const versions = async (routeId: number) => (await ok(request(`/routes/${routeId}/versions`, "GET", undefined, office), 200)).versions;
  const day = async () => await ok(request(`/daily-plans/${DAY}`, "GET", undefined, office), 200);
  return { office, officeId, school, destination, vehicle, driver, passenger, route, transfer, publish, versions, day };
}

describe("Publication and Versiones del plan", () => {
  it("publishes a Recorrido as Versión del plan 1 from OSRM legs and the validator, recording who published it", async () => {
    const { officeId, vehicle, driver, passenger, route, transfer, publish, versions, day } = await setup("ac1");
    const vehicleId = await vehicle();
    const driverId = await driver(vehicleId);
    const recorrido = await route(driverId, "07:00", "09:00");
    const item = await transfer(await passenger(), "08:00", recorrido);
    expect((await day()).routes[0]).toMatchObject({ status: "borrador", version: null, km: null });

    const published = await ok(publish(recorrido));
    expect(published).toEqual({
      version: {
        routeId: recorrido, version: 1, vehicleId, vehiclePlate: "AC1001", driverId, startTime: "07:00", endTime: "09:00",
        publishedAt: expect.any(String), publishedBy: officeId, overrideReason: null, violations: [],
        // The first Parada starts the Recorrido; the drop-off lands on the 08:00 target after 5 min pickup and 200 s.
        legs: [
          { position: 1, transferId: item, kind: "pickup", distanceMeters: 0, durationSeconds: 0, plannedTime: "07:51" },
          { position: 2, transferId: item, kind: "dropoff", distanceMeters: 2000, durationSeconds: 200, plannedTime: "08:00" },
        ],
        transfers: [{ transferId: item, companions: 1, directDistanceMeters: 2000, plannedRideMeters: 2000 }],
      },
      cascade: [],
      warnings: [],
    });
    expect(Number.isNaN(Date.parse(published.version.publishedAt))).toBe(false);
    expect(routerCalls).toEqual([[key(H), key(D)], [key(H), key(D)]]);
    expect(await versions(recorrido)).toEqual([published.version]);
    expect((await day()).routes[0]).toMatchObject({ status: "publicado", version: 1, km: 2 });
    expect(await stored("SELECT entity_id, action, before_data, after_data FROM change_log WHERE action = 'published'")).toEqual([{
      entity_id: String(recorrido), action: "published", before_data: { version: null, status: "borrador" },
      after_data: { version: 1, status: "publicado", vehicleId, overrideReason: null, violations: [] },
    }]);

    // OSRM down: nothing is published.
    const other = await route(await driver(await vehicle()), "10:00", "11:00");
    await transfer(await passenger(), "10:30", other);
    routingDown = true;
    expect(await refused(publish(other), 502)).toEqual({ error: "Routing is unavailable: try publishing again" });
    expect(await stored("SELECT route_id FROM plan_versions")).toEqual([{ route_id: recorrido }]);
    expect((await day()).routes[1]).toMatchObject({ id: other, status: "borrador", version: null });
  });

  it("refuses a publication with violations unless the planner writes a non-empty reason, shown per Pasajero", async () => {
    const { vehicle, driver, passenger, route, transfer, publish, versions } = await setup("regla1");
    const recorrido = await route(await driver(await vehicle()), "07:00", "09:00");
    // 5 min pickup + 200 s + 5 min drop-off is more than this Pasajero's 5 minutes on board.
    const passengerId = await passenger({ maxRideTimeMinutes: 5 });
    const item = await transfer(passengerId, "08:00", recorrido);
    const expected = {
      error: "The Recorrido breaks limits: fix it or publish it with a reason",
      violations: [{
        passengerId, passengerName: "Pasajero Sintético regla1",
        violations: [{ rule: "max_ride_time_exceeded", transferId: item, message: expect.stringContaining("exceeds maximum (5 min)") }],
      }],
    };
    expect(await refused(publish(recorrido), 409)).toEqual(expected);
    expect(await refused(publish(recorrido, { overrideReason: "   " }), 409)).toEqual(expected);
    expect(await refused(publish(recorrido, { overrideReason: 7 }), 400)).toEqual({ error: "Invalid request" });
    expect(await stored("SELECT id FROM plan_versions")).toEqual([]);
    expect(await stored("SELECT id FROM change_log WHERE action = 'published'")).toEqual([]);

    const forced = await ok(publish(recorrido, { overrideReason: "  La familia pidió el horario igual  " }));
    expect(forced.version).toMatchObject({ version: 1, overrideReason: "La familia pidió el horario igual", violations: expected.violations });
    expect(await stored("SELECT override_reason FROM plan_versions")).toEqual([{ override_reason: "La familia pidió el horario igual" }]);
    expect(await versions(recorrido)).toHaveLength(1);
  });

  it("refuses to force a Recorrido when any violation is a Traslado unserved", async () => {
    const { vehicle, driver, passenger, route, transfer, publish } = await setup("regla2");
    const recorrido = await route(await driver(await vehicle()), "07:00", "09:00");
    await transfer(await passenger(), "08:00", recorrido);
    const unserved = await transfer(await passenger({}, H2), "08:00", recorrido);
    // A Traslado whose drop-off is missing from the Recorrido is left unserved.
    await migrationPool.query("DELETE FROM stops WHERE transfer_id = $1 AND kind = 'dropoff'", [unserved]);

    const answer = await refused(publish(recorrido, { overrideReason: "Lo resolvemos por teléfono" }), 409);
    expect(answer.error).toBe("A Recorrido that leaves a Traslado unserved is never published, even forced");
    expect(answer.violations.flatMap((group: { violations: { rule: string; transferId: number }[] }) => group.violations))
      .toContainEqual({ rule: "unserved_transfer", transferId: unserved, message: expect.any(String) });
    expect(await stored("SELECT id FROM plan_versions")).toEqual([]);
    expect(await stored("SELECT status FROM routes")).toEqual([{ status: "borrador" }]);
  });

  it("never edits a published version: a change publishes the next version, and so does each later publication", async () => {
    const { vehicle, driver, passenger, route, transfer, publish, versions, day } = await setup("regla3");
    const recorrido = await route(await driver(await vehicle()), "07:00", "09:00");
    await transfer(await passenger(), "08:00", recorrido);
    const first = (await ok(publish(recorrido))).version;
    for (const sql of [
      "UPDATE plan_versions SET override_reason = 'cambiado'",
      "DELETE FROM plan_versions",
      "UPDATE plan_version_legs SET distance_meters = 1",
      "DELETE FROM plan_version_legs",
      "UPDATE plan_version_transfers SET direct_distance_meters = 1",
      "DELETE FROM plan_version_transfers",
    ]) await expect(appPool.query(sql), sql).rejects.toMatchObject({ code: "42501" });

    await transfer(await passenger({}, H2), "08:30", recorrido);
    const second = await ok(publish(recorrido));
    expect(second.version).toMatchObject({ version: 2 });
    expect(second.version.legs).toHaveLength(4);
    expect(await versions(recorrido)).toEqual([first, second.version]);
    expect((await day()).routes[0]).toMatchObject({ status: "publicado", version: 2 });

    const again = await ok(publish(recorrido));
    expect(again.version).toMatchObject({ version: 3, legs: second.version.legs, transfers: second.version.transfers });
    expect(await versions(recorrido)).toEqual([first, second.version, again.version]);
    expect(await stored("SELECT version FROM plan_versions ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(await stored("SELECT id FROM change_log WHERE action = 'published'")).toHaveLength(3);
  });

  it("publishes the whole Plan diario the evening before; morning and 15:00 changes are new versions of the affected Recorridos", async () => {
    const { vehicle, driver, passenger, route, transfer, office } = await setup("regla4");
    const morning = await route(await driver(await vehicle()), "07:00", "09:00");
    const afternoon = await route(await driver(await vehicle()), "16:00", "18:00");
    const passengerId = await passenger();
    await transfer(passengerId, "08:00", morning);
    await transfer(passengerId, "17:00", afternoon);
    const publishDay = () => ok(request(`/daily-plans/${DAY}/publish`, "POST", undefined, office), 200);

    expect(await publishDay()).toEqual({
      published: [{ routeId: morning, version: 1 }, { routeId: afternoon, version: 1 }], unchanged: [], failed: [], cascade: [], warnings: [],
    });
    // Morning adjustment: a Traslado joins the morning Recorrido.
    await transfer(await passenger({}, H2), "08:30", morning);
    expect(await publishDay()).toEqual({ published: [{ routeId: morning, version: 2 }], unchanged: [afternoon], failed: [], cascade: [], warnings: [] });
    // 15:00 rebuild for an afternoon entry.
    await transfer(await passenger({}, H2), "17:30", afternoon);
    expect(await publishDay()).toEqual({ published: [{ routeId: afternoon, version: 2 }], unchanged: [morning], failed: [], cascade: [], warnings: [] });
    expect(await stored("SELECT route_id, version FROM plan_versions ORDER BY id")).toEqual([
      { route_id: morning, version: 1 }, { route_id: afternoon, version: 1 }, { route_id: morning, version: 2 }, { route_id: afternoon, version: 2 },
    ]);
  });

  it("republishes from the whole Plan diario a Recorrido whose Pasajero moved home or changed a limit", async () => {
    const { vehicle, driver, passenger, route, transfer, office, versions } = await setup("regla4-pasajero");
    const routeId = await route(await driver(await vehicle()), "07:00", "09:00");
    const input = {
      name: "Pasajero Sintético regla4-pasajero", homeAddress: "Calle Inventada 101", homeLat: H.lat, homeLng: H.lng,
      companions: 1, frontSeat: false, wheelchair: false, maxRideTimeMinutes: 60, pickupDurationMinutes: 5, dropoffDurationMinutes: 5,
    };
    const passengerId = await passenger();
    await transfer(passengerId, "08:00", routeId);
    const publishDay = () => ok(request(`/daily-plans/${DAY}/publish`, "POST", undefined, office), 200);
    const editPassenger = (changes: Record<string, unknown>) =>
      ok(request(`/passengers/${passengerId}`, "PATCH", { ...input, ...changes }, office), 200);
    expect((await publishDay()).published).toEqual([{ routeId, version: 1 }]);

    // A new home moves the Paradas: new legs and a new Distancia directa.
    await editPassenger({ homeLat: H2.lat, homeLng: H2.lng });
    expect(await publishDay()).toEqual({ published: [{ routeId, version: 2 }], unchanged: [], failed: [], cascade: [], warnings: [] });
    const [moved, first] = await versions(routeId);
    expect(moved.transfers[0].directDistanceMeters).not.toBe(first.transfers[0].directDistanceMeters);
    // A longer pickup changes the planned times; a shorter ride limit changes what the validator checks.
    await editPassenger({ homeLat: H2.lat, homeLng: H2.lng, pickupDurationMinutes: 9 });
    expect((await publishDay()).published).toEqual([{ routeId, version: 3 }]);
    await editPassenger({ homeLat: H2.lat, homeLng: H2.lng, pickupDurationMinutes: 9, maxRideTimeMinutes: 50 });
    expect((await publishDay()).published).toEqual([{ routeId, version: 4 }]);
    // Nothing changed since: it keeps version 4.
    expect(await publishDay()).toEqual({ published: [], unchanged: [routeId], failed: [], cascade: [], warnings: [] });
  });

  it("publishes each Recorrido of the day in its own transaction and summarizes the ones that failed the validator", async () => {
    const { vehicle, driver, passenger, route, transfer, office } = await setup("lote");
    const fine = await route(await driver(await vehicle()), "07:00", "09:00");
    const failing = await route(await driver(await vehicle()), "07:00", "09:00");
    await transfer(await passenger(), "08:00", fine);
    const strict = await passenger({ maxRideTimeMinutes: 5 });
    const item = await transfer(strict, "08:00", failing);

    const summary = await ok(request(`/daily-plans/${DAY}/publish`, "POST", undefined, office), 200);
    expect(summary).toEqual({
      published: [{ routeId: fine, version: 1 }],
      unchanged: [],
      failed: [{
        routeId: failing,
        error: "The Recorrido breaks limits: fix it or publish it with a reason",
        violations: [{ passengerId: strict, passengerName: "Pasajero Sintético lote", violations: [
          { rule: "max_ride_time_exceeded", transferId: item, message: expect.any(String) },
        ] }],
      }],
      cascade: [],
      warnings: [],
    });
    expect(await stored("SELECT route_id FROM plan_versions")).toEqual([{ route_id: fine }]);
    expect(await stored("SELECT id, status FROM routes ORDER BY id")).toEqual([{ id: fine, status: "publicado" }, { id: failing, status: "borrador" }]);
    expect(await refused(request("/daily-plans/2026-12-31/publish", "POST", undefined, office), 404)).toEqual({ error: "Plan diario not found" });
  });

  it("records the Vehículo of each Versión del plan", async () => {
    const { vehicle, driver, passenger, route, transfer, publish, versions, office } = await setup("regla5");
    const usual = await vehicle();
    const replacement = await vehicle();
    const recorrido = await route(await driver(usual), "07:00", "09:00");
    await transfer(await passenger(), "08:00", recorrido);
    await ok(publish(recorrido));
    await ok(request(`/routes/${recorrido}`, "PATCH", { vehicleId: replacement }, office), 200);
    await ok(publish(recorrido));

    expect((await versions(recorrido)).map((item: { version: number; vehicleId: number; vehiclePlate: string }) =>
      [item.version, item.vehicleId, item.vehiclePlate])).toEqual([[1, usual, "REG001"], [2, replacement, "REG002"]]);
    expect(await stored("SELECT version, vehicle_id FROM plan_versions ORDER BY version")).toEqual([
      { version: 1, vehicle_id: usual }, { version: 2, vehicle_id: replacement },
    ]);
  });

  it("rejects a publication that puts the same Vehículo or Chofer in two published Recorridos overlapping in time", async () => {
    const { vehicle, driver, passenger, route, transfer, publish } = await setup("regla6");
    const van = await vehicle();
    const otherVan = await vehicle();
    const chofer = await driver(van);
    const otherChofer = await driver(otherVan);
    const passengerId = await passenger();
    const published = await route(chofer, "07:00", "09:00");
    await transfer(passengerId, "08:00", published);
    await ok(publish(published));

    const sameVan = await route(otherChofer, "08:00", "10:00", van);
    await transfer(passengerId, "09:30", sameVan);
    expect(await refused(publish(sameVan), 409)).toEqual({ error: "The Vehículo is in another published Recorrido at the same time" });
    const sameChofer = await route(chofer, "08:30", "09:30", otherVan);
    await transfer(passengerId, "09:15", sameChofer);
    expect(await refused(publish(sameChofer), 409)).toEqual({ error: "The Chofer is in another published Recorrido at the same time" });
    expect(await stored("SELECT route_id FROM plan_versions")).toEqual([{ route_id: published }]);

    // A Recorrido that starts when the other ends does not overlap it.
    const after = await route(chofer, "09:00", "10:00");
    await transfer(passengerId, "09:45", after);
    expect((await ok(publish(after))).version.version).toBe(1);
  });

  it("revalidates the Chofer's chained next Recorrido when one changes and warns the Oficina, never republishing it", async () => {
    const { vehicle, driver, passenger, route, transfer, publish, versions, destination } = await setup("regla7");
    const chofer = await driver(await vehicle());
    const k = await route(chofer, "07:00", "08:00");
    const next = await route(chofer, "08:10", "09:00");
    await transfer(await passenger(), "07:30", k);
    await transfer(await passenger({}, H2), "08:20", next);
    await ok(publish(next));

    // k ends at its drop-off at D (07:35) and the Chofer reaches H2 at 07:41, before next's pickup at 08:08.
    const first = await ok(publish(k));
    expect(first.cascade).toEqual([{ routeId: next, version: 1, fromRouteId: k, ok: true, problem: null }]);

    // A far drop-off at 08:00 makes k end at D2, 13 minutes away from H2.
    const farSchool = await destination({ lat: -26.8, lng: -65.18 }, "Escuela lejana");
    await transfer(await passenger(), "08:00", k, { destinationId: farSchool });
    const changed = await ok(publish(k));
    expect(changed.version.version).toBe(2);
    expect(changed.cascade).toEqual([{
      routeId: next, version: 1, fromRouteId: k, ok: false,
      problem: "The Chofer reaches the first Parada at 08:11, after its planned 08:08",
    }]);
    expect(await versions(next)).toHaveLength(1);
    expect(await stored("SELECT entity_id, action, after_data FROM change_log WHERE action = 'cascade_revalidated' ORDER BY id")).toEqual([
      { entity_id: String(next), action: "cascade_revalidated", after_data: { version: 1, fromRouteId: k, fromVersion: 1, ok: true, problem: null } },
      { entity_id: String(next), action: "cascade_revalidated", after_data: {
        version: 1, fromRouteId: k, fromVersion: 2, ok: false, problem: "The Chofer reaches the first Parada at 08:11, after its planned 08:08",
      } },
    ]);
  });

  it("revalidates a chained Recorrido created by publishing the whole Plan diario", async () => {
    const { vehicle, driver, passenger, route, transfer, office } = await setup("regla7-batch");
    const van = await vehicle();
    const chofer = await driver(van);
    const first = await route(chofer, "07:00", "08:00");
    const next = await route(chofer, "08:10", "09:00");
    await transfer(await passenger(), "07:30", first);
    await transfer(await passenger({}, H2), "08:10", next);

    const published = await ok(request(`/daily-plans/${DAY}/publish`, "POST", undefined, office), 200);
    expect(published.published).toEqual([
      { routeId: first, version: 1 },
      { routeId: next, version: 1 },
    ]);
    expect(published.cascade).toEqual([
      expect.objectContaining({ routeId: next, fromRouteId: first, ok: true }),
    ]);
  });

  it("warns without blocking when the whole Plan diario publishes a chained pair the Chofer cannot reach", async () => {
    const { vehicle, driver, passenger, route, transfer, office, destination } = await setup("regla7-batch-late");
    const chofer = await driver(await vehicle());
    const first = await route(chofer, "07:00", "08:00");
    const next = await route(chofer, "08:10", "09:00");
    await transfer(await passenger(), "07:30", first);
    // A far drop-off at 08:00 makes first end at D2, 13 minutes away from next's pickup at H2 at 08:08.
    const farSchool = await destination({ lat: -26.8, lng: -65.18 }, "Escuela lejana");
    await transfer(await passenger(), "08:00", first, { destinationId: farSchool });
    await transfer(await passenger({}, H2), "08:20", next);

    expect(await ok(request(`/daily-plans/${DAY}/publish`, "POST", undefined, office), 200)).toEqual({
      published: [{ routeId: first, version: 1 }, { routeId: next, version: 1 }],
      unchanged: [],
      failed: [],
      cascade: [{
        routeId: next, version: 1, fromRouteId: first, ok: false,
        problem: "The Chofer reaches the first Parada at 08:11, after its planned 08:08",
      }],
      warnings: [],
    });
  });

  it("stores the Distancia directa home → Destino for an entrada and Destino → home for a salida, each direction on its own", async () => {
    const { vehicle, driver, passenger, route, transfer, publish, school } = await setup("regla8");
    // A one-way street makes the way back 700 m longer.
    oneWayExtra.set(`${key(D)}>${key(H)}`, 700);
    const recorrido = await route(await driver(await vehicle()), "07:00", "09:00");
    const passengerId = await passenger();
    const entrada = await transfer(passengerId, "08:00", recorrido);
    const salida = await transfer(passengerId, "08:10", recorrido, { direction: "salida", destinationId: school });

    const { version } = await ok(publish(recorrido));
    expect(version.transfers.map((item: { transferId: number; directDistanceMeters: number }) => [item.transferId, item.directDistanceMeters]))
      .toEqual([[entrada, 2000], [salida, 2700]]);
    expect(routerCalls).toContainEqual([key(H), key(D)]);
    expect(routerCalls).toContainEqual([key(D), key(H)]);
    expect(await stored("SELECT transfer_id, direct_distance_meters FROM plan_version_transfers ORDER BY transfer_id")).toEqual([
      { transfer_id: entrada, direct_distance_meters: 2000 }, { transfer_id: salida, direct_distance_meters: 2700 },
    ]);
  });

  it("keeps the legs as computed and derives the planned ride from them without calling it the km per Traslado", async () => {
    const { vehicle, driver, passenger, route, transfer, publish, versions, day, office } = await setup("regla9");
    const recorrido = await route(await driver(await vehicle()), "07:00", "09:00");
    const near = await transfer(await passenger(), "08:00", recorrido);
    const far = await transfer(await passenger({}, H2), "08:00", recorrido);
    const stops = (await day()).routes[0].stops.map((stop: { id: number }) => stop.id);
    // Shared order: pick up at H, then H2, then drop both at D.
    await ok(request(`/routes/${recorrido}/stops`, "PATCH", { stopIds: [stops[0], stops[2], stops[1], stops[3]] }, office), 200);

    await ok(publish(recorrido));
    const [version] = await versions(recorrido);
    expect(version.legs.map((leg: { distanceMeters: number; durationSeconds: number }) => [leg.distanceMeters, leg.durationSeconds]))
      .toEqual([[0, 0], [2000, 200], [4000, 400], [0, 0]]);
    expect(await stored("SELECT position, distance_meters, duration_seconds FROM plan_version_legs ORDER BY position")).toEqual([
      { position: 1, distance_meters: 0, duration_seconds: 0 },
      { position: 2, distance_meters: 2000, duration_seconds: 200 },
      { position: 3, distance_meters: 4000, duration_seconds: 400 },
      { position: 4, distance_meters: 0, duration_seconds: 0 },
    ]);
    expect(version.transfers).toEqual([
      { transferId: near, companions: 1, directDistanceMeters: 2000, plannedRideMeters: 6000 },
      { transferId: far, companions: 1, directDistanceMeters: 4000, plannedRideMeters: 4000 },
    ]);
    expect((await day()).routes[0].km).toBe(6);
  });

  it("measures the Distancia directa of an entrada that starts at another Destino from that Destino to the second one", async () => {
    const { vehicle, driver, passenger, route, transfer, publish, destination } = await setup("regla10");
    const therapy = await destination({ lat: -26.79, lng: -65.2 }, "Centro Terapéutico Sintético");
    const recorrido = await route(await driver(await vehicle()), "14:00", "16:00");
    const item = await transfer(await passenger(), "15:00", recorrido, { originDestinationId: therapy });

    const { version } = await ok(publish(recorrido));
    expect(version.transfers).toEqual([{ transferId: item, companions: 1, directDistanceMeters: 3000, plannedRideMeters: 3000 }]);
    expect(routerCalls).toEqual([["-26.79,-65.2", key(D)], ["-26.79,-65.2", key(D)]]);
  });

  it("lists in the day view the Traslados not Cancelado por Ausencia without a published Recorrido", async () => {
    const { vehicle, driver, passenger, route, transfer, publish, day, office } = await setup("vista");
    const chofer = await driver(await vehicle());
    const publishedRoute = await route(chofer, "07:00", "09:00");
    const draftRoute = await route(chofer, "10:00", "12:00");
    const passengerId = await passenger();
    const served = await transfer(passengerId, "08:00", publishedRoute);
    const inDraft = await transfer(passengerId, "11:00", draftRoute);
    const unassigned = await transfer(passengerId, "13:00", null);
    const absent = await transfer(passengerId, "14:00", null);
    await ok(request(`/transfers/${absent}/absence`, "POST", {}, office));
    expect((await day()).unpublishedTransferIds).toEqual([served, inDraft, unassigned]);

    await ok(publish(publishedRoute));
    const late = await transfer(passengerId, "08:30", publishedRoute);
    expect((await day()).unpublishedTransferIds).toEqual([late, inDraft, unassigned]);
  });

  it("lets only the Oficina publish and read Versiones del plan", async () => {
    await seedUser("chofer-publica", "driver");
    const chofer = getSessionCookie(await request("/auth/login", "POST", {
      username: "chofer-publica", password: "chofer-publica-password", deviceLabel: "Test browser",
    })).cookie;
    for (const [method, path] of [
      ["POST", "/routes/1/publish"],
      ["GET", "/routes/1/versions"],
      ["POST", `/daily-plans/${DAY}/publish`],
    ] as const) {
      const body = method === "POST" ? {} : undefined;
      expect((await request(path, method, body)).status, `${method} ${path} without session`).toBe(401);
      expect((await request(path, method, body, chofer)).status, `${method} ${path} as Chofer`).toBe(403);
    }
    expect(await stored("SELECT id FROM plan_versions")).toEqual([]);
  });
});
