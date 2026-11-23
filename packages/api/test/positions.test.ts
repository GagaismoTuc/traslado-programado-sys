import { describe, expect, it } from "vitest";
import { createExecutionHarness, HOME, NOW } from "./helpers/execution.js";

const { appPool, clock, request, answer, rows, setup, markBody, mark } = createExecutionHarness("positions-test");

async function storedPositions() {
  return await rows("SELECT * FROM positions ORDER BY phone_time, id");
}

function positionSample(offsetSeconds: number, fields: Record<string, unknown> = {}) {
  const phoneTime = new Date(clock.now.getTime() + offsetSeconds * 1000).toISOString();
  return { lat: HOME.lat, lng: HOME.lng, accuracyMeters: 15, phoneTime, ...fields };
}

describe("positions table schema and permissions", () => {
  it("stores Posiciones in their own table without referencing Pasajeros and denies UPDATE to the application role", async () => {
    const { passenger, served } = await setup("schema");
    const { passengerId } = await passenger();
    const { driver, routeId } = await served(passengerId, "entrada");

    // Rule 11: the positions table must never reference passengers.
    const fkRows = await rows(`
      SELECT ccu.table_name AS referenced_table, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = 'positions'
       ORDER BY ccu.table_name
    `);
    expect(fkRows.map((row) => row.referenced_table)).toEqual(["drivers", "routes"]);

    const columns = (await rows(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'positions' ORDER BY ordinal_position",
    )).map((row) => row.column_name);
    expect(columns).toEqual([
      "id", "route_id", "driver_id", "latitude", "longitude", "accuracy_meters", "phone_time", "server_time",
    ]);
    expect(columns.some((col) => String(col).includes("passenger") || String(col).includes("transfer"))).toBe(false);

    // Application role can INSERT, SELECT, and DELETE (for the 90-day purge), never UPDATE.
    await appPool.query(
      `INSERT INTO positions (route_id, driver_id, latitude, longitude, accuracy_meters, phone_time, server_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [routeId, driver.driverId, HOME.lat, HOME.lng, 12.5, NOW, NOW],
    );
    expect((await appPool.query("SELECT route_id, driver_id FROM positions")).rows).toEqual([
      { route_id: routeId, driver_id: driver.driverId },
    ]);
    await expect(appPool.query("UPDATE positions SET latitude = 0")).rejects.toThrow(/permission denied/i);
    await expect(appPool.query(
      `INSERT INTO positions (route_id, driver_id, latitude, longitude, accuracy_meters, phone_time, server_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [routeId, driver.driverId, HOME.lat, HOME.lng, 12.5, NOW, NOW],
    )).rejects.toThrow(/positions_route_phone_time_unique|duplicate key/i);
    await appPool.query("DELETE FROM positions WHERE route_id = $1", [routeId]);
    expect(await storedPositions()).toEqual([]);
  });
});

describe("POST /driver/routes/:id/positions", () => {
  it("stores a batch of 3 valid Posiciones for the Chofer's own Recorrido en curso and returns 201", async () => {
    const { passenger, served } = await setup("valid-batch");
    const { passengerId } = await passenger();
    const { driver, routeId } = await served(passengerId, "entrada");
    await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);

    const batch = [
      positionSample(-30, { lat: -26.831, lng: -65.211, accuracyMeters: 10 }),
      positionSample(-15, { lat: -26.828, lng: -65.208, accuracyMeters: 18.5 }),
      positionSample(0, { lat: -26.825, lng: -65.205, accuracyMeters: 25 }),
    ];
    expect(await answer(request(`/driver/routes/${routeId}/positions`, "POST", { positions: batch }, driver.cookie), 201))
      .toEqual({ saved: 3, ignored: 0 });

    const saved = await storedPositions();
    expect(saved.map((row) => ({
      routeId: row.route_id,
      driverId: row.driver_id,
      lat: row.latitude,
      lng: row.longitude,
      accuracyMeters: row.accuracy_meters,
      phoneTime: row.phone_time.toISOString(),
      serverTime: row.server_time.toISOString(),
    }))).toEqual(batch.map((item) => ({
      routeId,
      driverId: driver.driverId,
      lat: item.lat,
      lng: item.lng,
      accuracyMeters: item.accuracyMeters,
      phoneTime: item.phoneTime,
      serverTime: NOW,
    })));
  });

  it("ignores duplicate phoneTime on the same Recorrido when resending the same batch and returns 200", async () => {
    const { passenger, served } = await setup("dedupe");
    const { passengerId } = await passenger();
    const { driver, routeId } = await served(passengerId, "entrada");
    await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);

    const batch = [positionSample(-30), positionSample(-15), positionSample(0)];
    expect(await answer(request(`/driver/routes/${routeId}/positions`, "POST", { positions: batch }, driver.cookie), 201))
      .toEqual({ saved: 3, ignored: 0 });
    expect(await answer(request(`/driver/routes/${routeId}/positions`, "POST", { positions: batch }, driver.cookie), 200))
      .toEqual({ saved: 0, ignored: 3 });
    expect(await storedPositions()).toHaveLength(3);

    // Partial overlap and duplicate within the same batch store only the new timestamp once.
    const next = positionSample(15);
    expect(await answer(request(`/driver/routes/${routeId}/positions`, "POST", { positions: [batch[2], next, next] }, driver.cookie), 201))
      .toEqual({ saved: 1, ignored: 2 });
    expect(await storedPositions()).toHaveLength(4);
  });

  it("returns 403 for another Chofer's Recorrido and 404 for a nonexistent Recorrido without storing anything", async () => {
    const { passenger, served, chofer } = await setup("ownership");
    const { passengerId } = await passenger();
    const { driver, routeId } = await served(passengerId, "entrada");
    const other = await chofer();
    await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);

    const batch = [positionSample(0)];
    expect(await answer(request(`/driver/routes/${routeId}/positions`, "POST", { positions: batch }, other.cookie), 403))
      .toEqual({ error: "This Recorrido belongs to another Chofer" });
    expect(await answer(request("/driver/routes/999999/positions", "POST", { positions: batch }, driver.cookie), 404))
      .toEqual({ error: "Recorrido not found" });
    expect(await storedPositions()).toEqual([]);
  });

  it("returns 409 for a Recorrido in borrador, publicado or cerrado without storing anything", async () => {
    const { passenger, chofer, route, served } = await setup("status");
    const { passengerId } = await passenger();
    const draftDriver = await chofer();
    const draftRouteId = await route(draftDriver.driverId);

    const published = await served(passengerId, "entrada");
    const closed = await served(passengerId, "salida");
    await answer(request(`/driver/routes/${closed.routeId}/start`, "POST", {}, closed.driver.cookie), 200);
    await answer(mark(closed.driver.cookie, closed.routeId, markBody(closed.transferId, "ausente")), 201);
    await answer(request(`/driver/routes/${closed.routeId}/close`, "POST", {}, closed.driver.cookie), 200);

    const batch = [positionSample(0)];
    expect((await request(`/driver/routes/${draftRouteId}/positions`, "POST", { positions: batch }, draftDriver.cookie)).status).toBe(409);
    expect((await request(`/driver/routes/${published.routeId}/positions`, "POST", { positions: batch }, published.driver.cookie)).status).toBe(409);
    // #136: a cerrado Recorrido refuses a Posición taken after its close (at the clock's 12:00).
    expect((await request(`/driver/routes/${closed.routeId}/positions`, "POST", { positions: [positionSample(1)] }, closed.driver.cookie)).status).toBe(409);
    expect(await storedPositions()).toEqual([]);
  });

  it("accepts late Posiciones of a cerrado Recorrido taken at or before its close and refuses with 409 a batch with a later one", async () => {
    const { passenger, served } = await setup("late");
    const { passengerId } = await passenger();
    const closed = await served(passengerId, "salida");
    await answer(request(`/driver/routes/${closed.routeId}/start`, "POST", {}, closed.driver.cookie), 200);
    await answer(mark(closed.driver.cookie, closed.routeId, markBody(closed.transferId, "ausente")), 201);
    // Closed at 12:00 by the server clock.
    await answer(request(`/driver/routes/${closed.routeId}/close`, "POST", {}, closed.driver.cookie), 200);
    const path = `/driver/routes/${closed.routeId}/positions`;

    expect(await answer(request(path, "POST", { positions: [positionSample(-120), positionSample(60)] }, closed.driver.cookie), 409))
      .toEqual({ error: "Positions taken after the Recorrido was closed are refused" });
    expect(await storedPositions()).toEqual([]);

    expect(await answer(request(path, "POST", { positions: [positionSample(-120), positionSample(0)] }, closed.driver.cookie), 201))
      .toEqual({ saved: 2, ignored: 0 });
    expect((await storedPositions()).map((row) => new Date(row.phone_time as string).toISOString()))
      .toEqual(["2026-10-23T11:58:00.000Z", "2026-10-23T12:00:00.000Z"]);
  });

  it("closing a Recorrido still answers 200 and dates its closed change-log entry with the server clock", async () => {
    const { passenger, served } = await setup("close-time");
    const { passengerId } = await passenger();
    const closed = await served(passengerId, "salida");
    await answer(request(`/driver/routes/${closed.routeId}/start`, "POST", {}, closed.driver.cookie), 200);
    await answer(mark(closed.driver.cookie, closed.routeId, markBody(closed.transferId, "ausente")), 201);

    expect(await answer(request(`/driver/routes/${closed.routeId}/close`, "POST", {}, closed.driver.cookie), 200))
      .toEqual({ route: { routeId: closed.routeId, status: "cerrado" } });
    const log = await rows(
      "SELECT action, after_data, occurred_at FROM change_log WHERE entity = 'route' AND entity_id = $1 AND action = 'closed'",
      [String(closed.routeId)],
    );
    expect(log.map((row) => ({ ...row, occurred_at: new Date(row.occurred_at as string).toISOString() })))
      .toEqual([{ action: "closed", after_data: { status: "cerrado" }, occurred_at: NOW }]);
  });

  it("returns 400 and stores nothing for invalid batches and accepts the 100-position boundary", async () => {
    const { passenger, served } = await setup("validation");
    const { passengerId } = await passenger();
    const { driver, routeId } = await served(passengerId, "entrada");
    await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);

    const invalidBatches: [string, unknown][] = [
      ["empty", { positions: [] }],
      ["101 positions", { positions: Array.from({ length: 101 }, (_, index) => positionSample(-index - 1)) }],
      ["lat > 90", { positions: [positionSample(-15), positionSample(0, { lat: 90.001 })] }],
      ["lat < -90", { positions: [positionSample(0, { lat: -90.001 })] }],
      ["lng > 180", { positions: [positionSample(0, { lng: 180.001 })] }],
      ["lng < -180", { positions: [positionSample(0, { lng: -180.001 })] }],
      ["negative accuracy", { positions: [positionSample(-15), positionSample(0, { accuracyMeters: -1 })] }],
      ["non-numeric accuracy", { positions: [positionSample(0, { accuracyMeters: "15" })] }],
      ["phoneTime > 2 min in future", { positions: [positionSample(-15), positionSample(121)] }],
    ];
    for (const [label, body] of invalidBatches) {
      const response = await request(`/driver/routes/${routeId}/positions`, "POST", body, driver.cookie);
      expect(response.status, label).toBe(400);
    }
    expect(await storedPositions()).toEqual([]);

    // Boundary: exactly 100 positions (including +120s exact future limit) → 201 and all 100 stored.
    const hundred = Array.from({ length: 100 }, (_, index) => positionSample(120 - index * 15));
    expect(await answer(request(`/driver/routes/${routeId}/positions`, "POST", { positions: hundred }, driver.cookie), 201))
      .toEqual({ saved: 100, ignored: 0 });
    expect(await storedPositions()).toHaveLength(100);
  });

  it("returns 401 without a Chofer session and 403 for an Office session", async () => {
    const { office, passenger, served } = await setup("auth");
    const { passengerId } = await passenger();
    const { driver, routeId } = await served(passengerId, "entrada");
    await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);

    const batch = [positionSample(0)];
    expect((await request(`/driver/routes/${routeId}/positions`, "POST", { positions: batch })).status).toBe(401);
    expect((await request(`/driver/routes/${routeId}/positions`, "POST", { positions: batch }, office)).status).toBe(403);
    expect(await storedPositions()).toEqual([]);
  });

  it("preserves POST /driver/routes/:id/marks independently of Posiciones", async () => {
    const { passenger, served } = await setup("preserve-marks");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);

    // Even if a position batch fails with 400, recording a Marca works unchanged and stays in marks, not positions.
    expect((await request(`/driver/routes/${routeId}/positions`, "POST", { positions: [] }, driver.cookie)).status).toBe(400);
    const created = await answer(mark(driver.cookie, routeId, markBody(transferId, "subio")), 201);
    expect(created.mark.kind).toBe("subio");
    expect(await storedPositions()).toEqual([]);
    expect(await rows("SELECT kind FROM marks")).toEqual([{ kind: "subio" }]);
  });
});
