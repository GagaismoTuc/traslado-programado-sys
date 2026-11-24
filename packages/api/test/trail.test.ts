import { describe, expect, it } from "vitest";
import { createExecutionHarness } from "./helpers/execution.js";

const { request, answer, rows, setup } = createExecutionHarness("trail-test", {
  baseAddress: "Base Sintética, Calle Inventada 999",
});

describe("Issue #139: GET /routes/:routeId/trail", () => {
  it("Regla 1: 1200 Posiciones are reduced uniformly to 500 points ordered by phone time, keeping the first and the last", async () => {
    const { office, passenger, served } = await setup("issue-139-rule-1");
    const { driver, routeId } = await served((await passenger()).passengerId, "entrada");
    // Synthetic Posiciones inserted newest first, so storage order is the reverse of phone-time order.
    await rows(
      `INSERT INTO positions (route_id, driver_id, latitude, longitude, accuracy_meters, phone_time, server_time)
       SELECT $1, $2, -26.8 - i / 100000.0, -65.2 + i / 100000.0, 10,
              timestamptz '2026-10-23T11:00:00Z' + i * interval '1 second',
              timestamptz '2026-10-23T11:00:00Z' + i * interval '1 second'
         FROM generate_series(1199, 0, -1) AS i`,
      [routeId, driver.driverId],
    );

    const body = await answer(request(`/routes/${routeId}/trail`, "GET", undefined, office), 200) as {
      points: { lat: number; lng: number; phoneTime: string }[];
    };

    const expected = Array.from({ length: 500 }, (_, k) => Math.round((k * 1199) / 499));
    expect(body.points).toHaveLength(500);
    expect(body.points.map((p) => p.phoneTime)).toEqual(
      expected.map((i) => new Date(Date.parse("2026-10-23T11:00:00Z") + i * 1000).toISOString()),
    );
    expect(body.points[0]).toEqual({ lat: -26.8, lng: -65.2, phoneTime: "2026-10-23T11:00:00.000Z" });
    expect(body.points[499]).toEqual({ lat: -26.81199, lng: -65.18801, phoneTime: "2026-10-23T11:19:59.000Z" });
  });

  it("Regla 2: empty trail without Posiciones, 404 for an unknown Recorrido, 403 for a Chofer session", async () => {
    const { office, passenger, served } = await setup("issue-139-rule-2");
    const { driver, routeId } = await served((await passenger()).passengerId, "entrada");

    expect(await answer(request(`/routes/${routeId}/trail`, "GET", undefined, office), 200)).toEqual({ points: [] });
    await answer(request("/routes/999999/trail", "GET", undefined, office), 404);
    await answer(request("/routes/abc/trail", "GET", undefined, office), 404);
    await answer(request(`/routes/${routeId}/trail`, "GET", undefined, driver.cookie), 403);
    expect((await request(`/routes/${routeId}/trail`, "GET")).status).toBe(401);
  });
});
