import { afterAll, describe, expect, it } from "vitest";
import { createApp, type AppConfig, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import type { VroomProblem, VroomSolver } from "../src/planner.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const DAY = "2026-11-02";
const HOME_OF_DRIVER = [-65.22, -26.84];
const HOME_OF_PASSENGER = [-65.21, -26.83];
const SCHOOL = [-65.2, -26.82];
const THERAPY = [-65.19, -26.81];

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

type Shipment = {
  amount: number[];
  pickup: { id: number; location: number[]; service: number; time_windows: number[][] };
  delivery: { id: number; location: number[]; service: number; time_windows: number[][] };
};
type Vehicle = {
  start?: number[];
  end?: number[];
  capacity: number[];
  time_window: number[];
  speed_factor: number;
  costs: { per_km: number; per_hour: number };
};
type Problem = { vehicles: Vehicle[]; shipments: Shipment[] };

/**
 * Stand-in for VROOM: picks up every Traslado that fits (in input order) and then drops them all off, so capacity matters.
 * Each pickup starts when its window opens and each drop-off when its window closes, plus `lateSeconds`.
 */
function fakeEngine(options: { lateSeconds?: number; fail?: boolean } = {}) {
  const problems: Problem[] = [];
  const solver: VroomSolver = async (problem: VroomProblem) => {
    const typed = problem as unknown as Problem;
    problems.push(typed);
    if (options.fail) throw new Error("VROOM did not answer");
    const capacity = typed.vehicles[0].capacity;
    const load = [0, 0];
    const taken: Shipment[] = [];
    const unassigned: { id: number; type: string }[] = [];
    for (const shipment of typed.shipments) {
      if (load[0] + shipment.amount[0] <= capacity[0] && load[1] + shipment.amount[1] <= capacity[1]) {
        load[0] += shipment.amount[0];
        load[1] += shipment.amount[1];
        taken.push(shipment);
      } else {
        unassigned.push({ id: shipment.pickup.id, type: "pickup" }, { id: shipment.delivery.id, type: "delivery" });
      }
    }
    const steps = [
      { type: "start", arrival: 0, distance: 0 },
      ...taken.map((shipment, index) => ({
        type: "pickup", id: shipment.pickup.id, arrival: shipment.pickup.time_windows[0][0], waiting_time: 0, distance: 1000 * (index + 1),
      })),
      ...taken.map((shipment, index) => ({
        type: "delivery",
        id: shipment.delivery.id,
        arrival: shipment.delivery.time_windows[0][1] + (options.lateSeconds ?? 0),
        waiting_time: 0,
        distance: 1000 * (taken.length + index + 1),
      })),
    ];
    return { unassigned, routes: taken.length ? [{ steps }] : [] };
  };
  return { problems, solver };
}

function appWith(solver?: VroomSolver, config: Partial<AppConfig> = {}) {
  return createApp({ db: appPool, routing: routingUp, solver, config: { serverEpoch: "order-test", ...config } });
}

type App = ReturnType<typeof appWith>;

async function request(target: App, path: string, method: string, body?: unknown, cookie?: string) {
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

async function json(response: Response | Promise<Response>, status: number) {
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

async function changes(entity: string) {
  return (await migrationPool.query(
    "SELECT entity_id, action, before_data, after_data FROM change_log WHERE entity = $1 ORDER BY id",
    [entity],
  )).rows;
}

/** Synthetic Oficina, Chofer, Vehículo, Destinos and Plan diario, with helpers to add Pasajeros, Traslados and Recorridos. */
async function world(name: string, target: App, vehicleSeats = 8) {
  await seedUser(`oficina-${name}`, "office");
  const office = (await signInOffice(target, migrationPool, `oficina-${name}`, `oficina-${name}-password`)).cookie;
  const call = (path: string, method: string, body?: unknown, status = 201) => json(request(target, path, method, body, office), status);
  const destination = async (label: string, kind: string, [lng, lat]: number[]) =>
    (await call("/destinations", "POST", { name: label, kind, address: "Avenida Sintetica 303", lat, lng })).destination.id as number;
  const school = await destination(`Escuela ${name}`, "school", SCHOOL);
  const therapy = await destination(`Terapia ${name}`, "therapy", THERAPY);
  const vehicle = async (plate: string, seats = vehicleSeats) =>
    (await call("/vehicles", "POST", { plate, model: "Furgón Sintético", seats })).vehicle.id as number;
  const vehicleId = await vehicle(`OR${String(name.length).padStart(3, "0")}DE`);
  const userId = await seedUser(`chofer-${name}`, "driver");
  const driverId = (await call("/drivers", "POST", {
    userId, name: `Chofer ${name}`, homeAddress: "Pasaje de Prueba 202", homeLat: HOME_OF_DRIVER[1], homeLng: HOME_OF_DRIVER[0], usualVehicleId: vehicleId,
  })).driver.id as number;
  expect([200, 201]).toContain((await request(target, "/daily-plans", "POST", { date: DAY }, office)).status);
  const passenger = async (fields: Record<string, unknown> = {}) => (await call("/passengers", "POST", {
    name: "Pasajero Sintético", homeAddress: "Calle Inventada 101", homeLat: HOME_OF_PASSENGER[1], homeLng: HOME_OF_PASSENGER[0],
    companions: 0, frontSeat: false, wheelchair: false, maxRideTimeMinutes: 60, pickupDurationMinutes: 5, dropoffDurationMinutes: 5,
    ...fields,
  })).passenger.id as number;
  const route = async (fields: Record<string, unknown> = {}) =>
    (await call(`/daily-plans/${DAY}/routes`, "POST", { driverId, startTime: "07:00", endTime: "09:00", ...fields })).route.id as number;
  /** A Traslado assigned to `routeId`; entrada to the school by default. */
  const transfer = async (routeId: number, fields: Record<string, unknown> = {}) => {
    const passengerId = fields.passengerId ?? await passenger();
    const created = (await call(`/daily-plans/${DAY}/transfers`, "POST", {
      direction: "entrada", destinationId: school, targetTime: "08:00", ...fields, passengerId,
    })).transfer.id as number;
    await call(`/transfers/${created}`, "PATCH", { routeId }, 200);
    return created;
  };
  const order = (routeId: number, status = 200) => call(`/routes/${routeId}/order`, "POST", undefined, status);
  const view = () => call(`/daily-plans/${DAY}`, "GET", undefined, 200);
  return { office, call, school, therapy, vehicle, vehicleId, driverId, passenger, route, transfer, order, view };
}

const seconds = (time: string) => Number(time.slice(0, 2)) * 3600 + Number(time.slice(3)) * 60;

describe("the engine orders a Recorrido", () => {
  it("Rule 1: puts every Traslado of the Recorrido in the order or in the unassigned list, never dropping one", async () => {
    const engine = fakeEngine();
    const app = appWith(engine.solver);
    const w = await world("regla1", app, 2);
    const routeId = await w.route();
    const first = await w.transfer(routeId, { targetTime: "08:00" });
    const second = await w.transfer(routeId, { targetTime: "08:10" });
    const third = await w.transfer(routeId, { targetTime: "08:20" });

    const result = await w.order(routeId);
    const placed = new Set(result.stops.map((stop: { transferId: number }) => stop.transferId));
    const unassigned = result.unassigned.map((item: { transferId: number }) => item.transferId);
    expect([...placed, ...unassigned].sort()).toEqual([first, second, third].sort());
    expect([...placed].filter((id) => unassigned.includes(id))).toEqual([]);
    expect(result.unassigned).toEqual([{ transferId: third, reason: "capacity", passengerName: "Pasajero Sintético" }]);
    expect(result.stops.map((stop: { transferId: number; kind: string; position: number; plannedTime: string }) =>
      [stop.transferId, stop.kind, stop.position, stop.plannedTime])).toEqual([
      [first, "pickup", 1, "07:10"], [second, "pickup", 2, "07:20"], [first, "dropoff", 3, "08:00"], [second, "dropoff", 4, "08:10"],
    ]);

    // Shown, never hidden: the day lists it as an unassigned Traslado and the change log keeps the reason.
    const day = await w.view();
    expect(day.transfers.find((item: { id: number }) => item.id === third).routeId).toBeNull();
    expect(day.routes[0].stops.map((stop: { plannedTime: string }) => stop.plannedTime)).toEqual(["07:10", "07:20", "08:00", "08:10"]);
    expect((await changes("transfer")).at(-1)).toMatchObject({
      entity_id: String(third), action: "unassigned", before_data: { routeId }, after_data: { routeId: null, reason: "capacity" },
    });
    expect((await changes("route")).at(-1)).toMatchObject({ action: "ordered", after_data: { unassigned: [{ transferId: third, reason: "capacity" }] } });

    // Ordering again converges: the same order and nothing more leaves the Recorrido.
    const again = await w.order(routeId);
    expect(again.stops).toEqual(result.stops);
    expect(again.unassigned).toEqual([]);
  });

  it("Rule 2: reads the ride-time buffer and the speed factors per time band from configuration", async () => {
    const environment = {
      SERVER_EPOCH: "order-config", DATABASE_URL: "postgres://app:secret@localhost:5432/app",
      OSRM_URL: "http://127.0.0.1:5000", VROOM_URL: "http://127.0.0.1:3001",
    } as NodeJS.ProcessEnv;
    expect(readConfig(environment).planner).toEqual({
      rideTimeBufferMinutes: 5, speedFactors: [{ fromMinutes: 0, factor: 1 }], earlyToleranceMinutes: 15,
    });
    const configured = readConfig({ ...environment, RIDE_TIME_BUFFER_MINUTES: "10", SPEED_FACTORS: "12:00=0.9, 00:00=1,07:00=0.75" }).planner;
    expect(configured.rideTimeBufferMinutes).toBe(10);
    expect(configured.speedFactors).toEqual([{ fromMinutes: 0, factor: 1 }, { fromMinutes: 420, factor: 0.75 }, { fromMinutes: 720, factor: 0.9 }]);
    for (const value of ["-1", "2.5", "x"]) {
      expect(() => readConfig({ ...environment, RIDE_TIME_BUFFER_MINUTES: value })).toThrow("RIDE_TIME_BUFFER_MINUTES must be a whole number of minutes from 0");
    }
    for (const value of ["07:00", "07:00=0", "07:00=6", "7:00=1", ""]) {
      expect(() => readConfig({ ...environment, SPEED_FACTORS: value }), value)
        .toThrow("SPEED_FACTORS must be a comma-separated list of HH:MM=factor with factors above 0 and up to 5");
    }

    const engine = fakeEngine();
    const app = appWith(engine.solver, { planner: configured });
    const w = await world("regla2", app);
    const morning = await w.route({ startTime: "07:30", endTime: "09:00" });
    await w.transfer(morning, { targetTime: "08:00" });
    await w.order(morning);
    const [problem] = engine.problems;
    expect(problem.vehicles[0].speed_factor).toBe(0.75);
    // R' = 60 − 10: the pickup opens at 08:00 − 50 min + 5 min of drop-off.
    expect(problem.shipments[0].pickup.time_windows).toEqual([[seconds("07:15"), seconds("08:00")]]);
  });

  it("Rule 3: minimises km with a small non-zero cost per hour as the tiebreak", async () => {
    const engine = fakeEngine();
    const app = appWith(engine.solver);
    const w = await world("regla3", app);
    const routeId = await w.route();
    await w.transfer(routeId);
    await w.order(routeId);
    expect(engine.problems[0].vehicles[0].costs).toEqual({ per_km: 1000, per_hour: 60 });
    expect(engine.problems[0].vehicles[0].costs.per_hour).toBeGreaterThan(0);
  });

  it("Rule 4: keeps the Tolerancia de llegada on the Destino, from its kind by default and editable by the Oficina", async () => {
    const app = appWith();
    const w = await world("regla4", app);
    const listed = (await w.call("/destinations", "GET", undefined, 200)).destinations;
    expect(listed.map((item: { kind: string; arrivalToleranceMinutes: number }) => [item.kind, item.arrivalToleranceMinutes])).toEqual([
      ["school", 30], ["therapy", 0],
    ]);
    const dayCentre = (await w.call("/destinations", "POST", {
      name: "Centro de Día Sintético", kind: "day_centre", address: "Avenida Sintetica 303", lat: -26.8, lng: -65.2,
    })).destination;
    expect(dayCentre.arrivalToleranceMinutes).toBe(30);
    for (const [kind, tolerance] of [["clinic", 0], ["other", 0], ["school", 10]] as const) {
      const created = (await w.call("/destinations", "POST", {
        name: `Destino ${kind}`, kind, address: "Avenida Sintetica 303", lat: -26.8, lng: -65.2,
        ...(kind === "school" ? { arrivalToleranceMinutes: tolerance } : {}),
      })).destination;
      expect(created.arrivalToleranceMinutes, kind).toBe(tolerance);
    }

    const edited = await w.call(`/destinations/${w.therapy}`, "PATCH", { arrivalToleranceMinutes: 15 }, 200);
    expect(edited.destination).toMatchObject({ id: w.therapy, arrivalToleranceMinutes: 15 });
    expect((await changes("destination")).at(-1)).toMatchObject({
      entity_id: String(w.therapy), action: "updated", before_data: { arrivalToleranceMinutes: 0 }, after_data: { arrivalToleranceMinutes: 15 },
    });
    const logged = (await changes("destination")).length;
    for (const value of [-1, 241, 1.5, "10", null]) {
      expect((await request(app, `/destinations/${w.therapy}`, "PATCH", { arrivalToleranceMinutes: value }, w.office)).status, String(value)).toBe(400);
      expect((await request(app, "/destinations", "POST", {
        name: "Inválido", kind: "school", address: "Avenida Sintetica 303", lat: -26.8, lng: -65.2, arrivalToleranceMinutes: value ?? -5,
      }, w.office)).status, String(value)).toBe(400);
    }
    expect(await json(request(app, "/destinations/9999", "PATCH", { arrivalToleranceMinutes: 5 }, w.office), 404)).toEqual({ error: "Destino not found" });
    expect((await changes("destination")).length).toBe(logged);
    expect((await migrationPool.query("SELECT arrival_tolerance_minutes FROM destinations WHERE id = $1", [w.therapy])).rows[0])
      .toEqual({ arrival_tolerance_minutes: 15 });
  });

  it("Rule 5: plans arrival by T and accepts arrival up to T plus the Destino's Tolerancia de llegada", async () => {
    const onTime = fakeEngine();
    const planned = await world("regla5", appWith(onTime.solver));
    const plannedRoute = await planned.route();
    await planned.transfer(plannedRoute, { targetTime: "08:00" });
    expect((await planned.order(plannedRoute)).violations).toEqual([]);
    expect(onTime.problems[0].shipments[0].delivery.time_windows).toEqual([[seconds("07:45"), seconds("08:00")]]);

    // Arrival 20 minutes after T: inside the school's 30 minutes, outside the therapy centre's 0.
    const late = fakeEngine({ lateSeconds: 20 * 60 });
    const w = await world("regla5-late", appWith(late.solver));
    const routeId = await w.route();
    const toSchool = await w.transfer(routeId, { targetTime: "08:00", destinationId: w.school });
    const toTherapy = await w.transfer(routeId, { targetTime: "08:30", destinationId: w.therapy });
    const result = await w.order(routeId);
    const lateOnes = result.violations.filter((violation: { rule: string }) => violation.rule === "target_time_window_broken");
    expect(lateOnes.map((violation: { transferId: string }) => violation.transferId)).toEqual([String(toTherapy)]);
    expect(lateOnes.map((violation: { transferId: string }) => violation.transferId)).not.toContain(String(toSchool));
  });

  it("Rule 6: starts at the Chofer's home on the first Recorrido and after a long gap, chains from the previous one otherwise", async () => {
    const engine = fakeEngine();
    const app = appWith(engine.solver);
    const w = await world("regla6", app);
    const first = await w.route({ startTime: "07:00", endTime: "08:00" });
    await w.transfer(first, { targetTime: "08:00" });
    const chained = await w.route({ startTime: "08:30", endTime: "09:30" });
    await w.transfer(chained, { targetTime: "09:30", direction: "salida", destinationId: w.school });
    const afterGap = await w.route({ startTime: "13:00", endTime: "14:00" });
    await w.transfer(afterGap, { targetTime: "14:00" });

    await w.order(first);
    expect(engine.problems[0].vehicles[0].start).toEqual(HOME_OF_DRIVER);
    // Chained: starts at the school where the first Recorrido ended, not before its planned end (08:00 + 5 min of drop-off).
    await w.order(chained);
    expect(engine.problems[1].vehicles[0].start).toEqual(SCHOOL);
    expect(engine.problems[1].vehicles[0].time_window[0]).toBe(seconds("08:05"));
    await w.order(afterGap);
    expect(engine.problems[2].vehicles[0].start).toEqual(HOME_OF_DRIVER);

    // Another Vehículo on the next Recorrido: the Oficina sets the start.
    await w.call(`/routes/${chained}`, "PATCH", { vehicleId: await w.vehicle("OT001RO") }, 200);
    expect(await w.order(chained, 409)).toEqual({ error: "Set where this Recorrido starts: the previous Recorrido has another Vehículo or no Paradas" });
    expect(engine.problems).toHaveLength(3);
  });

  it("Rule 7: ends the Chofer's last Recorrido of the day at home and leaves the others open", async () => {
    const engine = fakeEngine();
    const w = await world("regla7", appWith(engine.solver));
    const morning = await w.route({ startTime: "07:00", endTime: "08:00" });
    await w.transfer(morning);
    const afternoon = await w.route({ startTime: "13:00", endTime: "14:00" });
    await w.transfer(afternoon, { targetTime: "14:00" });
    await w.order(morning);
    await w.order(afternoon);
    expect(engine.problems.map((problem) => problem.vehicles[0].end)).toEqual([undefined, HOME_OF_DRIVER]);
  });

  it("Rule 8: lets the Oficina override the start (home, previous Recorrido or a point) and the end (home or open)", async () => {
    const engine = fakeEngine();
    const app = appWith(engine.solver);
    const w = await world("regla8", app);
    const first = await w.route({ startTime: "07:00", endTime: "08:00" });
    const routeId = await w.route({ startTime: "08:30", endTime: "09:30" });
    await w.transfer(routeId, { targetTime: "09:30" });

    expect(await w.order(routeId, 409)).toEqual({ error: "Set where this Recorrido starts: the previous Recorrido has another Vehículo or no Paradas" });
    const point = await w.call(`/routes/${routeId}`, "PATCH", { startKind: "point", startLat: -26.81, startLng: -65.23, endKind: "home" }, 200);
    expect(point.route).toMatchObject({ startKind: "point", startLat: -26.81, startLng: -65.23, endKind: "home" });
    expect((await changes("route")).at(-1)).toMatchObject({
      action: "updated",
      before_data: { startKind: null, startLat: null, startLng: null, endKind: null },
      after_data: { startKind: "point", startLat: -26.81, startLng: -65.23, endKind: "home" },
    });
    await w.order(routeId);
    expect(engine.problems.at(-1)!.vehicles[0]).toMatchObject({ start: [-65.23, -26.81], end: HOME_OF_DRIVER });

    await w.call(`/routes/${routeId}`, "PATCH", { startKind: "home", endKind: "open" }, 200);
    await w.order(routeId);
    expect(engine.problems.at(-1)!.vehicles[0].start).toEqual(HOME_OF_DRIVER);
    expect(engine.problems.at(-1)!.vehicles[0].end).toBeUndefined();

    await w.call(`/routes/${routeId}`, "PATCH", { startKind: "previous" }, 200);
    expect(await w.order(routeId, 409)).toEqual({ error: "This Recorrido has no previous Recorrido with Paradas to start from" });
    await w.transfer(first, { targetTime: "08:00" });
    await w.order(first);
    await w.order(routeId);
    // The previous Recorrido's planned end (08:00 + 5 min) bounds the start; travel time is the engine's.
    expect(engine.problems.at(-1)!.vehicles[0]).toMatchObject({ start: SCHOOL, time_window: [seconds("08:05"), expect.any(Number)] });

    const reset = await w.call(`/routes/${routeId}`, "PATCH", { startKind: null, endKind: null }, 200);
    expect(reset.route).toMatchObject({ startKind: null, startLat: null, startLng: null, endKind: null });
    const logged = (await changes("route")).length;
    for (const body of [
      { startKind: "office" }, { startKind: "point" }, { startKind: "point", startLat: 91, startLng: -65.2 },
      { startKind: "home", startLat: -26.8, startLng: -65.2 }, { startLat: -26.8, startLng: -65.2 }, { endKind: "previous" }, {},
    ]) expect((await request(app, `/routes/${routeId}`, "PATCH", body, w.office)).status, JSON.stringify(body)).toBe(400);
    expect((await changes("route")).length).toBe(logged);
  });

  it("Rule 9: sends seats and the Asiento delantero as capacity, with each Acompañante taking a seat", async () => {
    const engine = fakeEngine();
    const w = await world("regla9", appWith(engine.solver), 5);
    const routeId = await w.route();
    await w.transfer(routeId, { passengerId: await w.passenger({ frontSeat: true, companions: 1 }) });
    await w.transfer(routeId, { passengerId: await w.passenger({ companions: 2 }), companions: 1 });
    await w.order(routeId);
    const [problem] = engine.problems;
    expect(problem.vehicles[0].capacity).toEqual([5, 1]);
    expect(problem.shipments.map((shipment) => shipment.amount)).toEqual([[2, 1], [2, 0]]);
  });

  it("Rule 10: flags a Recorrido that carries an Asiento delantero Pasajero when assigning and when changing its Vehículo", async () => {
    const app = appWith();
    const w = await world("regla10", app);
    const routeId = await w.route();
    const plain = await w.route({ startTime: "10:00", endTime: "11:00" });
    expect((await w.view()).routes.map((route: { frontSeat: boolean }) => route.frontSeat)).toEqual([false, false]);
    await w.transfer(routeId, { passengerId: await w.passenger({ frontSeat: true }) });
    await w.transfer(plain);
    expect((await w.view()).routes.map((route: { id: number; frontSeat: boolean }) => [route.id, route.frontSeat])).toEqual([
      [routeId, true], [plain, false],
    ]);
    const changed = await w.call(`/routes/${routeId}`, "PATCH", { vehicleId: await w.vehicle("FR001NT") }, 200);
    expect(changed.route.frontSeat).toBe(true);
  });

  it("Rule 11: makes an entrada that starts at another Destino a pickup there and a drop-off at the second Destino by its entry time", async () => {
    const engine = fakeEngine();
    const w = await world("regla11", appWith(engine.solver));
    const routeId = await w.route({ startTime: "14:00", endTime: "15:00" });
    const leg = await w.transfer(routeId, { originDestinationId: w.therapy, destinationId: w.school, targetTime: "15:00" });
    const result = await w.order(routeId);
    const [shipment] = engine.problems[0].shipments;
    expect(shipment.pickup).toMatchObject({ location: THERAPY, time_windows: [[seconds("14:10"), seconds("15:00")]] });
    expect(shipment.delivery).toMatchObject({ location: SCHOOL, time_windows: [[seconds("14:45"), seconds("15:00")]] });
    expect(result.stops.map((stop: { transferId: number; kind: string; placeName: string }) => [stop.transferId, stop.kind, stop.placeName])).toEqual([
      [leg, "pickup", "Terapia regla11"], [leg, "dropoff", "Escuela regla11"],
    ]);
  });

  it("Rule 12: starts a Recorrido after a gap of 2 hours or more at the Chofer's home", async () => {
    const engine = fakeEngine();
    const w = await world("regla12", appWith(engine.solver));
    const morning = await w.route({ startTime: "07:00", endTime: "08:00" });
    await w.transfer(morning, { targetTime: "08:00" });
    const later = await w.route({ startTime: "10:05", endTime: "11:00" });
    await w.transfer(later, { targetTime: "11:00" });
    await w.order(morning);
    await w.order(later);
    expect(engine.problems[1].vehicles[0].start).toEqual(HOME_OF_DRIVER);
  });

  it("Rule 13: lists the Traslados that do not fit with their reason and never splits the Recorrido or adds a Vehículo", async () => {
    const engine = fakeEngine();
    const app = appWith(engine.solver);
    const w = await world("regla13", app, 5);
    const feature = (await w.call("/vehicle-features", "POST", { name: "Rampa sintética" })).feature.id as number;
    const routeId = await w.route();
    const fits: number[] = [];
    for (let index = 0; index < 5; index++) fits.push(await w.transfer(routeId));
    const noSeat = await w.transfer(routeId);
    const tooShort = await w.transfer(routeId, { passengerId: await w.passenger({ maxRideTimeMinutes: 12 }) });
    const ramp = await w.transfer(routeId, { passengerId: await w.passenger({ featureIds: [feature] }) });

    const result = await w.order(routeId);
    expect(result.unassigned.map((item: { transferId: number; reason: string }) => [item.transferId, item.reason])).toEqual([
      [noSeat, "capacity"], [tooShort, "time_window"], [ramp, "adaptation"],
    ]);
    expect(new Set(result.stops.map((stop: { transferId: number }) => stop.transferId))).toEqual(new Set(fits));
    expect(engine.problems.every((problem) => problem.vehicles.length === 1)).toBe(true);
    const day = await w.view();
    expect(day.routes).toHaveLength(1);
    expect(day.transfers.filter((item: { routeId: number | null }) => item.routeId === null).map((item: { id: number }) => item.id).sort())
      .toEqual([noSeat, tooShort, ramp].sort());
  });

  it("orders only a Borrador Recorrido and leaves the order untouched when the engine does not answer", async () => {
    const down = fakeEngine({ fail: true });
    const app = appWith(down.solver);
    const w = await world("borrador", app);
    const routeId = await w.route();
    await w.transfer(routeId);
    const before = (await w.view()).routes[0].stops;

    expect(await w.order(routeId, 502)).toEqual({ error: "The routing engine is unavailable: the order was not changed" });
    expect((await w.view()).routes[0].stops).toEqual(before);
    expect((await changes("route")).map((row) => row.action)).not.toContain("ordered");

    expect(await json(request(appWith(), `/routes/${routeId}/order`, "POST", undefined, w.office), 503))
      .toEqual({ error: "The routing engine is not configured" });
    await migrationPool.query("UPDATE routes SET status = 'publicado' WHERE id = $1", [routeId]);
    expect(await w.order(routeId, 409)).toEqual({ error: "Only a Borrador Recorrido can be ordered" });
    expect(await w.order(9999, 404)).toEqual({ error: "Recorrido not found" });
    expect(down.problems).toHaveLength(1);
  });

  it("lets the planner still reorder by hand after Order, which clears the planned times", async () => {
    const engine = fakeEngine();
    const w = await world("a-mano", appWith(engine.solver));
    const routeId = await w.route();
    await w.transfer(routeId, { targetTime: "08:00" });
    await w.transfer(routeId, { targetTime: "08:30" });
    const ordered = await w.order(routeId);
    expect((await w.view()).routes[0].km).toBe(4);
    const [ap, bp, ad, bd] = ordered.stops.map((stop: { id: number }) => stop.id);
    await w.call(`/routes/${routeId}/stops`, "PATCH", { stopIds: [ap, ad, bp, bd] }, 200);
    const day = await w.view();
    expect(day.routes[0].stops.map((stop: { id: number; plannedTime: string | null }) => [stop.id, stop.plannedTime])).toEqual([
      [ap, null], [ad, null], [bp, null], [bd, null],
    ]);
    expect(day.routes[0].km).toBeNull();
  });

  it("lets only the Oficina order a Recorrido or edit a Destino's Tolerancia de llegada", async () => {
    const app = appWith(fakeEngine().solver);
    await seedUser("chofer-orden", "driver");
    const login = await request(app, "/auth/login", "POST", { username: "chofer-orden", password: "chofer-orden-password", deviceLabel: "Test browser" });
    const chofer = getSessionCookie(login).cookie;
    for (const [method, path, body] of [
      ["POST", "/routes/1/order", undefined],
      ["PATCH", "/destinations/1", { arrivalToleranceMinutes: 10 }],
    ] as const) {
      expect((await request(app, path, method, body)).status, `${method} ${path} without session`).toBe(401);
      expect((await request(app, path, method, body, chofer)).status, `${method} ${path} as Chofer`).toBe(403);
    }
  });
});
