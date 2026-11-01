import { describe, expect, it } from "vitest";
import type { VroomProblem, VroomSolver } from "../src/planner.js";
import { createExecutionHarness, HOME, TODAY } from "./helpers/execution.js";

type Window = number[][];
type Job = { id: number; location: number[]; service: number; delivery: number[]; time_windows: Window };
type Shipment = { pickup: { id: number; time_windows: Window }; delivery: { id: number; time_windows: Window } };
type Problem = { vehicles: { start: number[]; time_window: number[] }[]; jobs?: Job[]; shipments: Shipment[] };

// Stand-in for VROOM: the on-board drop-offs first, then each Traslado picked up when its window opens and dropped off when
// its drop-off window closes. With `dropJobs` it places no on-board drop-off.
const engine = { problems: [] as Problem[], dropJobs: false };
const solver: VroomSolver = async (problem: VroomProblem) => {
  const typed = problem as unknown as Problem;
  engine.problems.push(typed);
  const jobs = engine.dropJobs ? [] : typed.jobs ?? [];
  const steps = [
    { type: "start", arrival: 0, distance: 0 },
    ...jobs.map((job) => ({ type: "job", id: job.id, arrival: job.time_windows[0][0], distance: 0 })),
    ...typed.shipments.flatMap((shipment) => [
      { type: "pickup", id: shipment.pickup.id, arrival: shipment.pickup.time_windows[0][0], distance: 0 },
      { type: "delivery", id: shipment.delivery.id, arrival: shipment.delivery.time_windows[0][1], distance: 0 },
    ]),
  ];
  return { unassigned: engine.dropJobs ? (typed.jobs ?? []).map((job) => ({ id: job.id, type: "job" })) : [], routes: [{ steps }] };
};

const h = createExecutionHarness("republish-test", {}, { solver, travelTime: async () => 600 });
const SCHOOL_LNG_LAT = [-65.2, -26.82];
const DONE_STOPS_FIRST = "A done Parada never changes: done Paradas stay first, in the order of the latest version";

type Setup = Awaited<ReturnType<typeof h.setup>>;
type Leg = { transferId: number; kind: string };

/** The phone's clock at a local time of the test day. */
function at(time: string) {
  h.clock.now = new Date(`${TODAY}T${time}:00-03:00`);
}

async function versions(s: Setup, routeId: number) {
  return (await h.answer(h.request(`/routes/${routeId}/versions`, "GET", undefined, s.office), 200)).versions;
}

async function stopsOf(s: Setup, routeId: number) {
  const day = await h.answer(h.request(`/daily-plans/${TODAY}`, "GET", undefined, s.office), 200);
  return day.routes.find((route: { id: number }) => route.id === routeId).stops;
}

const pairs = (legs: Leg[]) => legs.map((leg) => [leg.transferId, leg.kind]);

/**
 * A Recorrido of three salidas from the school (13:00, 13:15 and 13:30), published as version 1: the first Pasajero was
 * picked up and handed over at home, and the second got on at 13:16 and is on board.
 */
async function onBoardDay(name: string) {
  const s = await h.setup(name);
  const driver = await s.chofer();
  const routeId = await s.route(driver.driverId);
  const [a, b, c] = [await s.passenger(), await s.passenger(), await s.passenger()];
  const ta = await s.transfer(a.passengerId, "salida", "13:00");
  const tb = await s.transfer(b.passengerId, "salida", "13:15");
  const tc = await s.transfer(c.passengerId, "salida", "13:30");
  for (const transferId of [ta, tb, tc]) await s.assign(transferId, routeId);
  await s.publish(routeId);
  at("12:58");
  await h.answer(h.mark(driver.cookie, routeId, h.markBody(ta, "subio")), 201);
  at("13:05");
  await h.answer(h.mark(driver.cookie, routeId, h.markBody(ta, "entregado", { receiver: { kind: "authorized_adult", adultId: a.guardian } })), 201);
  at("13:16");
  await h.answer(h.mark(driver.cookie, routeId, h.markBody(tb, "subio")), 201);
  return { s, driver, routeId, ta, tb, tc };
}

async function order(s: Setup, routeId: number) {
  return await h.answer(h.request(`/routes/${routeId}/order`, "POST", undefined, s.office), 200);
}

describe("republishing a Recorrido En curso", () => {
  it("Rule 1: a done Parada never changes in a later version, even a forced one, and cannot be moved by hand", async () => {
    const s = await h.setup("rule-1");
    const driver = await s.chofer();
    const routeId = await s.route(driver.driverId);
    const [a, b, c] = [await s.passenger(), await s.passenger(), await s.passenger()];
    const ta = await s.transfer(a.passengerId, "entrada", "08:00");
    const tb = await s.transfer(b.passengerId, "entrada", "08:30");
    await s.assign(ta, routeId);
    await s.assign(tb, routeId);
    await s.publish(routeId);
    at("07:52");
    await h.answer(h.mark(driver.cookie, routeId, h.markBody(ta, "subio")), 201);
    at("07:59");
    await h.answer(h.mark(driver.cookie, routeId, h.markBody(ta, "entregado", { receiver: { kind: "destination", destinationId: s.school } })), 201);

    // A pickup added too late to arrive on time: the Oficina forces it, and only what is still to come moves.
    const tc = await s.transfer(c.passengerId, "entrada", "08:30");
    await s.assign(tc, routeId);
    expect((await s.post(`/routes/${routeId}/publish`, { overrideReason: "Pickup added during the day" })).version.version).toBe(2);
    const [v1, v2] = await versions(s, routeId);
    expect(pairs(v2.legs.slice(0, 2))).toEqual([[ta, "pickup"], [ta, "dropoff"]]);
    expect(v2.legs.slice(0, 2)).toEqual(v1.legs.slice(0, 2));

    const before = await stopsOf(s, routeId);
    const ids = before.map((stop: { id: number }) => stop.id);
    expect(await h.answer(h.request(`/routes/${routeId}/stops`, "PATCH", { stopIds: [ids[2], ids[0], ids[1], ...ids.slice(3)] }, s.office), 409))
      .toEqual({ error: DONE_STOPS_FIRST });
    expect(await stopsOf(s, routeId)).toEqual(before);
  });

  it("Rule 1: Order on an En curso Recorrido keeps the done Paradas first and gives the engine the Pasajero on board as a drop-off by Subió + Tiempo máximo a bordo − margin", async () => {
    const { s, routeId, ta, tb, tc } = await onBoardDay("rule-1-order");
    engine.dropJobs = false;
    const ordered = await order(s, routeId);

    const problem = engine.problems.at(-1)!;
    // From where the Pasajero on board got on (the school), once that pickup ended (planned 13:13:20 + 5 min) and after 13:16.
    expect(problem.vehicles[0].start).toEqual(SCHOOL_LNG_LAT);
    expect(problem.vehicles[0].time_window[0]).toBe((13 * 60 + 19) * 60);
    // Subió 13:16 + 60 min − 5 min margin − 5 min drop-off service: the drop-off starts by 14:06.
    expect(problem.jobs).toEqual([{
      id: tb, location: [HOME.lng, HOME.lat], service: 300, delivery: [1, 0], time_windows: [[(13 * 60 + 16) * 60, (14 * 60 + 6) * 60]], priority: 100,
    }]);
    expect(problem.shipments.map((shipment) => shipment.pickup.id)).toEqual([tc]);
    expect(ordered.unassigned).toEqual([]);
    expect(pairs(ordered.stops)).toEqual([[ta, "pickup"], [ta, "dropoff"], [tb, "pickup"], [tb, "dropoff"], [tc, "pickup"], [tc, "dropoff"]]);

    expect(await s.publish(routeId)).toBe(2);
    const [v1, v2] = await versions(s, routeId);
    expect(v2.legs.slice(0, 3)).toEqual(v1.legs.slice(0, 3));
  });

  it("Rule 2: an on-board child stays in their Recorrido and Vehículo: moving them is refused and the engine never drops them", async () => {
    const { s, routeId, tb } = await onBoardDay("rule-2");
    const other = await s.route((await s.chofer()).driverId);
    const before = await stopsOf(s, routeId);
    expect(await h.answer(h.request(`/transfers/${tb}`, "PATCH", { routeId: other }, s.office), 409))
      .toEqual({ error: "Only a Planificado Traslado can change Recorrido" });
    expect(await stopsOf(s, routeId)).toEqual(before);

    // Even when the engine cannot place their drop-off, it stays in this Recorrido, right after what was done.
    engine.dropJobs = true;
    const ordered = await order(s, routeId);
    engine.dropJobs = false;
    expect(ordered.unassigned).toEqual([]);
    expect(pairs(ordered.stops)[3]).toEqual([tb, "dropoff"]);

    expect(await s.publish(routeId)).toBe(2);
    const [v1, v2] = await versions(s, routeId);
    expect(v2.vehicleId).toBe(v1.vehicleId);
    expect(v2.transfers.map((transfer: { transferId: number }) => transfer.transferId)).toContain(tb);
    expect(await h.rows("SELECT status FROM transfers WHERE id = $1", [tb])).toEqual([{ status: "subio" }]);
  });

  it("Rule 3: version N+1 adds a new Traslado to an En curso Recorrido, such as an early pickup at the Destino after a crisis", async () => {
    const s = await h.setup("rule-3");
    const driver = await s.chofer();
    const routeId = await s.route(driver.driverId);
    const [a, b] = [await s.passenger(), await s.passenger()];
    const ta = await s.transfer(a.passengerId, "entrada", "08:00");
    const tb = await s.transfer(b.passengerId, "entrada", "08:30");
    await s.assign(ta, routeId);
    await s.assign(tb, routeId);
    await s.publish(routeId);
    at("07:52");
    await h.answer(h.mark(driver.cookie, routeId, h.markBody(ta, "subio")), 201);
    at("07:59");
    await h.answer(h.mark(driver.cookie, routeId, h.markBody(ta, "entregado", { receiver: { kind: "destination", destinationId: s.school } })), 201);

    // "se descompensan en la institución y lo tenemos que buscar": the first Pasajero goes back home at 08:40.
    const early = await s.transfer(a.passengerId, "salida", "08:40");
    await s.assign(early, routeId);
    expect(await s.publish(routeId)).toBe(2);
    const [v1, v2] = await versions(s, routeId);
    expect(v2.violations).toEqual([]);
    expect(v2.transfers.map((transfer: { transferId: number }) => transfer.transferId)).toEqual([ta, tb, early].sort((x, y) => x - y));
    expect(v2.legs.slice(0, 2)).toEqual(v1.legs.slice(0, 2));
    expect(await h.rows("SELECT status FROM routes WHERE id = $1", [routeId])).toEqual([{ status: "en_curso" }]);
  });

  it("the driver app gets what changed since the version the Chofer acknowledged", async () => {
    const { s, driver, routeId } = await onBoardDay("changes");
    await h.answer(h.request(`/driver/routes/${routeId}/acknowledgements`, "POST", { version: 1 }, driver.cookie), 201);
    const spare = (await s.post("/vehicles", { plate: "CHG900", model: "Furgón Sintético", seats: 8 })).vehicle.id as number;
    await h.answer(h.request(`/routes/${routeId}`, "PATCH", { vehicleId: spare }, s.office), 200);
    const d = await s.passenger();
    const td = await s.transfer(d.passengerId, "salida", "14:00");
    await s.assign(td, routeId);
    expect(await s.publish(routeId)).toBe(2);

    const day = await h.answer(h.request(`/driver/days/${TODAY}`, "GET", undefined, driver.cookie), 200);
    expect(day.routes[0].changes).toEqual({
      sinceVersion: 1,
      items: [{ kind: "vehicle", from: "CHA001", to: "CHG900" }, { kind: "added", transferId: td, passengerName: "Pasajero Sintético 4" }],
    });
  });

  it("Rule 4: a replacement Vehículo for the same Chofer is revalidated for capacity, Adaptaciones and Asiento delantero, and the Pasajero on board stays Subió", async () => {
    const s = await h.setup("rule-4");
    const ramp = (await s.post("/vehicle-features", { name: "Rampa rule-4" })).feature.id as number;
    const van = async (plate: string, seats: number, featureIds: number[]) =>
      (await s.post("/vehicles", { plate, model: "Furgón Sintético", seats, featureIds })).vehicle.id as number;
    const [usual, small, plain, spare] = [await van("RQ4001", 8, [ramp]), await van("RQ4002", 2, [ramp]), await van("RQ4003", 8, []), await van("RQ4004", 8, [ramp])];
    const passenger = async (fields: Record<string, unknown>) => {
      const passengerId = (await s.post("/passengers", {
        name: "Pasajero Sintético", homeAddress: "Calle Inventada 101", homeLat: HOME.lat, homeLng: HOME.lng, companions: 0,
        frontSeat: true, wheelchair: false, maxRideTimeMinutes: 60, pickupDurationMinutes: 5, dropoffDurationMinutes: 5, ...fields,
      })).passenger.id as number;
      const guardian = (await s.post(`/passengers/${passengerId}/authorized-adults`, {
        name: "Madre Sintética", dni: "-3000001", relation: "madre", phone: "381-000-3001", legalGuardian: true,
      })).adult.id as number;
      await s.post(`/passengers/${passengerId}/consent`, { signedByAdultId: guardian, signedAt: "2026-10-01", otherAdultAllowed: false });
      return passengerId;
    };
    // On board: two Acompañantes (3 seats), the ramp and the Asiento delantero. Still to pick up: another front-seat Pasajero.
    const a = await passenger({ companions: 2, featureIds: [ramp] });
    const b = await passenger({});
    const driver = await s.chofer();
    const routeId = await s.route(driver.driverId);
    const patch = async (body: unknown, status = 200) => await h.answer(h.request(`/routes/${routeId}`, "PATCH", body, s.office), status);
    await patch({ vehicleId: usual });
    const ta = await s.transfer(a, "salida", "13:00");
    const tb = await s.transfer(b, "salida", "13:15");
    await s.assign(ta, routeId);
    await s.assign(tb, routeId);
    await s.publish(routeId);
    at("12:59");
    await h.answer(h.mark(driver.cookie, routeId, h.markBody(ta, "subio")), 201);

    // Another Chofer would be a Trasbordo, not a replacement Vehículo.
    expect(await patch({ driverId: (await s.chofer()).driverId }, 409)).toEqual({ error: "A Recorrido En curso or Cerrado cannot change Chofer" });
    const broken = async () => {
      const refused = await h.answer(h.request(`/routes/${routeId}/publish`, "POST", {}, s.office), 409);
      return refused.violations.flatMap((group: { violations: { rule: string }[] }) => group.violations.map((violation) => violation.rule));
    };
    await patch({ vehicleId: small });
    expect(await broken()).toContain("capacity_exceeded");
    await patch({ vehicleId: plain });
    expect(await broken()).toContain("missing_adaptation");
    await patch({ vehicleId: spare });
    const ids = (await stopsOf(s, routeId)).map((stop: { id: number }) => stop.id);
    await h.answer(h.request(`/routes/${routeId}/stops`, "PATCH", { stopIds: [ids[0], ids[2], ids[1], ids[3]] }, s.office), 200);
    expect(await broken()).toContain("front_seat_shared");
    await h.answer(h.request(`/routes/${routeId}/stops`, "PATCH", { stopIds: ids }, s.office), 200);

    expect(await s.publish(routeId)).toBe(2);
    const [v1, v2] = await versions(s, routeId);
    expect([v2.vehicleId, v2.driverId, v2.violations]).toEqual([spare, v1.driverId, []]);
    expect(await h.rows("SELECT status FROM transfers WHERE id = $1", [ta])).toEqual([{ status: "subio" }]);
  });
});
