import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { createNominatimGeocoder, type Geocoder } from "../src/geocoding.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const suggestion = { lat: -26.8241, lng: -65.2036, displayName: "Calle Inventada 101, San Miguel de Tucumán" };

function appWith(geocoder: Geocoder | undefined, clock = { now: 1_000_000 }) {
  const app = createApp({ db: appPool, routing: routingUp, geocoder, config: { serverEpoch: "geocoding-test", now: () => new Date(clock.now) } });
  return async (path: string, method: string, body?: unknown, cookie?: string) => await app.request(path, {
    method,
    headers: {
      Origin: "http://localhost",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let userNumber = 0;
async function signIn(role: "office" | "driver") {
  const username = `${role}-${++userNumber}`;
  await migrationPool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)", [
    username,
    await hashPassword("password"),
    role,
  ]);
  const response = await appWith(undefined)("/auth/login", "POST", { username, password: "password", deviceLabel: "Test browser" });
  const token = response.headers.get("set-cookie")?.match(/^session=([^;]+)/)?.[1];
  if (!token) throw new Error("session cookie was not set");
  return `session=${token}`;
}

beforeAll(async () => {
  await appPool.query("SELECT 1");
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

describe("Suggest pin", () => {
  it("answers Suggest pin through an Oficina-only POST with a validated query and returns only lat, lng and displayName", async () => {
    const queries: string[] = [];
    const request = appWith(async (query) => {
      queries.push(query);
      return { ...suggestion, osmId: 123, importance: 0.5 } as never;
    });
    const office = await signIn("office");
    const driver = await signIn("driver");

    expect((await request("/geocode", "POST", { query: "Calle Inventada 101" })).status).toBe(401);
    expect((await request("/geocode", "POST", { query: "Calle Inventada 101" }, driver)).status).toBe(403);
    for (const body of [{ query: "" }, { query: "   " }, { query: "q".repeat(501) }, { query: 101 }, { query: ["Calle Inventada 101", "Pasaje de Prueba 202"] }, {}]) {
      const response = await request("/geocode", "POST", body, office);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid request" });
    }
    expect((await request("/geocode?query=Calle%20Inventada%20101", "GET", undefined, office)).status).toBe(404);
    expect(queries).toEqual([]);

    const found = await request("/geocode", "POST", { query: "  Calle Inventada 101  " }, office);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(suggestion);
    expect(queries).toEqual(["Calle Inventada 101"]);
  });

  it("calls Nominatim with the fixed parameters, an identifying User-Agent and a 5-second timeout", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const geocoder = createNominatimGeocoder({
      url: "https://nominatim.example",
      userAgent: "traslado-programado-test (ops@example.invalid)",
      fetch: async (input, init) => {
        calls.push({ url: new URL(String(input)), init: init! });
        return Response.json([{ lat: "-26.8241", lon: "-65.2036", display_name: suggestion.displayName, osm_id: 1 }]);
      },
    });
    await expect(geocoder("Calle Inventada 101")).resolves.toEqual(suggestion);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe("https://nominatim.example/search");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      q: "Calle Inventada 101",
      format: "jsonv2",
      limit: "1",
      countrycodes: "ar",
      "accept-language": "es",
    });
    expect(new Headers(calls[0].init.headers).get("User-Agent")).toBe("traslado-programado-test (ops@example.invalid)");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hanging = createNominatimGeocoder({
      url: "https://nominatim.example",
      userAgent: "traslado-programado-test",
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }),
    });
    let settled = false;
    const pending = hanging("Calle Inventada 101").finally(() => { settled = true; });
    const outcome = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it("sends at most one geocoder request per second across users and serves repeated queries from a bounded cache", async () => {
    const clock = { now: 1_000_000 };
    const queries: string[] = [];
    const request = appWith(async (query) => {
      queries.push(query);
      return suggestion;
    }, clock);
    const first = await signIn("office");
    const second = await signIn("office");

    expect((await request("/geocode", "POST", { query: "Calle Inventada 101" }, first)).status).toBe(200);
    clock.now += 999;
    const throttled = await request("/geocode", "POST", { query: "Pasaje de Prueba 202" }, second);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("1");
    const cached = await request("/geocode", "POST", { query: "  CALLE inventada 101 " }, second);
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual(suggestion);
    expect(queries).toEqual(["Calle Inventada 101"]);

    clock.now += 1;
    const burst = await Promise.all([
      request("/geocode", "POST", { query: "Pasaje de Prueba 202" }, first),
      request("/geocode", "POST", { query: "Avenida Sintetica 303" }, second),
    ]);
    expect(burst.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(queries).toHaveLength(2);

    for (let index = 0; index < 500; index++) {
      clock.now += 1000;
      expect((await request("/geocode", "POST", { query: `Pasaje Ficticio ${index}` }, first)).status).toBe(200);
    }
    clock.now += 1000;
    expect((await request("/geocode", "POST", { query: "Calle Inventada 101" }, first)).status).toBe(200);
    expect(queries).toHaveLength(503);
    expect(queries.at(-1)).toBe("Calle Inventada 101");
  }, 30000);

  it("keeps the geocoder off unless GEOCODER=nominatim", async () => {
    const environment = {
      SERVER_EPOCH: "epoch",
      DATABASE_URL: "postgres://app:secret@localhost:5432/app",
      OSRM_URL: "http://127.0.0.1:5000",
      VROOM_URL: "http://127.0.0.1:3001",
    } as NodeJS.ProcessEnv;
    expect(readConfig(environment)).toMatchObject({ geocoder: "off" });
    expect(readConfig({ ...environment, GEOCODER: "off" })).toMatchObject({ geocoder: "off" });
    expect(readConfig({ ...environment, GEOCODER: "nominatim", NOMINATIM_USER_AGENT: "traslado-programado (ops@example.invalid)" })).toMatchObject({
      geocoder: "nominatim",
      nominatimUrl: "https://nominatim.openstreetmap.org",
      nominatimUserAgent: "traslado-programado (ops@example.invalid)",
    });
    expect(readConfig({ ...environment, GEOCODER: "nominatim" }).nominatimUserAgent).toMatch(/^traslado-programado /);
    expect(() => readConfig({ ...environment, GEOCODER: "google" })).toThrow("GEOCODER must be off or nominatim");

    const response = await appWith(undefined)("/geocode", "POST", { query: "Calle Inventada 101" }, await signIn("office"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Address search is turned off" });
  });

  it("answers a geocoder error, timeout or empty result with an error the Oficina can read", async () => {
    const office = await signIn("office");
    const clock = { now: 1_000_000 };
    const outcomes: Array<[Geocoder, number, string]> = [
      [async () => { throw new Error("Nominatim answered 500"); }, 502, "Address search is unavailable"],
      [async () => { throw new DOMException("Nominatim timed out", "TimeoutError"); }, 502, "Address search is unavailable"],
      [async () => null, 404, "No match for this address"],
    ];
    for (const [geocoder, status, error] of outcomes) {
      clock.now += 1000;
      const response = await appWith(geocoder, clock)("/geocode", "POST", { query: "Calle Inventada 101" }, office);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });
});
