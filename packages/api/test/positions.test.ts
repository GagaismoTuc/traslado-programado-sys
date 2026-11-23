import { describe, expect, it } from "vitest";
import { createExecutionHarness, HOME, NOW } from "./helpers/execution.js";

const { appPool, rows, setup } = createExecutionHarness("positions-test");

async function storedPositions() {
  return await rows("SELECT * FROM positions ORDER BY phone_time, id");
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
