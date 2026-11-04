import { describe, expect, it } from "vitest";
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

    // nextStop shows planned time, not recalculated ETA
    expect(route.nextStop).toBeDefined();
    expect(route.nextStop.eta).toBe(route.nextStop.plannedTime);
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
