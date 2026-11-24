import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createExecutionHarness, HOME, NOW, TODAY } from "./helpers/execution.js";

const { appPool, clock, request, answer, rows, setup, markBody, mark } = createExecutionHarness("live-map-test", {
  baseAddress: "Base Sintética, Calle Inventada 999",
});

describe("GET /daily-plans/:date/live", () => {
  it("refuses unauthorized requests with 401", async () => {
    const res = await request(`/daily-plans/${TODAY}/live`, "GET");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the daily plan does not exist", async () => {
    const { office } = await setup("not-found");
    await answer(request("/daily-plans/2099-01-01/live", "GET", undefined, office), 404);
  });

  it("Rule 2: shows planned times, not ETAs, when a Recorrido has no Marcas", async () => {
    const { office, passenger, served } = await setup("rule-2-no-marcas");
    const { passengerId } = await passenger();
    const servedRoute = await served(passengerId, "entrada");

    const body = await answer(request(`/daily-plans/${TODAY}/live`, "GET", undefined, office), 200) as { date: string; routes: any[] };

    expect(body.date).toBe(TODAY);
    expect(body.routes.length).toBeGreaterThan(0);

    const route = body.routes.find((r) => r.id === servedRoute.routeId);
    expect(route).toBeDefined();
    expect(route.lastMarca).toBeNull();
    expect(route.childrenOnBoard).toBe(0);
    expect(route.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(route.stops.length).toBeGreaterThanOrEqual(2);

    // Rule 2 check: stops show planned times and eta is null
    for (const stop of route.stops) {
      expect(stop.eta).toBeNull();
      expect(stop.plannedTime).toMatch(/^\d{2}:\d{2}$/);
      expect(stop.completed).toBe(false);
      expect(stop.status).toBe("pending");
    }

    // nextStop keeps planned time without labelling it as ETA
    expect(route.nextStop).toBeDefined();
    expect(route.nextStop.eta).toBeNull();
    expect(route.nextStop.plannedTime).toMatch(/^\d{2}:\d{2}$/);
    expect(route.geometry.length).toBeGreaterThanOrEqual(2);
  });

  it("Rule 1: recalculates ETAs over remaining fixed order from last Marca and tracks children on board", async () => {
    const { office, passenger, served, school } = await setup("rule-1-etas");
    const { passengerId } = await passenger();
    const servedRoute = await served(passengerId, "entrada");

    // Chofer marks Subió at the pickup stop
    await answer(
      mark(servedRoute.driver.cookie, servedRoute.routeId, markBody(servedRoute.transferId, "subio", {
        location: HOME,
        phoneTime: "2026-10-23T11:30:00.000Z", // 08:30 in Tucumán
      })),
      201,
    );

    // Office queries live map
    const body = await answer(request(`/daily-plans/${TODAY}/live`, "GET", undefined, office), 200) as { date: string; routes: any[] };
    const route = body.routes.find((r) => r.id === servedRoute.routeId);

    expect(route).toBeDefined();
    expect(route.childrenOnBoard).toBe(1);
    expect(route.lastMarca).toBeDefined();
    expect(route.lastMarca.kind).toBe("subio");
    expect(route.lastMarca.phoneTimeHhmi).toBe("08:30");
    expect(route.lastMarca.latitude).toBeCloseTo(HOME.lat);
    expect(route.lastMarca.longitude).toBeCloseTo(HOME.lng);

    // First stop is completed
    const pickupStop = route.stops.find((s: any) => s.kind === "pickup");
    expect(pickupStop.completed).toBe(true);
    expect(pickupStop.status).toBe("subio");

    // Second stop (dropoff) is remaining, with recalculated ETA
    const dropoffStop = route.stops.find((s: any) => s.kind === "dropoff");
    expect(dropoffStop.completed).toBe(false);
    expect(dropoffStop.status).toBe("pending");
    expect(dropoffStop.eta).toMatch(/^\d{2}:\d{2}$/);
    // Calculated arrival: 08:30 + ~3 minutes travel = 08:33
    expect(dropoffStop.eta).toBe("08:33");

    // nextStop is the dropoff with its recalculated ETA
    expect(route.nextStop).toBeDefined();
    expect(route.nextStop.kind).toBe("dropoff");
    expect(route.nextStop.eta).toBe("08:33");

    // Chofer marks Entregado at dropoff
    await answer(
      mark(servedRoute.driver.cookie, servedRoute.routeId, markBody(servedRoute.transferId, "entregado", {
        location: { lat: -26.82, lng: -65.2 },
        phoneTime: "2026-10-23T11:38:00.000Z", // 08:38 in Tucumán
        receiver: { kind: "destination", destinationId: school },
      })),
      201,
    );

    // Live map shows childrenOnBoard is 0 and no next stop
    const afterBody = await answer(request(`/daily-plans/${TODAY}/live`, "GET", undefined, office), 200) as { routes: any[] };
    const finishedRoute = afterBody.routes.find((r) => r.id === servedRoute.routeId);

    expect(finishedRoute.childrenOnBoard).toBe(0);
    expect(finishedRoute.lastMarca.kind).toBe("entregado");
    expect(finishedRoute.lastMarca.phoneTimeHhmi).toBe("08:38");
    expect(finishedRoute.nextStop).toBeNull();
    for (const stop of finishedRoute.stops) {
      expect(stop.completed).toBe(true);
    }
  });

  it("adds stop service duration when recalculating ETAs for multiple remaining stops", async () => {
    const { office, passenger, chofer, route, transfer, assign, publish, school } = await setup("multi-stop-service");
    const driver = await chofer();
    const routeId = await route(driver.driverId);

    const p1 = await passenger();
    const p2 = await passenger();

    const t1 = await transfer(p1.passengerId, "entrada", "08:00");
    const t2 = await transfer(p2.passengerId, "entrada", "08:30");

    await assign(t1, routeId);
    await assign(t2, routeId);
    await publish(routeId);

    // Chofer marks Subió for p1 at 08:00
    await answer(
      mark(driver.cookie, routeId, markBody(t1, "subio", {
        location: HOME,
        phoneTime: "2026-10-23T11:00:00.000Z", // 08:00 in Tucumán
      })),
      201,
    );

    const body = await answer(request(`/daily-plans/${TODAY}/live`, "GET", undefined, office), 200) as { routes: any[] };
    const liveRoute = body.routes.find((r) => r.id === routeId);

    expect(liveRoute.childrenOnBoard).toBe(1);
    expect(liveRoute.lastMarca.phoneTimeHhmi).toBe("08:00");

    // The remaining stops are: p2 pickup, p1 dropoff, p2 dropoff (or ordered order)
    const remaining = liveRoute.stops.filter((s: any) => !s.completed);
    expect(remaining.length).toBe(3);

    // Each subsequent stop's ETA must account for previous stop's ETA + service duration (5 min) + travel duration
    for (let i = 1; i < remaining.length; i++) {
      const prevMinutes = Number(remaining[i - 1].eta.split(":")[0]) * 60 + Number(remaining[i - 1].eta.split(":")[1]);
      const currMinutes = Number(remaining[i].eta.split(":")[0]) * 60 + Number(remaining[i].eta.split(":")[1]);
      // Current arrival must be at least previous arrival + 5 minutes service duration
      expect(currMinutes).toBeGreaterThanOrEqual(prevMinutes + 5);
    }
  });
});

const mockNow = new Date("2026-10-23T11:30:00Z");
function setupMockReview(
  status: string,
  hasMark: boolean,
  options?: {
    markCoordinates?: { lat: number | null; lng: number | null };
    routerFails?: boolean;
    position?: { lat: number; lng: number };
  },
) {
  const calls: { lat: number; lng: number }[][] = [];
  const rows = [
    { id: 1, transferId: 1, kind: "pickup", position: 1, passengerId: 1, passengerName: "A", placeName: "A", lat: -26.1, lng: -65.1, plannedTime: "08:00", serviceMinutes: 7, transferStatus: status },
    { id: 2, transferId: 2, kind: "pickup", position: 2, passengerId: 2, passengerName: "B", placeName: "B", lat: -26.2, lng: -65.2, plannedTime: "08:10", serviceMinutes: 7, transferStatus: "planificado" },
    { id: 3, transferId: 1, kind: "dropoff", position: 3, passengerId: 1, passengerName: "A", placeName: "C", lat: -26.3, lng: -65.3, plannedTime: "08:20", serviceMinutes: 9, transferStatus: status },
    { id: 4, transferId: 2, kind: "dropoff", position: 4, passengerId: 2, passengerName: "B", placeName: "D", lat: -26.4, lng: -65.4, plannedTime: "08:30", serviceMinutes: 9, transferStatus: "planificado" },
  ];
  const markLat = options?.markCoordinates !== undefined ? options.markCoordinates.lat : -26.1;
  const markLng = options?.markCoordinates !== undefined ? options.markCoordinates.lng : -65.1;
  const db = {
    async query(sql: string) {
      let result: unknown[];
      if (sql.includes("FROM sessions s JOIN users")) {
        result = [{ session_id: 1, user_id: 1, username: "office", role: "office", created_at: mockNow, last_used_at: mockNow, second_factor_at: mockNow, revoked_at: null, disabled_at: null, persistent_session: false }];
      } else if (sql.startsWith("UPDATE sessions")) {
        result = [];
      } else if (sql.includes("FROM daily_plans WHERE")) {
        result = [{ id: 1, date: "2026-10-23", timeZone: "America/Argentina/Tucuman" }];
      } else if (sql.includes("FROM routes r") && sql.includes("daily_plan_id")) {
        result = [{ id: 1, status: "en_curso", driverId: 1, driverName: "Driver", vehicleId: 1, vehiclePlate: "TEST", startLat: null, startLng: null }];
      } else if (sql.includes("FROM stops s")) {
        result = rows;
      } else if (sql.includes("FROM marks e")) {
        result = hasMark ? [{ id: 1, kind: status, latitude: markLat, longitude: markLng, phone_time_hhmi: "08:30", phone_minutes: 510, phone_time: mockNow }] : [];
      } else if (sql.includes("FROM positions")) {
        const position = options?.position;
        result = position
          ? [{ latitude: position.lat, longitude: position.lng, accuracy_meters: 12, phone_time_hhmi: "08:30", phone_minutes: 510, phone_time: mockNow }]
          : [];
      } else {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      return { rows: result, rowCount: result.length };
    },
  };
  const router = options?.routerFails
    ? async () => {
        throw new Error("OSRM offline");
      }
    : async (points: { lat: number; lng: number }[]) => {
        calls.push(points);
        return points.slice(1).map(() => ({ distanceMeters: 100, durationSeconds: 60 }));
      };
  const app = createApp({
    db: db as any,
    router,
    routing: { osrm: async () => {}, vroom: async () => {} },
    config: { serverEpoch: "review", now: () => mockNow } as any,
  });
  const get = async () => {
    const res = await app.request("/daily-plans/2026-10-23/live", { headers: { cookie: "session=synthetic" } });
    expect(res.status).toBe(200);
    return (await res.json() as any).routes[0];
  };
  return { get, calls };
}

describe("Rule 1, Rule 2 and absent dropoff live map verification", () => {
  it("Rule 1: routes remaining stops strictly in published order and includes actual service durations", async () => {
    const { get, calls } = setupMockReview("subio", true);
    const route = await get();
    expect(calls[0]).toEqual([
      { lat: -26.1, lng: -65.1 },
      { lat: -26.2, lng: -65.2 },
      { lat: -26.3, lng: -65.3 },
      { lat: -26.4, lng: -65.4 },
    ]);
    expect(route.stops.slice(1).map((s: any) => s.eta)).toEqual(["08:31", "08:39", "08:49"]);
  });

  it("Rule 2: displays planned times without calling the router when no mark exists", async () => {
    const { get, calls } = setupMockReview("planificado", false);
    const route = await get();
    expect(calls).toEqual([]);
    expect(route.nextStop.plannedTime).toBe("08:00");
    expect(route.nextStop.eta).toBeNull();
    expect(route.stops.map((s: any) => s.eta)).toEqual([null, null, null, null]);
  });

  it("does not route or report as next an absent passenger's cancelled dropoff", async () => {
    const { get, calls } = setupMockReview("ausente", true);
    const route = await get();
    expect(route.stops.find((s: any) => s.id === 3).eta).toBeNull();
    expect(calls[0]).not.toContainEqual({ lat: -26.3, lng: -65.3 });
  });

  it("uses OSRM router for the ETA", async () => {
    const { get } = setupMockReview("subio", true);
    const route = await get();
    expect(route.stops[1].eta).not.toBe("08:10");
    expect(route.stops[1].eta).toBe("08:31");
    expect(route.nextStop.eta).toBe("08:31");
  });

  it("does not fabricate a GPS position when a mark has none", async () => {
    const { get, calls } = setupMockReview("subio", true, { markCoordinates: { lat: null, lng: null } });
    const route = await get();
    expect(route.lastMarca.latitude).toBeNull();
    expect(route.lastMarca.longitude).toBeNull();
    expect(calls).toEqual([]);
    expect(route.nextStop.eta).toBeNull();
    expect(route.stops.slice(1).map((s: any) => s.eta)).toEqual([null, null, null]);
  });

  it("does not present planned time as ETA when OSRM is offline", async () => {
    const { get } = setupMockReview("subio", true, { routerFails: true });
    const route = await get();
    expect(route.nextStop.eta).toBeNull();
    expect(route.stops.slice(1).map((s: any) => s.eta)).toEqual([null, null, null]);
  });
});

describe("Issue #135: each Recorrido at its latest Posición, with the Pasajeros on board", () => {
  const B = { lat: -26.8, lng: -65.18 };
  const SCHOOL_POINT = { lat: -26.82, lng: -65.2 };

  async function live(cookie: string) {
    return await answer(request(`/daily-plans/${TODAY}/live`, "GET", undefined, cookie), 200) as { routes: any[] };
  }

  async function sendPositions(cookie: string, routeId: number, positions: { lat: number; lng: number; accuracyMeters: number; phoneTime: string }[]) {
    await answer(request(`/driver/routes/${routeId}/positions`, "POST", { positions }, cookie), 201);
  }

  it("Regla 1: the Posición with the most recent phone time wins over an older Marca and drives the ETA", async () => {
    const { office, passenger, served } = await setup("issue-135-rule-1");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio", { location: HOME, phoneTime: "2026-10-23T11:10:00.000Z" })), 201);
    await sendPositions(driver.cookie, routeId, [
      { ...HOME, accuracyMeters: 30, phoneTime: "2026-10-23T11:11:00.000Z" },
      { ...B, accuracyMeters: 15, phoneTime: "2026-10-23T11:12:00.000Z" },
    ]);

    const route = (await live(office)).routes.find((r) => r.id === routeId);

    expect(route.currentPosition).toEqual({
      source: "posicion",
      latitude: B.lat,
      longitude: B.lng,
      phoneTime: "2026-10-23T11:12:00.000Z",
      phoneTimeHhmi: "08:12",
      accuracyMeters: 15,
    });
    // From B at 08:12: 4000 synthetic meters at 10 m/s = 6 min 40 s → 08:18 (from the Marca at A it would be 08:13).
    expect(route.nextStop.eta).toBe("08:18");
    expect(route.lastMarca.kind).toBe("subio");
  });

  it("Regla 2: a located Marca more recent than the last Posición wins, with origin marca", async () => {
    const { office, passenger, served, school } = await setup("issue-135-rule-2");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio", { location: HOME, phoneTime: "2026-10-23T11:10:00.000Z" })), 201);
    await sendPositions(driver.cookie, routeId, [{ ...B, accuracyMeters: 15, phoneTime: "2026-10-23T11:12:00.000Z" }]);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", {
      location: SCHOOL_POINT,
      phoneTime: "2026-10-23T11:14:00.000Z",
      receiver: { kind: "destination", destinationId: school },
    })), 201);

    const route = (await live(office)).routes.find((r) => r.id === routeId);

    expect(route.currentPosition).toEqual({
      source: "marca",
      latitude: SCHOOL_POINT.lat,
      longitude: SCHOOL_POINT.lng,
      phoneTime: "2026-10-23T11:14:00.000Z",
      phoneTimeHhmi: "08:14",
      accuracyMeters: null,
    });
  });

  it("Regla 2: a more recent Marca without location does not replace the last Posición", async () => {
    const { office, passenger, served } = await setup("issue-135-rule-2-unlocated");
    const { driver, routeId, transferId } = await served((await passenger()).passengerId, "entrada");
    await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);
    await sendPositions(driver.cookie, routeId, [{ ...B, accuracyMeters: 15, phoneTime: "2026-10-23T11:12:00.000Z" }]);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio", { location: null, phoneTime: "2026-10-23T11:14:00.000Z" })), 201);

    const route = (await live(office)).routes.find((r) => r.id === routeId);

    expect(route.currentPosition).toMatchObject({ source: "posicion", latitude: B.lat, longitude: B.lng, phoneTimeHhmi: "08:12" });
  });

  it("Regla 2: without Posiciones, a last Marca without GPS falls back to the latest located Marca", async () => {
    const { office, passenger, served, school } = await setup("issue-135-rule-2-fallback");
    const { driver, routeId, transferId } = await served((await passenger()).passengerId, "entrada");
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio", { location: HOME, phoneTime: "2026-10-23T11:10:00.000Z" })), 201);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", {
      location: null, phoneTime: "2026-10-23T11:14:00.000Z", receiver: { kind: "destination", destinationId: school },
    })), 201);

    const route = (await live(office)).routes.find((r) => r.id === routeId);

    expect(route.lastMarca.latitude).toBeNull();
    expect(route.currentPosition).toEqual({
      source: "marca", latitude: HOME.lat, longitude: HOME.lng,
      phoneTime: "2026-10-23T11:10:00.000Z", phoneTimeHhmi: "08:10", accuracyMeters: null,
    });
  });

  it("Regla 3: without Posiciones and without located Marcas the position is null and no ETA is invented", async () => {
    const { office, passenger, served } = await setup("issue-135-rule-3");
    const first = await served((await passenger()).passengerId, "entrada");
    const second = await served((await passenger()).passengerId, "entrada");
    await answer(mark(second.driver.cookie, second.routeId, markBody(second.transferId, "subio", { location: null, phoneTime: "2026-10-23T11:10:00.000Z" })), 201);

    const routes = (await live(office)).routes;
    const withoutMarcas = routes.find((r) => r.id === first.routeId);
    const withUnlocatedMarca = routes.find((r) => r.id === second.routeId);

    expect(withoutMarcas.currentPosition).toBeNull();
    expect(withoutMarcas.nextStop.eta).toBeNull();
    expect(withUnlocatedMarca.currentPosition).toBeNull();
    expect(withUnlocatedMarca.lastMarca.latitude).toBeNull();
    expect(withUnlocatedMarca.nextStop.eta).toBeNull();
  });

  it("Regla 4: Posiciones of another Recorrido of the same Chofer are not mixed in", async () => {
    const { office, post, passenger, chofer, transfer, assign, publish } = await setup("issue-135-rule-4");
    const driver = await chofer();
    const morningTransfer = await transfer((await passenger()).passengerId, "entrada", "08:00");
    const afternoonTransfer = await transfer((await passenger()).passengerId, "salida", "13:00");
    const morning = (await post(`/daily-plans/${TODAY}/routes`, { driverId: driver.driverId, startTime: "06:00", endTime: "11:00" })).route.id as number;
    const afternoon = (await post(`/daily-plans/${TODAY}/routes`, { driverId: driver.driverId, startTime: "12:00", endTime: "18:00" })).route.id as number;
    await assign(morningTransfer, morning);
    await assign(afternoonTransfer, afternoon);
    await publish(morning);
    await publish(afternoon);
    // Synthetic Posiciones seeded directly: the morning one is older, the afternoon one is the latest of the Chofer.
    await rows(
      `INSERT INTO positions (route_id, driver_id, latitude, longitude, accuracy_meters, phone_time, server_time)
       VALUES ($1, $3, -26.81, -65.19, 10, '2026-10-23T11:00:00Z', '2026-10-23T11:00:00Z'),
              ($2, $3, -26.79, -65.17, 20, '2026-10-23T11:05:00Z', '2026-10-23T11:05:00Z')`,
      [morning, afternoon, driver.driverId],
    );

    const routes = (await live(office)).routes;

    expect(routes.find((r) => r.id === morning).currentPosition).toMatchObject({ source: "posicion", latitude: -26.81, longitude: -65.19, accuracyMeters: 10 });
    expect(routes.find((r) => r.id === afternoon).currentPosition).toMatchObject({ source: "posicion", latitude: -26.79, longitude: -65.17, accuracyMeters: 20 });
  });

  it("Regla 7: a Chofer session cannot read the live response", async () => {
    const { passenger, served } = await setup("issue-135-rule-7");
    const { driver } = await served((await passenger()).passengerId, "entrada");
    await answer(request(`/daily-plans/${TODAY}/live`, "GET", undefined, driver.cookie), 403);
  });

  it("Regla 8: lists by name only the Pasajeros who boarded and were not delivered", async () => {
    const { office, post, passenger, chofer, route: newRoute, transfer, assign, school } = await setup("issue-135-rule-8");
    const driver = await chofer();
    const routeId = await newRoute(driver.driverId);
    const transfers: number[] = [];
    for (let i = 0; i < 4; i++) {
      const transferId = await transfer((await passenger()).passengerId, "entrada", "08:00");
      await assign(transferId, routeId);
      transfers.push(transferId);
    }
    await post(`/routes/${routeId}/publish`, { overrideReason: "Orden sintético" });
    for (const transferId of transfers.slice(0, 3)) {
      await answer(mark(driver.cookie, routeId, markBody(transferId, "subio")), 201);
    }
    await answer(mark(driver.cookie, routeId, markBody(transfers[3], "ausente")), 201);
    await answer(mark(driver.cookie, routeId, markBody(transfers[0], "entregado", { receiver: { kind: "destination", destinationId: school } })), 201);

    const route = (await live(office)).routes.find((r) => r.id === routeId);

    expect(route.childrenOnBoard).toBe(2);
    expect(route.passengersOnBoard.map((p: any) => p.name).sort()).toEqual(["Pasajero Sintético 2", "Pasajero Sintético 3"]);
  });
});

describe("Issue #140: each LiveStop carries its Traslado, target time and Entregado Marca", () => {
  const DROP = { lat: -26.82, lng: -65.2 };

  async function liveStops(cookie: string, routeId: number) {
    const body = await answer(request(`/daily-plans/${TODAY}/live`, "GET", undefined, cookie), 200) as { routes: any[] };
    const stops = body.routes.find((r) => r.id === routeId).stops as any[];
    return { pickup: stops.find((s) => s.kind === "pickup"), dropoff: stops.find((s) => s.kind === "dropoff"), stops };
  }

  it("S13: before any Marca every stop has its transferId, the Traslado's target time and delivered null", async () => {
    const { office, passenger, served } = await setup("issue-140-before");
    const { routeId, transferId } = await served((await passenger()).passengerId, "entrada", "08:15");

    const { stops } = await liveStops(office, routeId);

    expect(stops).toHaveLength(2);
    for (const stop of stops) {
      expect(stop.transferId).toBe(transferId);
      expect(stop.targetTime).toBe("08:15");
      expect(stop.delivered).toBeNull();
    }
  });

  it("S13: after Subió and Entregado with GPS only the dropoff stop carries the Entregado Marca", async () => {
    const { office, passenger, served, school } = await setup("issue-140-delivered-gps");
    const { driver, routeId, transferId } = await served((await passenger()).passengerId, "entrada");
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio", { phoneTime: "2026-10-23T11:30:00.000Z" })), 201);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", {
      location: DROP,
      phoneTime: "2026-10-23T11:42:00.000Z", // 08:42 in Tucumán
      receiver: { kind: "destination", destinationId: school },
    })), 201);

    const { pickup, dropoff } = await liveStops(office, routeId);

    expect(pickup.delivered).toBeNull();
    expect(dropoff.delivered).toEqual({ phoneTimeHhmi: "08:42", latitude: DROP.lat, longitude: DROP.lng });
    expect(dropoff.transferId).toBe(transferId);
    expect(dropoff.targetTime).toBe("08:00");
  });

  it("S13: an Entregado Marca without GPS gives delivered with null latitude and longitude", async () => {
    const { office, passenger, served, school } = await setup("issue-140-delivered-no-gps");
    const { driver, routeId, transferId } = await served((await passenger()).passengerId, "entrada");
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio", { phoneTime: "2026-10-23T11:30:00.000Z" })), 201);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", {
      location: null,
      phoneTime: "2026-10-23T11:44:00.000Z", // 08:44 in Tucumán
      receiver: { kind: "destination", destinationId: school },
    })), 201);

    const { pickup, dropoff } = await liveStops(office, routeId);

    expect(pickup.delivered).toBeNull();
    expect(dropoff.delivered).toEqual({ phoneTimeHhmi: "08:44", latitude: null, longitude: null });
  });

  it("S13: an undone Entregado Marca leaves delivered null", async () => {
    const { office, passenger, served, school } = await setup("issue-140-delivered-undone");
    const { driver, routeId, transferId } = await served((await passenger()).passengerId, "entrada");
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio", { phoneTime: "2026-10-23T11:30:00.000Z" })), 201);
    const entregado = markBody(transferId, "entregado", {
      location: DROP,
      phoneTime: "2026-10-23T11:42:00.000Z",
      receiver: { kind: "destination", destinationId: school },
    });
    await answer(mark(driver.cookie, routeId, entregado), 201);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "undo", { corrects: entregado.id, phoneTime: "2026-10-23T11:43:00.000Z" })), 201);

    const { pickup, dropoff } = await liveStops(office, routeId);

    expect(pickup.delivered).toBeNull();
    expect(dropoff.delivered).toBeNull();
    expect(dropoff.status).toBe("pending");
  });
});

describe("Issue #135: ETA from the current Posición", () => {
  it("Regla 5: ETA is not available when the router fails, even with a Posición", async () => {
    const { get } = setupMockReview("subio", false, { routerFails: true, position: { lat: -26.15, lng: -65.15 } });
    const route = await get();
    expect(route.currentPosition).toMatchObject({ source: "posicion", latitude: -26.15, longitude: -65.15, accuracyMeters: 12 });
    expect(route.nextStop.eta).toBeNull();
    expect(route.stops.slice(1).map((s: any) => s.eta)).toEqual([null, null, null]);
  });

  it("Regla 6: a Posición outside the OSRM zone is shown but leaves the ETA unavailable", async () => {
    // The stub router answers any point, like mock-osrm and OSRM snapping a far point to the extract's edge.
    const { get, calls } = setupMockReview("subio", false, { position: { lat: -34.6, lng: -58.38 } });
    const route = await get();
    expect(route.currentPosition).toMatchObject({ source: "posicion", latitude: -34.6, longitude: -58.38 });
    expect(calls).toEqual([]);
    expect(route.nextStop.eta).toBeNull();
    expect(route.stops.slice(1).map((s: any) => s.eta)).toEqual([null, null, null]);
  });

  it("computes ETAs from a Posición in the zone when the Recorrido has no Marcas", async () => {
    const { get, calls } = setupMockReview("subio", false, { position: { lat: -26.15, lng: -65.15 } });
    const route = await get();
    expect(calls[0][0]).toEqual({ lat: -26.15, lng: -65.15 });
    expect(route.stops.slice(1).map((s: any) => s.eta)).toEqual(["08:31", "08:39", "08:49"]);
  });
});

