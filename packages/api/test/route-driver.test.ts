import { afterAll, describe, expect, it } from "vitest";
import { createApp, type Router, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import type { VroomProblem, VroomSolver } from "../src/planner.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };

// Stand-in for OSRM: 1 m per 0.00001 degree of lat plus lng, at 10 m/s.
const fakeRouter: Router = async (points) => points.slice(1).map((to, index) => {
  const from = points[index];
  const meters = Math.round((Math.abs(from.lat - to.lat) + Math.abs(from.lng - to.lng)) * 100000);
  return { distanceMeters: meters, durationSeconds: meters / 10 };
});
// Stand-in for VROOM that only keeps the problem it was given: the order is never applied, so nothing else changes.
type Problem = { vehicles: { start?: number[]; end?: number[] }[] };
const problems: Problem[] = [];
const recordingSolver: VroomSolver = async (problem: VroomProblem) => {
  problems.push(problem as unknown as Problem);
  throw new Error("Recorded only");
};
const DAY = "2026-11-02";
// 09:00 of the Plan diario's day in Tucumán (UTC-3), so the Chofer app shows it as today.
const app = createApp({
  db: appPool,
  routing: routingUp,
  router: fakeRouter,
  solver: recordingSolver,
  travelTime: async () => 600,
  config: { serverEpoch: "route-driver-test", now: () => new Date("2026-11-02T12:00:00.000Z") },
});
// Synthetic places only: the Pasajero's home, the school and each Chofer's home.
const HOME_OF_PASSENGER = { lat: -26.83, lng: -65.21 };
const SCHOOL = { lat: -26.82, lng: -65.2 };
const HOMES = [{ lat: -26.85, lng: -65.23 }, { lat: -26.86, lng: -65.24 }, { lat: -26.87, lng: -65.25 }];

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

async function answer(response: Response | Promise<Response>, status: number) {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return await resolved.json();
}

async function seedUser(username: string, role: "office" | "driver") {
  const result = await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
    [username, await hashPassword(`${username}-password`), role],
  );
  return Number(result.rows[0].id);
}

async function routeChanges() {
  return (await migrationPool.query(
    "SELECT actor_user_id, entity_id, action, before_data, after_data FROM change_log WHERE entity = 'route' ORDER BY id",
  )).rows;
}

async function storedRoute(routeId: number) {
  return (await migrationPool.query(
    "SELECT driver_id, vehicle_id, status, start_kind, start_latitude, start_longitude, end_kind FROM routes WHERE id = $1",
    [routeId],
  )).rows[0];
}

/** An Oficina, a school, signed-in Choferes each with their own usual Vehículo and home, and helpers to plan the day. */
async function setup(name: string) {
  const officeId = await seedUser(`oficina-${name}`, "office");
  const office = (await signInOffice(app, migrationPool, `oficina-${name}`, `oficina-${name}-password`)).cookie;
  const call = (path: string, method: string, body?: unknown, status = 201) => answer(request(path, method, body, office), status);
  const destinationId = (await call("/destinations", "POST", {
    name: `Escuela ${name}`, kind: "school", address: "Avenida Sintetica 303", ...SCHOOL,
  })).destination.id as number;
  let drivers = 0;
  const chofer = async () => {
    const index = drivers++;
    const vehicleId = (await call("/vehicles", "POST", {
      plate: `${name.slice(0, 3).toUpperCase()}00${index}`, model: "Furgón Sintético", seats: 8,
    })).vehicle.id as number;
    const username = `chofer-${name}-${index}`;
    const userId = await seedUser(username, "driver");
    const home = HOMES[index];
    const driverId = (await call("/drivers", "POST", {
      userId, name: `Chofer Sintético ${index}`, homeAddress: "Pasaje de Prueba 202", homeLat: home.lat, homeLng: home.lng, usualVehicleId: vehicleId,
    })).driver.id as number;
    const login = await request("/auth/login", "POST", { username, password: `${username}-password`, deviceLabel: "Celular sintético" });
    expect(login.status).toBe(200);
    return { driverId, userId, vehicleId, home: [home.lng, home.lat], cookie: getSessionCookie(login).cookie };
  };
  await call("/daily-plans", "POST", { date: DAY });
  const route = async (driverId: number, startTime = "07:00", endTime = "09:00") =>
    (await call(`/daily-plans/${DAY}/routes`, "POST", { driverId, startTime, endTime })).route.id as number;
  // A Pasajero with a Consentimiento and one entrada to the school assigned to the Recorrido.
  const transfer = async (routeId: number, fields: Record<string, unknown> = {}, targetTime = "08:00") => {
    const passengerId = (await call("/passengers", "POST", {
      name: "Pasajero Sintético", homeAddress: "Calle Inventada 101", homeLat: HOME_OF_PASSENGER.lat, homeLng: HOME_OF_PASSENGER.lng,
      companions: 0, frontSeat: false, wheelchair: false, maxRideTimeMinutes: 60, pickupDurationMinutes: 5, dropoffDurationMinutes: 5,
      ...fields,
    })).passenger.id as number;
    const signer = (await call(`/passengers/${passengerId}/authorized-adults`, "POST", {
      name: "Madre Sintética", dni: "-1000001", relation: "madre", phone: "381-000-0001", legalGuardian: true,
    })).adult.id as number;
    await call(`/passengers/${passengerId}/consent`, "POST", { signedByAdultId: signer, signedAt: "2026-10-01", otherAdultAllowed: false });
    const transferId = (await call(`/daily-plans/${DAY}/transfers`, "POST", {
      passengerId, direction: "entrada", destinationId, targetTime,
    })).transfer.id as number;
    await call(`/transfers/${transferId}`, "PATCH", { routeId }, 200);
    return transferId;
  };
  const changeDriver = (routeId: number, driverId: unknown, status = 200) => call(`/routes/${routeId}`, "PATCH", { driverId }, status);
  return { office, officeId, call, chofer, route, transfer, changeDriver };
}

describe("changing the Chofer of a Recorrido", () => {
  it("Rule 1: changes the Chofer until the Recorrido is En curso, and a published one only with its next Versión del plan", async () => {
    const { call, chofer, route, transfer, changeDriver } = await setup("regla1");
    const first = await chofer();
    const second = await chofer();
    const routeId = await route(first.driverId);
    await transfer(routeId);
    await call(`/routes/${routeId}/publish`, "POST", {});
    const dayOf = async (cookie: string) =>
      (await answer(request(`/driver/days/${DAY}`, "GET", undefined, cookie), 200)).routes.map((item: { routeId: number; version: number }) =>
        [item.routeId, item.version]);

    const changed = await changeDriver(routeId, second.driverId);
    expect(changed.route).toMatchObject({ id: routeId, driverId: second.driverId, driverName: "Chofer Sintético 1", status: "publicado" });
    // The published Versión del plan is never edited: the first Chofer keeps it until the next one is published.
    const versions = async () => (await call(`/routes/${routeId}/versions`, "GET", undefined, 200)).versions
      .map((version: { version: number; driverId: number }) => [version.version, version.driverId]);
    expect(await versions()).toEqual([[1, first.driverId]]);
    expect((await call(`/daily-plans/${DAY}`, "GET", undefined, 200)).routes[0]).toMatchObject({ driverId: second.driverId, version: 1 });
    expect(await dayOf(first.cookie)).toEqual([[routeId, 1]]);
    expect(await dayOf(second.cookie)).toEqual([]);
    expect(await answer(request(`/driver/routes/${routeId}/acknowledgements`, "POST", { version: 1 }, second.cookie), 403))
      .toEqual({ error: "This Recorrido belongs to another Chofer" });

    expect((await call(`/routes/${routeId}/publish`, "POST", {})).version).toMatchObject({ version: 2, driverId: second.driverId });
    expect(await versions()).toEqual([[1, first.driverId], [2, second.driverId]]);
    expect(await dayOf(first.cookie)).toEqual([]);
    expect(await dayOf(second.cookie)).toEqual([[routeId, 2]]);
    await answer(request(`/driver/routes/${routeId}/acknowledgements`, "POST", { version: 2 }, second.cookie), 201);

    // En curso, or already Cerrado, the Recorrido keeps its Chofer and nothing is logged.
    for (const status of ["en_curso", "cerrado"]) {
      await migrationPool.query("UPDATE routes SET status = $2 WHERE id = $1", [routeId, status]);
      const logged = (await routeChanges()).length;
      expect(await changeDriver(routeId, first.driverId, 409), status).toEqual({ error: "A Recorrido En curso or Cerrado cannot change Chofer" });
      expect((await storedRoute(routeId)).driver_id).toBe(second.driverId);
      expect(await routeChanges()).toHaveLength(logged);
    }
  });

  it("Rule 2: keeps the Recorrido's Vehículo when the Chofer changes", async () => {
    const { call, chofer, route, changeDriver } = await setup("regla2");
    const first = await chofer();
    const second = await chofer();
    const routeId = await route(first.driverId);
    expect((await changeDriver(routeId, second.driverId)).route).toMatchObject({ driverId: second.driverId, vehicleId: first.vehicleId });
    expect(await storedRoute(routeId)).toMatchObject({ driver_id: second.driverId, vehicle_id: first.vehicleId });
    // The Oficina changes the Vehículo apart.
    const vehicle = await call(`/routes/${routeId}`, "PATCH", { vehicleId: second.vehicleId }, 200);
    expect(vehicle.route).toMatchObject({ driverId: second.driverId, vehicleId: second.vehicleId });
  });

  it("Rule 3: refuses a deactivated Chofer or one with another overlapping Recorrido that day, naming the reason", async () => {
    const { chofer, route, changeDriver } = await setup("regla3");
    const first = await chofer();
    const disabled = await chofer();
    const busy = await chofer();
    const routeId = await route(first.driverId, "07:00", "09:00");
    await route(busy.driverId, "08:30", "10:00");
    await migrationPool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [disabled.userId]);
    const logged = (await routeChanges()).length;

    expect(await changeDriver(routeId, disabled.driverId, 409)).toEqual({ error: "This Chofer is deactivated: choose another one" });
    expect(await changeDriver(routeId, busy.driverId, 409))
      .toEqual({ error: "This Chofer already has another Recorrido at that time: 08:30-10:00" });
    for (const driverId of [999999, 0, "1", null]) expect(await changeDriver(routeId, driverId, 400), String(driverId)).toEqual({ error: "Invalid request" });
    expect((await storedRoute(routeId)).driver_id).toBe(first.driverId);
    expect(await routeChanges()).toHaveLength(logged);

    // A Recorrido that ends when this one starts does not overlap it.
    const later = await route(first.driverId, "10:00", "11:00");
    expect((await changeDriver(later, busy.driverId)).route.driverId).toBe(busy.driverId);
  });

  it("Rule 4: flags a Recorrido that carries an Asiento delantero Pasajero when its Chofer changes, without blocking the change", async () => {
    const { chofer, route, transfer, changeDriver } = await setup("regla4");
    const first = await chofer();
    const second = await chofer();
    const routeId = await route(first.driverId);
    await transfer(routeId, { frontSeat: true });
    expect((await changeDriver(routeId, second.driverId)).route).toMatchObject({ driverId: second.driverId, frontSeat: true });
    expect((await storedRoute(routeId)).driver_id).toBe(second.driverId);
  });

  it("Rule 5: recomputes the default start and end for the new Chofer and keeps a start or end the Oficina set", async () => {
    const { call, chofer, route, transfer, changeDriver } = await setup("regla5");
    const first = await chofer();
    const second = await chofer();
    const byDefault = await route(first.driverId, "07:00", "09:00");
    await transfer(byDefault);
    await changeDriver(byDefault, second.driverId);
    await call(`/routes/${byDefault}/order`, "POST", undefined, 502);
    expect(problems.at(-1)!.vehicles[0]).toMatchObject({ start: second.home, end: second.home });

    const setByHand = await route(first.driverId, "13:00", "14:00");
    await transfer(setByHand, {}, "14:00");
    await call(`/routes/${setByHand}`, "PATCH", { startKind: "point", startLat: -26.81, startLng: -65.26, endKind: "open" }, 200);
    const kept = { startKind: "point", startLat: -26.81, startLng: -65.26, endKind: "open" };
    expect((await changeDriver(setByHand, second.driverId)).route).toMatchObject({ driverId: second.driverId, ...kept });
    await call(`/routes/${setByHand}/order`, "POST", undefined, 502);
    expect(problems.at(-1)!.vehicles[0].start).toEqual([-65.26, -26.81]);
    expect(problems.at(-1)!.vehicles[0].end).toBeUndefined();
  });

  it("records in the change log who changed the Chofer, once per change", async () => {
    const { officeId, chofer, route, changeDriver } = await setup("log");
    const first = await chofer();
    const second = await chofer();
    const routeId = await route(first.driverId);
    await changeDriver(routeId, second.driverId);
    await changeDriver(routeId, second.driverId);
    expect((await routeChanges()).slice(1)).toEqual([{
      actor_user_id: officeId,
      entity_id: String(routeId),
      action: "updated",
      before_data: { driverId: first.driverId },
      after_data: { driverId: second.driverId },
    }]);
  });

  it("lets only the Oficina change the Chofer of a Recorrido", async () => {
    const { chofer, route } = await setup("auth");
    const first = await chofer();
    const second = await chofer();
    const routeId = await route(first.driverId);
    const logged = (await routeChanges()).length;
    for (const cookie of [first.cookie, second.cookie]) {
      expect(await answer(request(`/routes/${routeId}`, "PATCH", { driverId: second.driverId }, cookie), 403)).toEqual({ error: "Office role required" });
    }
    expect(await answer(request(`/routes/${routeId}`, "PATCH", { driverId: second.driverId }), 401)).toEqual({ error: "Authentication required" });
    expect((await storedRoute(routeId)).driver_id).toBe(first.driverId);
    expect(await routeChanges()).toHaveLength(logged);
  });
});
