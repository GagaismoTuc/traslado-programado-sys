import { spawnSync } from "node:child_process";
import { hc } from "hono/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type AppType, type RoutingHealth } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { createSyntheticRecord, SYNTHETIC_DNI_RANGE, TUCUMAN_BOUNDS } from "./factories/synthetic.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };

function clientFor(app: AppType) {
  return hc<AppType>("http://localhost", {
    fetch: (input: string | Request | URL, init?: RequestInit) => app.fetch(new Request(input, init)),
  });
}

beforeAll(async () => {
  await appPool.query("SELECT 1");
});
afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

describe("API test seam", () => {
  it("rejects application role CREATE TABLE and ALTER TABLE", async () => {
    await expect(appPool.query("CREATE TABLE forbidden_table (id integer)")).rejects.toThrow(/permission denied/i);
    await expect(appPool.query("ALTER TABLE foundation_permission_probe ADD COLUMN forbidden integer")).rejects.toThrow(/permission denied|must be owner/i);
  });

  it("uses the newly configured epoch on the same database across API starts", async () => {
    const first = createApp({ routing: routingUp, db: appPool, config: { serverEpoch: "epoch-one" } });
    const second = createApp({ routing: routingUp, db: appPool, config: { serverEpoch: "epoch-two" } });

    const firstResponse = await clientFor(first).health.$get();
    const secondResponse = await clientFor(second).health.$get();

    expect(firstResponse.headers.get("X-Server-Epoch")).toBe("epoch-one");
    expect(secondResponse.headers.get("X-Server-Epoch")).toBe("epoch-two");
    expect(await appPool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '%epoch%'")).toMatchObject({ rowCount: 0 });
  });

  it("generates synthetic records inside the documented test-only bounds", () => {
    const record = createSyntheticRecord(() => 0.5);
    expect(["Calle Inventada 101", "Pasaje de Prueba 202", "Avenida Sintetica 303"]).toContain(record.streetName);
    expect(record.latitude).toBeGreaterThanOrEqual(TUCUMAN_BOUNDS.minLatitude);
    expect(record.latitude).toBeLessThanOrEqual(TUCUMAN_BOUNDS.maxLatitude);
    expect(record.longitude).toBeGreaterThanOrEqual(TUCUMAN_BOUNDS.minLongitude);
    expect(record.longitude).toBeLessThanOrEqual(TUCUMAN_BOUNDS.maxLongitude);
    expect(record.dni).toBeGreaterThanOrEqual(SYNTHETIC_DNI_RANGE.min);
    expect(record.dni).toBeLessThanOrEqual(SYNTHETIC_DNI_RANGE.max);
    expect(record.dni).toBeLessThan(0);
    expect(record).not.toHaveProperty("address");
  });

  it("allows application role inserts into a table created by the Drizzle migration", async () => {
    await appPool.query("INSERT INTO foundation_permission_probe (marker) VALUES ($1)", [createSyntheticRecord().marker]);
    await expect(appPool.query("SELECT count(*)::int AS count FROM foundation_permission_probe")).resolves.toMatchObject({ rows: [{ count: 1 }] });
    const response = await clientFor(createApp({ routing: routingUp, db: appPool, config: { serverEpoch: "synthetic" } })).health.$get();
    expect(response.status).toBe(200);
  });

  it("returns an empty successful health response with the configured epoch", async () => {
    const response = await clientFor(createApp({ routing: routingUp, db: appPool, config: { serverEpoch: "healthy" } })).health.$get();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Server-Epoch")).toBe("healthy");
    expect(await response.text()).toBe("");
  });

  it("uses UTC sessions and a timestamptz column", async () => {
    const result = await appPool.query("SELECT current_setting('TimeZone') AS timezone, data_type FROM information_schema.columns WHERE table_name = 'foundation_permission_probe' AND column_name = 'created_at'");
    expect(result.rows).toEqual([{ timezone: "UTC", data_type: "timestamp with time zone" }]);
  });

  it("returns 503 with no body when the database is down", async () => {
    const app = createApp({ routing: routingUp, db: { query: async () => { throw new Error("database unavailable"); } }, config: { serverEpoch: "down" } });
    const response = await clientFor(app).health.$get();
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Server-Epoch")).toBe("down");
    expect(await response.text()).toBe("");
  });

  it("returns 503 when the database health query times out", async () => {
    const app = createApp({ routing: routingUp, db: { query: () => new Promise(() => undefined) }, config: { serverEpoch: "timeout", healthTimeoutMs: 10 } });
    const response = await clientFor(app).health.$get();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });

  it("requires SERVER_EPOCH before the server can start", () => {
    expect(() => readConfig({ DATABASE_URL: "postgres://app:secret@localhost:5432/app" } as NodeJS.ProcessEnv)).toThrow("SERVER_EPOCH is required");
  });

  it("reads the configured trusted browser origins", () => {
    expect(readConfig({
      SERVER_EPOCH: "epoch",
      DATABASE_URL: "postgres://app:secret@localhost:5432/app",
      OSRM_URL: "http://127.0.0.1:5000",
      VROOM_URL: "http://127.0.0.1:3001",
      AUTH_ALLOWED_ORIGINS: "https://office.example,https://driver.example",
    } as NodeJS.ProcessEnv).trustedOrigins).toEqual(["https://office.example", "https://driver.example"]);
  });

  it("reads the base where company staff receive a Pasajero, unset by default", () => {
    const environment = {
      SERVER_EPOCH: "epoch", DATABASE_URL: "postgres://app:secret@localhost:5432/app", OSRM_URL: "http://127.0.0.1:5000", VROOM_URL: "http://127.0.0.1:3001",
    };
    expect(readConfig(environment as NodeJS.ProcessEnv).baseAddress).toBeNull();
    expect(readConfig({ ...environment, BASE_ADDRESS: " " } as NodeJS.ProcessEnv).baseAddress).toBeNull();
    expect(readConfig({ ...environment, BASE_ADDRESS: " Base Sintética, Calle Inventada 999 " } as NodeJS.ProcessEnv).baseAddress)
      .toBe("Base Sintética, Calle Inventada 999");
    expect(() => readConfig({ ...environment, BASE_ADDRESS: "x".repeat(501) } as NodeJS.ProcessEnv)).toThrow("BASE_ADDRESS must be at most 500 characters");
  });

  it("requires OSRM_URL and VROOM_URL before the server can start", () => {
    const environment = { SERVER_EPOCH: "routing", DATABASE_URL: "postgres://app:secret@localhost:5432/app" };
    expect(() => readConfig({ ...environment, VROOM_URL: "http://127.0.0.1:3001" } as NodeJS.ProcessEnv)).toThrow("OSRM_URL must be a valid URL");
    expect(() => readConfig({ ...environment, OSRM_URL: "http://127.0.0.1:5000" } as NodeJS.ProcessEnv)).toThrow("VROOM_URL must be a valid URL");
  });

  it("refuses to start the server command without SERVER_EPOCH", () => {
    const result = spawnSync(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, SERVER_EPOCH: "", DATABASE_URL: "postgres://app:secret@127.0.0.1:1/app" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SERVER_EPOCH is required");
  });

  it("adds the epoch header to not-found responses", async () => {
    const response = await createApp({ routing: routingUp, db: appPool, config: { serverEpoch: "not-found" } }).request("/missing");
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Server-Epoch")).toBe("not-found");
  });

  it("adds the epoch header to unhandled server errors", async () => {
    const app = createApp({ routing: routingUp, db: appPool, config: { serverEpoch: "server-error" } });
    app.get("/error", () => { throw new Error("unexpected failure"); });
    const response = await app.request("/error");
    expect(response.status).toBe(500);
    expect(response.headers.get("X-Server-Epoch")).toBe("server-error");
  });
});
