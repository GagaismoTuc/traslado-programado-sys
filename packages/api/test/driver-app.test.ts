import { afterAll, describe, expect, it } from "vitest";
import { createApp, type Router, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
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
// 09:00 of 2026-10-23 in Tucumán (UTC-3): today is 2026-10-23 and tomorrow 2026-10-24.
const clock = { now: new Date("2026-10-23T12:00:00.000Z") };
const app = createApp({ db: appPool, routing: routingUp, router: fakeRouter, config: { serverEpoch: "driver-app-test", now: () => clock.now } });

const YESTERDAY = "2026-10-22";
const TODAY = "2026-10-23";
const TOMORROW = "2026-10-24";
const AFTER_TOMORROW = "2026-10-25";
// Synthetic places only: home H and the school D.
const H = { lat: -26.83, lng: -65.21 };
const D = { lat: -26.82, lng: -65.2 };

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

async function acknowledgements() {
  return (await migrationPool.query(
    `SELECT pv.route_id, pv.version, va.driver_id FROM version_acknowledgements va JOIN plan_versions pv ON pv.id = va.plan_version_id
      ORDER BY va.id`,
  )).rows.map((row) => ({ routeId: Number(row.route_id), version: Number(row.version), driverId: Number(row.driver_id) }));
}

/** An Oficina with a school, a Pasajero with a Consentimiento, two signed-in Choferes and helpers to plan and publish their days. */
async function setup(name: string) {
  clock.now = new Date("2026-10-23T12:00:00.000Z");
  await seedUser(`oficina-${name}`, "office");
  const office = (await signInOffice(app, migrationPool, `oficina-${name}`, `oficina-${name}-password`)).cookie;
  const post = async (path: string, body: unknown, status = 201) => await answer(request(path, "POST", body, office), status);
  const school = (await post("/destinations", {
    name: `Escuela ${name}`, kind: "school", address: "Avenida Sintetica 303", accessNotes: "Entrada por el portón lateral", ...D,
  })).destination.id as number;
  // Each Chofer drives his own Vehículo, so their Recorridos can be published at the same time.
  const chofer = async (index: number) => {
    const vehicle = (await post("/vehicles", { plate: `${name.slice(0, 3).toUpperCase()}00${index}`, model: "Furgón Sintético", seats: 8 })).vehicle.id as number;
    const username = `chofer-${name}-${index}`;
    const userId = await seedUser(username, "driver");
    const driverId = (await post("/drivers", {
      userId, name: `Chofer Sintético ${index}`, homeAddress: "Pasaje de Prueba 202", homeLat: -26.85, homeLng: -65.23, usualVehicleId: vehicle,
    })).driver.id as number;
    const login = await request("/auth/login", "POST", { username, password: `${username}-password`, deviceLabel: "Celular sintético" });
    expect(login.status).toBe(200);
    return { driverId, cookie: getSessionCookie(login).cookie };
  };
  const passenger = (await post("/passengers", {
    name: "Pasajero Sintético", homeAddress: "Calle Inventada 101", homeLat: H.lat, homeLng: H.lng, accessNotes: "Timbre del fondo",
    companions: 1, frontSeat: false, wheelchair: true, maxRideTimeMinutes: 60, pickupDurationMinutes: 5, dropoffDurationMinutes: 5,
    medicalAlert: "Alergia sintética a la penicilina",
  })).passenger.id as number;
  const signer = (await post(`/passengers/${passenger}/authorized-adults`, {
    name: "Madre Sintética", dni: "-1000001", relation: "madre", phone: "381-000-0001", legalGuardian: true,
  })).adult.id as number;
  await post(`/passengers/${passenger}/consent`, { signedByAdultId: signer, signedAt: "2026-10-01", otherAdultAllowed: false });
  const plans = new Set<string>();
  /** A Recorrido of the Chofer on `date` serving one Traslado of the Pasajero; published unless told otherwise. */
  const recorrido = async (driverId: number, date: string, direction: "entrada" | "salida", targetTime: string, publish = true) => {
    if (!plans.has(date)) await post("/daily-plans", { date });
    plans.add(date);
    const routeId = (await post(`/daily-plans/${date}/routes`, { driverId, startTime: "06:00", endTime: "18:00" })).route.id as number;
    const transferId = (await post(`/daily-plans/${date}/transfers`, { passengerId: passenger, direction, destinationId: school, targetTime })).transfer.id as number;
    await answer(request(`/transfers/${transferId}`, "PATCH", { routeId }, office), 200);
    if (publish) await post(`/routes/${routeId}/publish`, {});
    return { routeId, transferId };
  };
  const republish = async (routeId: number) => await post(`/routes/${routeId}/publish`, {});
  return { office, chofer, recorrido, republish };
}

describe("Driver app scope", () => {
  it("gives a Chofer his own published Recorridos of today and tomorrow with every Parada's details", async () => {
    const { chofer, recorrido } = await setup("scope");
    const first = await chofer(1);
    const today = await recorrido(first.driverId, TODAY, "entrada", "08:00");
    const tomorrow = await recorrido(first.driverId, TOMORROW, "salida", "13:00");

    const home = { name: null, address: "Calle Inventada 101", accessNotes: "Timbre del fondo" };
    const school = { name: "Escuela scope", address: "Avenida Sintetica 303", accessNotes: "Entrada por el portón lateral" };
    const passenger = { name: "Pasajero Sintético", wheelchair: true, medicalAlert: "Alergia sintética a la penicilina" };
    expect(await answer(request(`/driver/days/${TODAY}`, "GET", undefined, first.cookie), 200)).toEqual({
      date: TODAY,
      routes: [{
        routeId: today.routeId, version: 1, startTime: "06:00", endTime: "18:00", vehiclePlate: "SCO001", status: "publicado", acknowledgedVersion: null,
        stops: [
          { position: 1, kind: "pickup", plannedTime: "07:51", transferId: today.transferId, direction: "entrada", transferStatus: "planificado", place: home, passenger, companions: 1 },
          { position: 2, kind: "dropoff", plannedTime: "08:00", transferId: today.transferId, direction: "entrada", transferStatus: "planificado", place: school, passenger, companions: 1 },
        ],
      }],
    });
    expect(await answer(request(`/driver/days/${TOMORROW}`, "GET", undefined, first.cookie), 200)).toEqual({
      date: TOMORROW,
      routes: [{
        routeId: tomorrow.routeId, version: 1, startTime: "06:00", endTime: "18:00", vehiclePlate: "SCO001", status: "publicado", acknowledgedVersion: null,
        stops: [
          { position: 1, kind: "pickup", plannedTime: "13:00", transferId: tomorrow.transferId, direction: "salida", transferStatus: "planificado", place: school, passenger, companions: 1 },
          { position: 2, kind: "dropoff", plannedTime: "13:08", transferId: tomorrow.transferId, direction: "salida", transferStatus: "planificado", place: home, passenger, companions: 1 },
        ],
      }],
    });
  });

  it("shows tomorrow's Recorrido only once it is published", async () => {
    const { chofer, recorrido, republish } = await setup("tomorrow");
    const first = await chofer(1);
    const draft = await recorrido(first.driverId, TOMORROW, "entrada", "08:00", false);
    expect(await answer(request(`/driver/days/${TOMORROW}`, "GET", undefined, first.cookie), 200)).toEqual({ date: TOMORROW, routes: [] });

    await republish(draft.routeId);
    const day = await answer(request(`/driver/days/${TOMORROW}`, "GET", undefined, first.cookie), 200);
    expect(day.routes.map((route: { routeId: number; version: number }) => [route.routeId, route.version])).toEqual([[draft.routeId, 1]]);
  });

  it("refuses other days on every driver endpoint, counting days in the Plan diario's zone", async () => {
    const { chofer, recorrido } = await setup("days");
    const first = await chofer(1);
    const past = await recorrido(first.driverId, YESTERDAY, "entrada", "08:00");
    const later = await recorrido(first.driverId, AFTER_TOMORROW, "entrada", "08:00");
    const refusal = { error: "Only today's and tomorrow's Recorridos are available" };
    for (const date of [YESTERDAY, AFTER_TOMORROW]) {
      expect(await answer(request(`/driver/days/${date}`, "GET", undefined, first.cookie), 403)).toEqual(refusal);
    }
    for (const { routeId } of [past, later]) {
      expect(await answer(request(`/driver/routes/${routeId}/acknowledgements`, "POST", { version: 1 }, first.cookie), 403)).toEqual(refusal);
    }
    expect(await acknowledgements()).toEqual([]);

    // 02:30 UTC of 2026-10-24 is still 23:30 of 2026-10-23 in Tucumán: the day after tomorrow stays refused.
    clock.now = new Date("2026-10-24T02:30:00.000Z");
    expect(await answer(request(`/driver/days/${AFTER_TOMORROW}`, "GET", undefined, first.cookie), 403)).toEqual(refusal);
    expect(await answer(request(`/driver/days/${TODAY}`, "GET", undefined, first.cookie), 200)).toEqual({ date: TODAY, routes: [] });
  });

  it("neither lists nor acknowledges another Chofer's Recorrido", async () => {
    const { chofer, recorrido } = await setup("other");
    const first = await chofer(1);
    const second = await chofer(2);
    const theirs = await recorrido(second.driverId, TODAY, "entrada", "08:00");
    expect(await answer(request(`/driver/days/${TODAY}`, "GET", undefined, first.cookie), 200)).toEqual({ date: TODAY, routes: [] });
    expect(await answer(request(`/driver/routes/${theirs.routeId}/acknowledgements`, "POST", { version: 1 }, first.cookie), 403))
      .toEqual({ error: "This Recorrido belongs to another Chofer" });
    expect(await acknowledgements()).toEqual([]);
  });

  it("refuses unauthenticated callers and the Oficina on every driver endpoint", async () => {
    const { office, chofer, recorrido } = await setup("anon");
    const first = await chofer(1);
    const mine = await recorrido(first.driverId, TODAY, "entrada", "08:00");
    const endpoints: [string, string, unknown][] = [
      [`/driver/days/${TODAY}`, "GET", undefined],
      [`/driver/routes/${mine.routeId}/acknowledgements`, "POST", { version: 1 }],
      [`/driver/routes/${mine.routeId}/start`, "POST", {}],
      [`/driver/routes/${mine.routeId}/marks`, "POST", {
        id: "00000000-0000-4000-8000-000000000001", transferId: mine.transferId, kind: "subio", phoneTime: "2026-10-23T12:00:00.000Z", location: null, version: 1,
      }],
      [`/driver/routes/${mine.routeId}/transfers/${mine.transferId}/handover`, "GET", undefined],
    ];
    for (const [path, method, body] of endpoints) {
      expect(await answer(request(path, method, body), 401)).toEqual({ error: "Authentication required" });
      expect(await answer(request(path, method, body, "session=not-a-session"), 401)).toEqual({ error: "Authentication required", code: "session_expired" });
      expect(await answer(request(path, method, body, office), 403)).toEqual({ error: "Chofer role required" });
    }
    expect(await acknowledgements()).toEqual([]);
    expect((await migrationPool.query("SELECT count(*)::int AS marks FROM marks")).rows[0].marks).toBe(0);
    expect((await migrationPool.query("SELECT status FROM routes WHERE id = $1", [mine.routeId])).rows[0].status).toBe("publicado");
  });
});

describe("Confirmación de versión", () => {
  it("records the Chofer's acknowledgement once and the Oficina sees who has not acknowledged the latest version", async () => {
    const { office, chofer, recorrido } = await setup("ack");
    const first = await chofer(1);
    const second = await chofer(2);
    const mine = await recorrido(first.driverId, TODAY, "entrada", "08:00");
    const theirs = await recorrido(second.driverId, TODAY, "salida", "13:00");
    const missing = async () => (await answer(request(`/daily-plans/${TODAY}/acknowledgements`, "GET", undefined, office), 200)).missing;
    expect(await missing()).toEqual([
      { routeId: mine.routeId, version: 1, driverId: first.driverId, driverName: "Chofer Sintético 1", startTime: "06:00", endTime: "18:00", acknowledgedVersion: null },
      { routeId: theirs.routeId, version: 1, driverId: second.driverId, driverName: "Chofer Sintético 2", startTime: "06:00", endTime: "18:00", acknowledgedVersion: null },
    ]);

    const acknowledged = await answer(request(`/driver/routes/${mine.routeId}/acknowledgements`, "POST", { version: 1 }, first.cookie), 201);
    expect(acknowledged).toEqual({
      acknowledgement: { routeId: mine.routeId, version: 1, acknowledgedAt: "2026-10-23T12:00:00.000Z" }, latestVersion: 1,
    });
    // Repeating it keeps the first Confirmación de versión.
    clock.now = new Date("2026-10-23T12:05:00.000Z");
    expect(await answer(request(`/driver/routes/${mine.routeId}/acknowledgements`, "POST", { version: 1 }, first.cookie), 200)).toEqual(acknowledged);
    expect(await acknowledgements()).toEqual([{ routeId: mine.routeId, version: 1, driverId: first.driverId }]);
    expect((await answer(request(`/driver/days/${TODAY}`, "GET", undefined, first.cookie), 200)).routes[0].acknowledgedVersion).toBe(1);
    expect((await missing()).map((item: { routeId: number }) => item.routeId)).toEqual([theirs.routeId]);

    expect(await answer(request(`/driver/routes/${mine.routeId}/acknowledgements`, "POST", { version: 2 }, first.cookie), 404))
      .toEqual({ error: "Versión del plan not found" });
    for (const body of [{}, { version: 0 }, { version: "1" }]) {
      expect(await answer(request(`/driver/routes/${mine.routeId}/acknowledgements`, "POST", body, first.cookie), 400)).toEqual({ error: "Invalid request" });
    }
    expect(await answer(request(`/daily-plans/${TODAY}/acknowledgements`, "GET", undefined, first.cookie), 403)).toEqual({ error: "Office role required" });
    expect(await acknowledgements()).toHaveLength(1);
    await expect(appPool.query("DELETE FROM version_acknowledgements")).rejects.toThrow(/permission denied/i);
    await expect(appPool.query("UPDATE version_acknowledgements SET driver_id = driver_id")).rejects.toThrow(/permission denied/i);
  });

  it("records the version actually seen when the Chofer acknowledges one that is not the latest", async () => {
    const { office, chofer, recorrido, republish } = await setup("stale");
    const first = await chofer(1);
    const mine = await recorrido(first.driverId, TODAY, "entrada", "08:00");
    // The Oficina changes the Acompañantes and publishes version 2 while the app still shows version 1.
    await answer(request(`/transfers/${mine.transferId}`, "PATCH", { companions: 0 }, office), 200);
    expect((await republish(mine.routeId)).version.version).toBe(2);

    expect(await answer(request(`/driver/routes/${mine.routeId}/acknowledgements`, "POST", { version: 1 }, first.cookie), 201)).toEqual({
      acknowledgement: { routeId: mine.routeId, version: 1, acknowledgedAt: "2026-10-23T12:00:00.000Z" }, latestVersion: 2,
    });
    expect(await acknowledgements()).toEqual([{ routeId: mine.routeId, version: 1, driverId: first.driverId }]);
    expect(await answer(request(`/daily-plans/${TODAY}/acknowledgements`, "GET", undefined, office), 200)).toEqual({
      missing: [{
        routeId: mine.routeId, version: 2, driverId: first.driverId, driverName: "Chofer Sintético 1", startTime: "06:00", endTime: "18:00",
        acknowledgedVersion: 1,
      }],
    });
    const day = await answer(request(`/driver/days/${TODAY}`, "GET", undefined, first.cookie), 200);
    expect([day.routes[0].version, day.routes[0].acknowledgedVersion]).toEqual([2, 1]);
  });
});
