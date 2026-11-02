import { describe, expect, it } from "vitest";
import type { VroomProblem, VroomSolver } from "../src/planner.js";
import { createExecutionHarness, HOME, TODAY } from "./helpers/execution.js";

type Window = number[][];
type Shipment = { pickup: { id: number; location: number[]; time_windows: Window }; delivery: { id: number; location: number[]; time_windows: Window } };
type Problem = { jobs?: { id: number; time_windows: Window }[]; shipments: Shipment[] };

// Stand-in for VROOM: each Traslado picked up at `pickupAt` (or when its window opens) and dropped off when its drop-off
// window closes; on-board drop-offs first.
const engine = { problems: [] as Problem[], pickupAt: null as number | null };
const solver: VroomSolver = async (problem: VroomProblem) => {
  const typed = problem as unknown as Problem;
  engine.problems.push(typed);
  const steps = [
    { type: "start", arrival: 0, distance: 0 },
    ...(typed.jobs ?? []).map((job) => ({ type: "job", id: job.id, arrival: job.time_windows[0][0], distance: 0 })),
    ...typed.shipments.flatMap((shipment) => [
      { type: "pickup", id: shipment.pickup.id, arrival: engine.pickupAt ?? shipment.pickup.time_windows[0][0], distance: 0 },
      { type: "delivery", id: shipment.delivery.id, arrival: shipment.delivery.time_windows[0][1], distance: 0 },
    ]),
  ];
  return { unassigned: [], routes: [{ steps }] };
};

const h = createExecutionHarness("trasbordo-test", {}, { solver, travelTime: async () => 600 });
// Synthetic Trasbordo points: one near the school, one far from home.
const NEAR_SCHOOL = { lat: -26.825, lng: -65.205 };
const FAR = { lat: -26.8, lng: -65.25 };

type Setup = Awaited<ReturnType<typeof h.setup>>;

/** The clock (the phone's and the Oficina's) at a local time of the test day. */
function at(time: string) {
  h.clock.now = new Date(`${TODAY}T${time}:00-03:00`);
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const seconds = (time: string) => minutes(time) * 60;

async function day(s: Setup) {
  return await h.answer(h.request(`/daily-plans/${TODAY}`, "GET", undefined, s.office), 200);
}

async function versions(s: Setup, routeId: number) {
  return (await h.answer(h.request(`/routes/${routeId}/versions`, "GET", undefined, s.office), 200)).versions;
}

async function history(s: Setup, transferId: number) {
  return await h.answer(h.request(`/transfers/${transferId}/history`, "GET", undefined, s.office), 200);
}

async function trasbordo(s: Setup, transferId: number, body: Record<string, unknown>, status = 201) {
  return await h.answer(h.request(`/transfers/${transferId}/trasbordo`, "POST", body, s.office), status);
}

async function plan(s: Setup, transferId: number, body: Record<string, unknown>, status = 201) {
  return await h.answer(h.request(`/transfers/${transferId}/planned-trasbordo`, "POST", body, s.office), status);
}

/**
 * A breakdown: the first Chofer's Vehículo carries a Pasajero on an entrada to the school at 08:00 who got on at 07:00;
 * a second Chofer has a published Recorrido with their own entrada at 08:30.
 */
async function breakdownDay(name: string) {
  const s = await h.setup(name);
  const a = await s.passenger();
  const other = await s.passenger();
  const giving = await s.served(a.passengerId, "entrada", "08:00");
  const receiving = await s.served(other.passengerId, "entrada", "08:30");
  at("07:00");
  await h.answer(h.mark(giving.driver.cookie, giving.routeId, h.markBody(giving.transferId, "subio")), 201);
  return { s, giving, receiving, legA: giving.transferId };
}

/** A planned Trasbordo at 08:00 at FAR for an entrada to the school at 08:30: leg A in the first Recorrido, B in the second. */
async function plannedDay(name: string) {
  const s = await h.setup(name);
  const a = await s.passenger();
  const [first, second] = [await s.chofer(), await s.chofer()];
  const [fromRouteId, toRouteId] = [await s.route(first.driverId), await s.route(second.driverId)];
  const legA = await s.transfer(a.passengerId, "entrada", "08:30");
  const split = await plan(s, legA, { lat: FAR.lat, lng: FAR.lng, time: "08:00", fromRouteId, toRouteId });
  return { s, a, first, second, fromRouteId, toRouteId, legA, legB: split.legB.id as number, split };
}

describe("Trasbordo", () => {
  it("Regla 1: a Trasbordo is the only way a Pasajero in Subió changes Recorrido", async () => {
    const { s, giving, receiving, legA } = await breakdownDay("rule-1");
    // Moving the Traslado by hand is refused while the Pasajero is on board, and so is a Trasbordo of a Pasajero not on board.
    expect(await h.answer(h.request(`/transfers/${legA}`, "PATCH", { routeId: receiving.routeId }, s.office), 409))
      .toEqual({ error: "Only a Planificado Traslado can change Recorrido" });
    expect(await trasbordo(s, receiving.transferId, { routeId: giving.routeId, ...NEAR_SCHOOL }, 409))
      .toEqual({ error: "Only a Pasajero on board (Subió) can be handed over in a Trasbordo" });
    expect(await trasbordo(s, legA, { routeId: giving.routeId, ...NEAR_SCHOOL }, 409))
      .toEqual({ error: "A Trasbordo hands the Pasajero over to another Recorrido" });
    // A breakdown Trasbordo needs the place.
    expect(await trasbordo(s, legA, { routeId: receiving.routeId }, 400)).toEqual({ error: "A Trasbordo needs the place where it happens" });

    at("07:50");
    const result = await trasbordo(s, legA, { routeId: receiving.routeId, ...NEAR_SCHOOL });
    const plan = await day(s);
    const legB = plan.transfers.find((transfer: { id: number }) => transfer.id === result.legB.id);
    expect(plan.transfers.find((transfer: { id: number }) => transfer.id === legA)).toMatchObject({ status: "entregado", routeId: giving.routeId });
    expect(legB).toMatchObject({ status: "subio", routeId: receiving.routeId, chainedFromTransferId: legA });
    // A repeated Trasbordo returns the recorded one instead of a second leg.
    const again = await trasbordo(s, legA, { routeId: receiving.routeId, ...NEAR_SCHOOL }, 200);
    expect(again.legB.id).toBe(result.legB.id);
    expect(again.marks).toEqual(result.marks);
    expect((await day(s)).transfers.filter((transfer: { passengerId: number }) => transfer.passengerId === legB.passengerId)).toHaveLength(2);
  });

  it("AC1 / Regla 5: records, linked, an Entregado to the receiving Chofer in the original Recorrido and a Subió in the receiving one, same place and time", async () => {
    const { s, giving, receiving, legA } = await breakdownDay("ac-1");
    at("07:50");
    const result = await trasbordo(s, legA, { routeId: receiving.routeId, ...NEAR_SCHOOL });
    const time = new Date(`${TODAY}T07:50:00-03:00`).toISOString();
    expect(result.marks.entregado).toMatchObject({
      transferId: legA, routeId: giving.routeId, kind: "entregado", phoneTime: time, location: NEAR_SCHOOL,
      receiver: { kind: "driver", driverId: receiving.driver.driverId },
    });
    expect(result.marks.subio).toMatchObject({
      transferId: result.legB.id, routeId: receiving.routeId, kind: "subio", phoneTime: time, location: NEAR_SCHOOL, receiver: null,
      trasbordoOf: result.marks.entregado.id,
    });
    expect(result.legA.trasbordo).toEqual({ stop: "dropoff", ...NEAR_SCHOOL, time: "07:50" });
    expect(result.legB.trasbordo).toEqual({ stop: "pickup", ...NEAR_SCHOOL, time: "07:50" });
    // The marks are those of both Traslados' histories, made by the Oficina.
    expect((await history(s, legA)).marks.at(-1)).toMatchObject({ id: result.marks.entregado.id, author: { role: "office" } });
    expect((await history(s, result.legB.id)).marks).toEqual([expect.objectContaining({ id: result.marks.subio.id })]);
  });

  it("AC2 / Regla 2: the receiving Recorrido is revalidated with the ride counted from the original Subió", async () => {
    const { s, receiving, legA } = await breakdownDay("rule-2");
    at("07:50");
    const result = await trasbordo(s, legA, { routeId: receiving.routeId, ...NEAR_SCHOOL });
    // Leg B is delivered first, at 08:00 (+5 min service): 65 min since the Subió at 07:00, over the 60-minute limit.
    // From its own Subió at 07:50 it would be 15 minutes.
    expect(result.publication).toMatchObject({ error: "The Recorrido breaks limits: fix it or publish it with a reason" });
    expect(result.publication.violations).toEqual([expect.objectContaining({
      violations: [expect.objectContaining({ rule: "max_ride_time_exceeded", transferId: result.legB.id, message: expect.stringContaining("(65 min)") })],
    })]);
    const forced = await s.post(`/routes/${receiving.routeId}/publish`, { overrideReason: "Breakdown: Trasbordo at the roadside" });
    expect(forced.version.version).toBe(2);
    expect(forced.version.legs.map((leg: { transferId: number; kind: string }) => [leg.transferId, leg.kind]).slice(0, 2))
      .toEqual([[result.legB.id, "pickup"], [result.legB.id, "dropoff"]]);
    expect(forced.version.legs[0].plannedTime).toBe("07:50");
  });

  it("AC3: both Choferes see the change, and it is logged on both Traslados", async () => {
    const { s, giving, receiving, legA } = await breakdownDay("ac-3");
    at("07:50");
    const result = await trasbordo(s, legA, { routeId: receiving.routeId, ...NEAR_SCHOOL, overrideReason: "Breakdown" });
    expect(result.publication.version.version).toBe(2);
    at("07:51");
    const givingDay = await h.answer(h.request(`/driver/days/${TODAY}`, "GET", undefined, giving.driver.cookie), 200);
    expect(givingDay.routes[0].stops.filter((stop: { transferId: number }) => stop.transferId === legA)
      .map((stop: { transferStatus: string; place: { name: string | null } }) => [stop.transferStatus, stop.place.name]))
      .toEqual([["entregado", null], ["entregado", "Trasbordo"]]);
    const receivingDay = await h.answer(h.request(`/driver/days/${TODAY}`, "GET", undefined, receiving.driver.cookie), 200);
    expect(receivingDay.routes[0]).toMatchObject({ version: 2, changes: { items: expect.arrayContaining([expect.objectContaining({ kind: "added", transferId: result.legB.id })]) } });
    expect(receivingDay.routes[0].stops[0]).toMatchObject({
      transferId: result.legB.id, kind: "pickup", transferStatus: "subio", place: { name: "Trasbordo", address: `${NEAR_SCHOOL.lat}, ${NEAR_SCHOOL.lng}` },
    });
    const handover = { fromRouteId: giving.routeId, toRouteId: receiving.routeId, legAId: legA, legBId: result.legB.id, ...NEAR_SCHOOL };
    expect((await history(s, legA)).changes.at(-1)).toMatchObject({ action: "trasbordo", after: { status: "entregado", ...handover } });
    expect((await history(s, result.legB.id)).changes).toEqual([expect.objectContaining({ action: "trasbordo", after: expect.objectContaining({ status: "subio", ...handover }) })]);
  });

  it("AC4 / Regla 3: the Oficina fixes the place and time; the Traslado is split into legs A and B, each pinned to its Recorrido with [t, t + 5] at the point", async () => {
    const { s, fromRouteId, toRouteId, legA, legB, split } = await plannedDay("rule-3");
    expect(split.legA).toMatchObject({ id: legA, routeId: fromRouteId, chainedToTransferId: legB, trasbordo: { stop: "dropoff", ...FAR, time: "08:00" } });
    expect(split.legB).toMatchObject({
      routeId: toRouteId, chainedFromTransferId: legA, direction: "entrada", targetTime: "08:30", trasbordo: { stop: "pickup", ...FAR, time: "08:00" },
    });
    // Each leg is a normal job of its own Recorrido, with the Trasbordo point where the Oficina put it.
    engine.pickupAt = seconds("07:45");
    await h.answer(h.request(`/routes/${fromRouteId}/order`, "POST", undefined, s.office), 200);
    engine.pickupAt = null;
    expect(engine.problems.at(-1)!.shipments).toEqual([expect.objectContaining({
      delivery: expect.objectContaining({ id: legA, location: [FAR.lng, FAR.lat], time_windows: [[seconds("08:00"), seconds("08:05")]] }),
    })]);
    await h.answer(h.request(`/routes/${toRouteId}/order`, "POST", undefined, s.office), 200);
    expect(engine.problems.at(-1)!.shipments).toEqual([expect.objectContaining({
      pickup: expect.objectContaining({ id: legB, location: [FAR.lng, FAR.lat], time_windows: [[seconds("08:00"), seconds("08:05")]] }),
    })]);
    // Pinned: neither leg changes Recorrido by hand, and the same Traslado is not split twice.
    expect(await h.answer(h.request(`/transfers/${legB}`, "PATCH", { routeId: fromRouteId }, s.office), 409))
      .toEqual({ error: "A Trasbordo leg is pinned to its Recorrido" });
    expect(await plan(s, legA, { ...FAR, time: "08:00", fromRouteId, toRouteId }, 409)).toEqual({ error: "This Traslado already has a Trasbordo" });
    // The time must fall within the Traslado: an entrada's Trasbordo comes before its target time.
    const late = await s.transfer((await s.passenger()).passengerId, "entrada", "08:30");
    expect(await plan(s, late, { ...FAR, time: "08:30", fromRouteId, toRouteId }, 400))
      .toEqual({ error: "The Trasbordo happens during the Traslado: before an entrada's target time, after a salida's" });
    expect((await day(s)).transfers.find((transfer: { id: number }) => transfer.id === late)).toMatchObject({ trasbordo: null, routeId: null });
  });

  it("Regla 4: leg A is solved first, and leg B gets as delivery bound A's planned pickup + Tiempo máximo a bordo − margin", async () => {
    const { s, fromRouteId, toRouteId, legB } = await plannedDay("rule-4");
    expect(await h.answer(h.request(`/routes/${toRouteId}/order`, "POST", undefined, s.office), 409)).toEqual({
      error: `Order the Recorrido of leg A of the Trasbordo first: Pasajero Sintético 1 (Traslado ${legB})`,
    });
    engine.pickupAt = seconds("07:30");
    await h.answer(h.request(`/routes/${fromRouteId}/order`, "POST", undefined, s.office), 200);
    engine.pickupAt = null;
    await h.answer(h.request(`/routes/${toRouteId}/order`, "POST", undefined, s.office), 200);
    // 07:30 + 60 min − 5 min margin − 5 min drop-off service: the drop-off at the school starts by 08:20, before T (08:30).
    expect(engine.problems.at(-1)!.shipments[0].delivery.time_windows).toEqual([[seconds("08:15"), seconds("08:20")]]);
  });

  it("AC5: the validator sums the whole chain, from the Subió in leg A through the wait at the point to the Entregado in leg B", async () => {
    const { s, first, fromRouteId, toRouteId, legA, legB } = await plannedDay("ac-5");
    await s.publish(fromRouteId);
    expect(await s.publish(toRouteId)).toBe(1);
    // The Pasajero got on at 07:00, an hour before the Trasbordo: with the wait, leg B's drop-off ends after 60 minutes.
    at("07:00");
    await h.answer(h.mark(first.cookie, fromRouteId, h.markBody(legA, "subio")), 201);
    const refused = await h.answer(h.request(`/routes/${toRouteId}/publish`, "POST", {}, s.office), 409);
    expect(refused.violations).toEqual([expect.objectContaining({
      violations: [expect.objectContaining({ rule: "max_ride_time_exceeded", transferId: legB, message: expect.stringContaining("(86.6") })],
    })]);
  });

  it("Regla 5: a planned Trasbordo is recorded with the same Marcas, on its own leg B and at its planned point", async () => {
    const { s, first, second, fromRouteId, toRouteId, legA, legB } = await plannedDay("rule-5");
    await s.publish(fromRouteId);
    await s.publish(toRouteId);
    at("07:58");
    await h.answer(h.mark(first.cookie, fromRouteId, h.markBody(legA, "subio")), 201);
    at("08:03");
    expect(await trasbordo(s, legA, { routeId: fromRouteId }, 409))
      .toEqual({ error: "The planned Trasbordo of this Traslado hands it over in another Recorrido" });
    const result = await trasbordo(s, legA, { routeId: toRouteId });
    expect(result.legB.id).toBe(legB);
    expect(result.marks.entregado).toMatchObject({ transferId: legA, location: FAR, receiver: { kind: "driver", driverId: second.driverId } });
    expect(result.marks.subio).toMatchObject({ transferId: legB, routeId: toRouteId, location: FAR, trasbordoOf: result.marks.entregado.id });
    // Leg B was already in the receiving version: nothing changed, so it keeps its version.
    expect(result.publication.version.version).toBe(1);
    expect((await day(s)).transfers.find((transfer: { id: number }) => transfer.id === legB)).toMatchObject({ status: "subio" });
  });

  it("AC6 / Regla 6: when leg A is republished and no longer reaches t, leg B is revalidated and the Oficina warned, without republishing B", async () => {
    const { s, first, fromRouteId, toRouteId, legA } = await plannedDay("rule-6");
    // Before leg A, another entrada to the school at 07:40 in the same Vehículo.
    const x = await s.passenger();
    const tx = await s.transfer(x.passengerId, "entrada", "07:40");
    await s.assign(tx, fromRouteId);
    const stopIds = async () => (await day(s)).routes.find((route: { id: number }) => route.id === fromRouteId).stops;
    const ordered = (await stopIds()) as { id: number; transferId: number; kind: string }[];
    const id = (transferId: number, kind: string) => ordered.find((stop) => stop.transferId === transferId && stop.kind === kind)!.id;
    await h.answer(h.request(`/routes/${fromRouteId}/stops`, "PATCH", { stopIds: [id(tx, "pickup"), id(tx, "dropoff"), id(legA, "pickup"), id(legA, "dropoff")] }, s.office), 200);
    const first1 = await s.post(`/routes/${fromRouteId}/publish`, {});
    expect(first1.cascade).toEqual([]);
    await s.publish(toRouteId);
    at("07:31");
    await h.answer(h.mark(first.cookie, fromRouteId, h.markBody(tx, "subio")), 201);
    at("07:40");
    await h.answer(h.mark(first.cookie, fromRouteId, h.markBody(tx, "entregado", { receiver: { kind: "destination", destinationId: s.school } })), 201);
    // A third entrada is added after the done Paradas, so leg A now reaches the point at 08:21, after 08:05.
    const z = await s.transfer((await s.passenger()).passengerId, "entrada", "08:00");
    await s.assign(z, fromRouteId);
    const now = (await stopIds()) as { id: number; transferId: number; kind: string }[];
    const sid = (transferId: number, kind: string) => now.find((stop) => stop.transferId === transferId && stop.kind === kind)!.id;
    await h.answer(h.request(`/routes/${fromRouteId}/stops`, "PATCH", {
      stopIds: [sid(tx, "pickup"), sid(tx, "dropoff"), sid(z, "pickup"), sid(z, "dropoff"), sid(legA, "pickup"), sid(legA, "dropoff")],
    }, s.office), 200);
    const republished = await s.post(`/routes/${fromRouteId}/publish`, { overrideReason: "Added a Pasajero" });
    expect(republished.version.violations).toEqual([expect.objectContaining({ violations: [expect.objectContaining({ rule: "trasbordo_window_broken", transferId: legA })] })]);
    expect(republished.cascade).toEqual([{
      routeId: toRouteId, version: 1, fromRouteId, ok: false,
      problem: "Leg A of Pasajero Sintético 1 reaches the Trasbordo point at 08:21, after 08:05",
    }]);
    expect(await versions(s, toRouteId)).toHaveLength(1);
  });
});

describe("Trasbordo: entries it touches keep their behaviour for a Traslado without one", () => {
  /** One published Recorrido of one entrada at 08:00 without a Trasbordo. */
  async function plainDay(name: string) {
    const s = await h.setup(name);
    const p = await s.passenger();
    return { s, ...await s.served(p.passengerId, "entrada", "08:00") };
  }

  it("PRESERVE POST /daily-plans/:date/publish: an unchanged Recorrido keeps its version", async () => {
    const { s, routeId } = await plainDay("preserve-day-publish");
    // The Plan diario of the day is shared with the other tests of this file: only this Recorrido is looked at.
    const summary = await h.answer(h.request(`/daily-plans/${TODAY}/publish`, "POST", {}, s.office), 200);
    expect(summary.unchanged).toContain(routeId);
    expect(summary.published.map((item: { routeId: number }) => item.routeId)).not.toContain(routeId);
    expect(await versions(s, routeId)).toHaveLength(1);
  });

  it("PRESERVE POST /routes/:id/publish: a Recorrido without a Trasbordo publishes with its planned times and no cascade", async () => {
    const { s, routeId, transferId } = await plainDay("preserve-publish");
    const result = await s.post(`/routes/${routeId}/publish`, {});
    expect(result.cascade).toEqual([]);
    expect(result.version.legs.map((leg: { transferId: number; kind: string; plannedTime: string }) => [leg.transferId, leg.kind, leg.plannedTime]))
      .toEqual([[transferId, "pickup", "07:51"], [transferId, "dropoff", "08:00"]]);
  });

  it("PRESERVE POST /routes/:id/order: a Traslado without a Trasbordo keeps its engine windows", async () => {
    const s = await h.setup("preserve-order");
    const routeId = await s.route((await s.chofer()).driverId);
    const transferId = await s.transfer((await s.passenger()).passengerId, "entrada", "08:00");
    await s.assign(transferId, routeId);
    engine.pickupAt = null;
    await h.answer(h.request(`/routes/${routeId}/order`, "POST", undefined, s.office), 200);
    // T − (60 − 5) min + 5 min drop-off service, and arrival between T − 15 min and T.
    expect(engine.problems.at(-1)!.shipments).toEqual([expect.objectContaining({
      pickup: expect.objectContaining({ id: transferId, location: [HOME.lng, HOME.lat], time_windows: [[seconds("07:10"), seconds("08:00")]] }),
      delivery: expect.objectContaining({ id: transferId, time_windows: [[seconds("07:45"), seconds("08:00")]] }),
    })]);
  });

  it("PRESERVE PATCH /transfers/:id: a Planificado Traslado without a Trasbordo still changes Recorrido", async () => {
    const { s, routeId, transferId } = await plainDay("preserve-move");
    const other = await s.route((await s.chofer()).driverId);
    const moved = await h.answer(h.request(`/transfers/${transferId}`, "PATCH", { routeId: other }, s.office), 200);
    expect(moved.transfer).toMatchObject({ id: transferId, routeId: other, status: "planificado" });
    expect(routeId).not.toBe(other);
  });

  it("PRESERVE GET /driver/days/:date and GET /transfers/:id/history: Paradas at home and at the Destino, and Marcas, show as before", async () => {
    const { s, driver, routeId, transferId } = await plainDay("preserve-driver-day");
    at("07:52");
    await h.answer(h.mark(driver.cookie, routeId, h.markBody(transferId, "subio")), 201);
    const driverDay = await h.answer(h.request(`/driver/days/${TODAY}`, "GET", undefined, driver.cookie), 200);
    expect(driverDay.routes[0].stops.map((stop: { place: { name: string | null } }) => stop.place.name)).toEqual([null, `Escuela preserve-driver-day`]);
    const marks = (await history(s, transferId)).marks;
    expect(marks).toHaveLength(1);
    expect(Object.keys(marks[0]).sort()).toEqual(["author", "flags", "id", "kind", "location", "phoneTime", "receiver", "routeId", "serverTime", "transferId", "version"]);
  });
});
