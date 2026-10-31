import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const app = createApp({ db: appPool, routing: routingUp, config: { serverEpoch: "planning-test" } });
type App = typeof app;

const DAY = "2026-11-02";
const OTHER_DAY = "2026-11-03";

// Synthetic data only.
const validPassenger = {
  name: "Pasajero Sintético",
  homeAddress: "Calle Inventada 101",
  homeLat: -26.83,
  homeLng: -65.21,
  companions: 1,
  frontSeat: false,
  wheelchair: false,
  maxRideTimeMinutes: 60,
  pickupDurationMinutes: 5,
  dropoffDurationMinutes: 5,
};

async function request(path: string, method: string, body?: unknown, cookie?: string, target: App = app) {
  return await target.request(path, {
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

async function signIn(username: string, role: "office" | "driver") {
  await seedUser(username, role);
  if (role === "office") return (await signInOffice(app, migrationPool, username, `${username}-password`)).cookie;
  const response = await request("/auth/login", "POST", { username, password: `${username}-password`, deviceLabel: "Test browser" });
  return getSessionCookie(response).cookie;
}

async function created(response: Response | Promise<Response>, status = 201) {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return await resolved.json();
}

async function destination(office: string, name: string) {
  const body = { name, kind: "school", address: "Avenida Sintetica 303", lat: -26.82, lng: -65.2 };
  return (await created(request("/destinations", "POST", body, office))).destination.id as number;
}

async function passenger(office: string, overrides: Record<string, unknown> = {}) {
  return (await created(request("/passengers", "POST", { ...validPassenger, ...overrides }, office))).passenger.id as number;
}

async function vehicle(office: string, plate: string) {
  return (await created(request("/vehicles", "POST", { plate, model: "Furgón Sintético", seats: 8 }, office))).vehicle.id as number;
}

async function driver(office: string, username: string, usualVehicleId: number | null) {
  const userId = await seedUser(username, "driver");
  const body = { userId, name: `Chofer ${username}`, homeAddress: "Pasaje de Prueba 202", homeLat: -26.84, homeLng: -65.22, usualVehicleId };
  return (await created(request("/drivers", "POST", body, office))).driver.id as number;
}

async function plan(office: string, date = DAY) {
  return (await created(request("/daily-plans", "POST", { date }, office))).plan.id as number;
}

async function transfer(office: string, fields: Record<string, unknown>, date = DAY) {
  return (await created(request(`/daily-plans/${date}/transfers`, "POST", fields, office))).transfer;
}

async function route(office: string, fields: Record<string, unknown>, date = DAY) {
  return (await created(request(`/daily-plans/${date}/routes`, "POST", { startTime: "07:00", endTime: "09:00", ...fields }, office))).route;
}

async function day(office: string, date = DAY) {
  return await created(request(`/daily-plans/${date}`, "GET", undefined, office), 200);
}

async function stopsOf(office: string, routeId: number) {
  const view = await day(office);
  return view.routes.find((candidate: { id: number }) => candidate.id === routeId).stops as
    { id: number; transferId: number; kind: string; position: number; legDistanceMeters: number | null; placeName: string | null }[];
}

async function changes(entity: string) {
  return (await migrationPool.query(
    "SELECT entity_id, action, before_data, after_data FROM change_log WHERE entity = $1 ORDER BY id",
    [entity],
  )).rows;
}

async function stored(table: string) {
  return (await migrationPool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
}

/** An Oficina session plus one Pasajero, one Destino and one Chofer whose usual Vehículo is `vehicleId`. */
async function setup(name: string) {
  const office = await signIn(`oficina-${name}`, "office");
  const passengerId = await passenger(office);
  const destinationId = await destination(office, `Escuela ${name}`);
  const vehicleId = await vehicle(office, `AA${String(name.length).padStart(3, "0")}BB`);
  const driverId = await driver(office, `chofer-${name}`, vehicleId);
  await plan(office);
  const entrada = (targetTime: string, extra: Record<string, unknown> = {}) =>
    transfer(office, { passengerId, direction: "entrada", destinationId, targetTime, ...extra });
  return { office, passengerId, destinationId, vehicleId, driverId, entrada };
}

beforeAll(async () => {
  await appPool.query("SELECT 1");
});

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

describe("Plan diario by hand", () => {
  it("creates one Plan diario per date and returns the same one when it is created again", async () => {
    const office = await signIn("oficina-plan", "office");
    const first = await created(request("/daily-plans", "POST", { date: DAY }, office));
    expect(first).toEqual({
      plan: { id: expect.any(Number), date: DAY, timeZone: "America/Argentina/Tucuman" },
      transfers: [],
      routes: [],
      km: 0,
    });
    const again = await created(request("/daily-plans", "POST", { date: DAY }, office), 200);
    expect(again.plan.id).toBe(first.plan.id);
    expect(await stored("daily_plans")).toHaveLength(1);
    expect(await changes("daily_plan")).toEqual([
      { entity_id: String(first.plan.id), action: "created", before_data: null, after_data: { date: DAY } },
    ]);

    for (const date of ["2026-02-30", "02/11/2026", "", 20261102]) {
      expect((await request("/daily-plans", "POST", { date }, office)).status, String(date)).toBe(400);
    }
    expect((await request("/daily-plans/2026-02-30", "GET", undefined, office)).status).toBe(400);
    expect(await created(request(`/daily-plans/${OTHER_DAY}`, "GET", undefined, office), 404)).toEqual({ error: "Plan diario not found" });
    const missing = await request(`/daily-plans/${OTHER_DAY}/transfers`, "POST", {
      passengerId: 1, direction: "entrada", destinationId: 1, targetTime: "08:00",
    }, office);
    expect(missing.status).toBe(404);
    expect(await stored("daily_plans")).toHaveLength(1);
  });

  it("keeps every Traslado in exactly one Plan diario, listed in its day even when unassigned", async () => {
    const { office, driverId, entrada } = await setup("regla1");
    await plan(office, OTHER_DAY);
    const unassigned = await entrada("08:00");
    const otherRoute = await route(office, { driverId }, OTHER_DAY);

    const view = await day(office);
    expect(view.transfers.map((item: { id: number; routeId: number | null }) => [item.id, item.routeId])).toEqual([[unassigned.id, null]]);
    expect((await day(office, OTHER_DAY)).transfers).toEqual([]);

    const moved = await request(`/transfers/${unassigned.id}`, "PATCH", { routeId: otherRoute.id }, office);
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: "The Recorrido belongs to another Plan diario" });
    expect(await stored("stops")).toEqual([]);
    expect((await changes("transfer")).map((row) => row.action)).toEqual(["created"]);
    await expect(migrationPool.query("UPDATE transfers SET daily_plan_id = NULL WHERE id = $1", [unassigned.id]))
      .rejects.toMatchObject({ code: "23502" });
  });

  it("moves a Traslado to another Recorrido only while Planificado", async () => {
    const { office, driverId, entrada } = await setup("regla2");
    const first = await route(office, { driverId });
    const second = await route(office, { driverId, startTime: "10:00", endTime: "11:00" });
    const item = await entrada("08:00");

    expect((await created(request(`/transfers/${item.id}`, "PATCH", { routeId: first.id }, office), 200)).transfer.routeId).toBe(first.id);
    expect((await created(request(`/transfers/${item.id}`, "PATCH", { routeId: second.id }, office), 200)).transfer.routeId).toBe(second.id);
    expect(await stopsOf(office, first.id)).toEqual([]);
    expect((await stopsOf(office, second.id)).map((stop) => [stop.kind, stop.position])).toEqual([["pickup", 1], ["dropoff", 2]]);
    expect((await changes("transfer")).slice(1).map((row) => [row.action, row.before_data, row.after_data])).toEqual([
      ["assigned", { routeId: null }, { routeId: first.id }],
      ["moved", { routeId: first.id }, { routeId: second.id }],
    ]);

    await migrationPool.query("UPDATE transfers SET status = 'subio' WHERE id = $1", [item.id]);
    for (const routeId of [first.id, null]) {
      const refused = await request(`/transfers/${item.id}`, "PATCH", { routeId }, office);
      expect(refused.status, String(routeId)).toBe(409);
      expect(await refused.json()).toEqual({ error: "Only a Planificado Traslado can change Recorrido" });
    }
    expect((await stopsOf(office, second.id)).map((stop) => stop.transferId)).toEqual([item.id, item.id]);
    expect(await changes("transfer")).toHaveLength(3);
  });

  it("refuses a manual order that puts a Pasajero's drop-off before their pickup", async () => {
    const { office, driverId, entrada } = await setup("regla3");
    const recorrido = await route(office, { driverId });
    const a = await entrada("08:00");
    const b = await entrada("08:30");
    for (const item of [a, b]) await created(request(`/transfers/${item.id}`, "PATCH", { routeId: recorrido.id }, office), 200);
    const [ap, ad, bp, bd] = (await stopsOf(office, recorrido.id)).map((stop) => stop.id);

    const reordered = await request(`/routes/${recorrido.id}/stops`, "PATCH", { stopIds: [ap, bp, bd, ad] }, office);
    expect(reordered.status).toBe(200);
    expect(await reordered.json()).toEqual({ stopIds: [ap, bp, bd, ad] });
    expect((await stopsOf(office, recorrido.id)).map((stop) => [stop.id, stop.position])).toEqual([[ap, 1], [bp, 2], [bd, 3], [ad, 4]]);
    expect((await changes("route")).at(-1)).toMatchObject({
      action: "stops_reordered", before_data: { stopIds: [ap, ad, bp, bd] }, after_data: { stopIds: [ap, bp, bd, ad] },
    });
    const logged = (await changes("route")).length;

    const refused = await request(`/routes/${recorrido.id}/stops`, "PATCH", { stopIds: [ad, ap, bp, bd] }, office);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "A Pasajero's pickup must come before their drop-off" });
    for (const stopIds of [[ap, bp, bd], [ap, ap, bp, bd], [ap, bp, bd, ad, 999], "x"]) {
      expect((await request(`/routes/${recorrido.id}/stops`, "PATCH", { stopIds }, office)).status, String(stopIds)).toBe(400);
    }
    expect((await stopsOf(office, recorrido.id)).map((stop) => stop.id)).toEqual([ap, bp, bd, ad]);
    expect(await changes("route")).toHaveLength(logged);
  });

  it("refuses new Traslados for a deactivated Pasajero", async () => {
    const { office, passengerId, entrada } = await setup("regla4");
    expect((await request(`/passengers/${passengerId}/deactivate`, "PATCH", {}, office)).status).toBe(204);

    const refused = await request(`/daily-plans/${DAY}/transfers`, "POST", {
      passengerId, direction: "salida", destinationId: (await stored("destinations"))[0].id, targetTime: "17:00",
    }, office);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "A deactivated Pasajero cannot get new Traslados" });
    expect(await stored("transfers")).toEqual([]);
    expect(await changes("transfer")).toEqual([]);

    expect((await request(`/passengers/${passengerId}/reactivate`, "PATCH", {}, office)).status).toBe(204);
    expect((await entrada("08:00")).passengerId).toBe(passengerId);
  });

  it("defaults the Recorrido's Vehículo to the Chofer's usual Vehículo and lets the Oficina change it per Recorrido", async () => {
    const { office, vehicleId, driverId } = await setup("regla6");
    const replacement = await vehicle(office, "RE001PL");
    const withoutUsual = await driver(office, "chofer-suplente", null);

    const byDefault = await route(office, { driverId });
    expect(byDefault).toEqual({
      id: expect.any(Number), driverId, driverName: "Chofer chofer-regla6", vehicleId, vehiclePlate: "AA006BB",
      startTime: "07:00", endTime: "09:00", status: "borrador",
    });
    expect((await route(office, { driverId, vehicleId: replacement })).vehicleId).toBe(replacement);

    const changed = await created(request(`/routes/${byDefault.id}`, "PATCH", { vehicleId: replacement }, office), 200);
    expect(changed.route.vehicleId).toBe(replacement);
    expect((await changes("route")).at(-1)).toMatchObject({
      entity_id: String(byDefault.id), action: "updated", before_data: { vehicleId }, after_data: { vehicleId: replacement },
    });
    expect((await stored("drivers")).find((row) => row.id === driverId).usual_vehicle_id).toBe(vehicleId);

    const noUsual = await request(`/daily-plans/${DAY}/routes`, "POST", { driverId: withoutUsual, startTime: "07:00", endTime: "09:00" }, office);
    expect(noUsual.status).toBe(400);
    expect(await noUsual.json()).toEqual({ error: "This Chofer has no usual Vehículo: choose one" });
    expect((await request(`/vehicles/${replacement}/deactivate`, "PATCH", {}, office)).ok).toBe(true);
    expect((await request(`/routes/${byDefault.id}`, "PATCH", { vehicleId }, office)).status).toBe(200);
    expect((await request(`/routes/${byDefault.id}`, "PATCH", { vehicleId: replacement }, office)).status).toBe(400);
    expect(await stored("routes")).toHaveLength(2);
  });

  it("defaults the Acompañantes of a Traslado from the Pasajero and lets the Oficina change them per Traslado", async () => {
    const { office, destinationId } = await setup("regla7");
    const twoCompanions = await passenger(office, { name: "Pasajero Dos Acompañantes", companions: 2 });
    const base = { passengerId: twoCompanions, direction: "entrada", destinationId, targetTime: "08:00" };

    const byDefault = await transfer(office, base);
    expect(byDefault.companions).toBe(2);
    expect((await transfer(office, { ...base, companions: 0 })).companions).toBe(0);
    const changed = await created(request(`/transfers/${byDefault.id}`, "PATCH", { companions: 1 }, office), 200);
    expect(changed.transfer.companions).toBe(1);
    expect((await changes("transfer")).at(-1)).toMatchObject({
      entity_id: String(byDefault.id), action: "updated", before_data: { companions: 2 }, after_data: { companions: 1 },
    });
    expect((await stored("passengers")).find((row) => row.id === twoCompanions).companions).toBe(2);

    for (const companions of [3, -1, 1.5, "1"]) {
      expect((await request(`/transfers/${byDefault.id}`, "PATCH", { companions }, office)).status, String(companions)).toBe(400);
      expect((await request(`/daily-plans/${DAY}/transfers`, "POST", { ...base, companions }, office)).status, String(companions)).toBe(400);
    }
    expect((await stored("transfers")).map((row) => row.companions)).toEqual([1, 0]);
  });

  it("lets an entrada start at another Destino, stored as part of the Traslado", async () => {
    const { office, passengerId, destinationId, driverId, entrada } = await setup("regla8");
    const therapy = await destination(office, "Centro Terapéutico Sintético");
    const fromTherapy = await entrada("15:00", { originDestinationId: therapy });
    expect(fromTherapy).toMatchObject({
      direction: "entrada",
      originDestinationId: therapy,
      originDestinationName: "Centro Terapéutico Sintético",
      destinationId,
      destinationName: "Escuela regla8",
    });
    const recorrido = await route(office, { driverId, startTime: "14:00", endTime: "15:00" });
    await created(request(`/transfers/${fromTherapy.id}`, "PATCH", { routeId: recorrido.id }, office), 200);
    expect((await stopsOf(office, recorrido.id)).map((stop) => [stop.kind, stop.placeName])).toEqual([
      ["pickup", "Centro Terapéutico Sintético"],
      ["dropoff", "Escuela regla8"],
    ]);

    const base = { passengerId, destinationId, targetTime: "16:00" };
    for (const body of [
      { ...base, direction: "salida", originDestinationId: therapy },
      { ...base, direction: "entrada", originDestinationId: destinationId },
      { ...base, direction: "entrada", originDestinationId: "x" },
    ]) expect((await request(`/daily-plans/${DAY}/transfers`, "POST", body, office)).status, JSON.stringify(body)).toBe(400);
    expect((await request(`/daily-plans/${DAY}/transfers`, "POST", { ...base, direction: "entrada", originDestinationId: 9999 }, office)).status)
      .toBe(400);
    expect(await stored("transfers")).toHaveLength(1);
  });

  it("shows km per Recorrido and per day from the stored leg distances, without a fuel estimate", async () => {
    const { office, driverId, entrada } = await setup("regla9");
    const morning = await route(office, { driverId });
    const afternoon = await route(office, { driverId, startTime: "13:00", endTime: "14:00" });
    const a = await entrada("08:00");
    const b = await entrada("13:30");
    await created(request(`/transfers/${a.id}`, "PATCH", { routeId: morning.id }, office), 200);
    await created(request(`/transfers/${b.id}`, "PATCH", { routeId: afternoon.id }, office), 200);
    expect((await day(office)).km).toBeNull();

    const legs = new Map([[1, 4200], [2, 3100], [3, 1500], [4, 2250]]);
    for (const [position, meters] of legs) {
      await migrationPool.query(
        "UPDATE stops SET leg_distance_meters = $1 WHERE id = (SELECT id FROM stops ORDER BY id OFFSET $2 LIMIT 1)",
        [meters, position - 1],
      );
    }
    const view = await day(office);
    expect(view.routes.map((item: { id: number; km: number | null }) => [item.id, item.km])).toEqual([[morning.id, 7.3], [afternoon.id, 3.75]]);
    expect(view.km).toBe(11.05);
    expect(JSON.stringify(view)).not.toMatch(/fuel|combust|litr/i);

    // A new order invalidates the stored legs of that Recorrido only.
    const [pickup, dropoff] = (await stopsOf(office, morning.id)).map((stop) => stop.id);
    await created(request(`/routes/${morning.id}/stops`, "PATCH", { stopIds: [pickup, dropoff] }, office), 200);
    const after = await day(office);
    expect(after.routes.map((item: { km: number | null }) => item.km)).toEqual([null, 3.75]);
    expect(after.km).toBeNull();
  });

  it("cuts a Chofer's day into Recorridos at gaps longer than 60 minutes between consecutive target times", async () => {
    const { office, vehicleId, driverId, entrada } = await setup("regla10");
    const times = ["11:00", "07:30", "08:00", "09:00", "11:30", "14:00"];
    const items: { id: number }[] = [];
    for (const time of times) items.push(await entrada(time));
    const id = (time: string) => items[times.indexOf(time)].id;

    const result = await created(request(`/daily-plans/${DAY}/driver-days`, "POST", { driverId, transferIds: items.map((item) => item.id) }, office));
    expect(result.routes.map((item: { startTime: string; endTime: string; transferIds: number[] }) => [item.startTime, item.endTime, item.transferIds]))
      .toEqual([
        ["07:30", "09:00", [id("07:30"), id("08:00"), id("09:00")]],
        ["11:00", "11:30", [id("11:00"), id("11:30")]],
        ["14:00", "14:00", [id("14:00")]],
      ]);
    const view = await day(office);
    expect(view.routes.map((item: { vehicleId: number; status: string }) => [item.vehicleId, item.status])).toEqual([
      [vehicleId, "borrador"], [vehicleId, "borrador"], [vehicleId, "borrador"],
    ]);
    expect(view.routes[1].stops.map((stop: { transferId: number; kind: string }) => [stop.transferId, stop.kind])).toEqual([
      [id("11:00"), "pickup"], [id("11:00"), "dropoff"], [id("11:30"), "pickup"], [id("11:30"), "dropoff"],
    ]);

    const rerun = await request(`/daily-plans/${DAY}/driver-days`, "POST", { driverId, transferIds: [id("07:30")] }, office);
    expect(rerun.status).toBe(409);
    expect(await rerun.json()).toEqual({ error: "This Chofer already has Recorridos on this day" });
    expect(await stored("routes")).toHaveLength(3);

    const other = await driver(office, "chofer-regla10-b", vehicleId);
    const taken = await request(`/daily-plans/${DAY}/driver-days`, "POST", { driverId: other, transferIds: [id("07:30")] }, office);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "Only Planificado Traslados without a Recorrido can be given to a Chofer" });
    expect((await request(`/daily-plans/${DAY}/driver-days`, "POST", { driverId: other, transferIds: [] }, office)).status).toBe(400);
    expect(await stored("routes")).toHaveLength(3);
  });

  it("reads the gap that cuts a Chofer's day from configuration, 60 minutes by default", async () => {
    const environment = {
      SERVER_EPOCH: "planning-config", DATABASE_URL: "postgres://app:secret@localhost:5432/app",
      OSRM_URL: "http://127.0.0.1:5000", VROOM_URL: "http://127.0.0.1:3001",
    } as NodeJS.ProcessEnv;
    expect(readConfig(environment).routeGapMinutes).toBe(60);
    expect(readConfig({ ...environment, ROUTE_GAP_MINUTES: "30" }).routeGapMinutes).toBe(30);
    for (const value of ["0", "1.5", "x"]) {
      expect(() => readConfig({ ...environment, ROUTE_GAP_MINUTES: value })).toThrow("ROUTE_GAP_MINUTES must be a whole number of minutes from 1");
    }

    const { office, driverId, entrada } = await setup("gap30");
    const shortGap = createApp({ db: appPool, routing: routingUp, config: { serverEpoch: "planning-gap", routeGapMinutes: 30 } });
    const items = [await entrada("07:30"), await entrada("08:00"), await entrada("08:45")];
    const result = await created(request(`/daily-plans/${DAY}/driver-days`, "POST", {
      driverId, transferIds: items.map((item) => item.id),
    }, office, shortGap));
    expect(result.routes.map((item: { transferIds: number[] }) => item.transferIds)).toEqual([[items[0].id, items[1].id], [items[2].id]]);
  });

  it("moves a Traslado to Cancelado por Ausencia when an Ausencia is registered, once", async () => {
    const { office, driverId, entrada } = await setup("ausencia");
    const recorrido = await route(office, { driverId });
    const absent = await entrada("08:00");
    const stays = await entrada("08:30");
    for (const item of [absent, stays]) await created(request(`/transfers/${item.id}`, "PATCH", { routeId: recorrido.id }, office), 200);

    const registered = await created(request(`/transfers/${absent.id}/absence`, "POST", {}, office));
    expect(registered.transfer).toMatchObject({ id: absent.id, status: "cancelado_ausencia", routeId: null });
    expect((await stopsOf(office, recorrido.id)).map((stop) => [stop.transferId, stop.position])).toEqual([[stays.id, 1], [stays.id, 2]]);
    expect((await day(office)).transfers.map((item: { id: number; status: string }) => [item.id, item.status])).toEqual([
      [absent.id, "cancelado_ausencia"], [stays.id, "planificado"],
    ]);
    expect((await stored("absences")).map((row) => row.transfer_id)).toEqual([absent.id]);
    const logged = await changes("transfer");
    expect(logged.at(-1)).toMatchObject({
      entity_id: String(absent.id), action: "absence_registered",
      before_data: { status: "planificado", routeId: recorrido.id }, after_data: { status: "cancelado_ausencia", routeId: null },
    });

    const again = await created(request(`/transfers/${absent.id}/absence`, "POST", {}, office), 200);
    expect(again.transfer.status).toBe("cancelado_ausencia");
    expect(await stored("absences")).toHaveLength(1);
    expect(await changes("transfer")).toHaveLength(logged.length);
    expect((await request(`/transfers/${absent.id}`, "PATCH", { routeId: recorrido.id }, office)).status).toBe(409);
    expect((await request("/transfers/9999/absence", "POST", {}, office)).status).toBe(404);
  });

  it("stores target times and time bands as local time of the America/Argentina/Tucuman zone", async () => {
    const { office, driverId, entrada } = await setup("hora");
    const item = await entrada("08:00");
    await route(office, { driverId, startTime: "07:15", endTime: "09:30" });
    const client = await migrationPool.connect();
    try {
      await client.query("SET TIME ZONE 'Asia/Tokyo'");
      const row = (await client.query("SELECT target_time::text AS target, pg_typeof(target_time)::text AS type FROM transfers")).rows[0];
      expect(row).toEqual({ target: "08:00:00", type: "time without time zone" });
      expect((await client.query("SELECT start_time::text AS start, end_time::text AS finish FROM routes")).rows).toEqual([
        { start: "07:15:00", finish: "09:30:00" },
      ]);
    } finally {
      client.release();
    }
    const view = await day(office);
    expect(view.plan.timeZone).toBe("America/Argentina/Tucuman");
    expect(view.transfers[0]).toMatchObject({ id: item.id, targetTime: "08:00" });
    expect(view.routes[0]).toMatchObject({ startTime: "07:15", endTime: "09:30" });
    await expect(migrationPool.query("UPDATE daily_plans SET time_zone = 'UTC'")).rejects.toMatchObject({ code: "23514" });
    for (const targetTime of ["8:00", "24:00", "08:60", "08:00:00"]) {
      const body = { passengerId: item.passengerId, direction: "entrada", destinationId: item.destinationId, targetTime };
      expect((await request(`/daily-plans/${DAY}/transfers`, "POST", body, office)).status, targetTime).toBe(400);
    }
    expect((await request(`/daily-plans/${DAY}/routes`, "POST", { driverId, startTime: "10:00", endTime: "09:00" }, office)).status).toBe(400);
  });

  it("lets only the Oficina read and write the Plan diario", async () => {
    const chofer = await signIn("chofer-plan", "driver");
    for (const [method, path, body] of [
      ["POST", "/daily-plans", { date: DAY }],
      ["GET", `/daily-plans/${DAY}`, undefined],
      ["POST", `/daily-plans/${DAY}/transfers`, { passengerId: 1, direction: "entrada", destinationId: 1, targetTime: "08:00" }],
      ["PATCH", "/transfers/1", { companions: 1 }],
      ["POST", "/transfers/1/absence", {}],
      ["POST", `/daily-plans/${DAY}/routes`, { driverId: 1, startTime: "07:00", endTime: "09:00" }],
      ["PATCH", "/routes/1", { vehicleId: 1 }],
      ["PATCH", "/routes/1/stops", { stopIds: [1, 2] }],
      ["POST", `/daily-plans/${DAY}/driver-days`, { driverId: 1, transferIds: [1] }],
    ] as const) {
      expect((await request(path, method, body)).status, `${method} ${path} without session`).toBe(401);
      expect((await request(path, method, body, chofer)).status, `${method} ${path} as Chofer`).toBe(403);
    }
    expect(await stored("daily_plans")).toEqual([]);
  });
});
