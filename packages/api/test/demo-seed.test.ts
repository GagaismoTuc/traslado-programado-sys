import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp, type Router, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { runDemoSeed, type SeedFetch } from "../src/demo-seed.js";
import type { VroomProblem, VroomSolver } from "../src/planner.js";
import { signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const OFFICE = "https://office.test";
const DAY = "2026-12-05";
const clock = { now: new Date("2026-11-23T12:00:00.000Z") };
const states: string[] = [];

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

afterEach(async () => {
  await Promise.all(states.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Point = { lat: number; lng: number };
// Stand-in for OSRM: 1 m per 0.00001 degree of lat plus lng, at 10 m/s, or `legSeconds` per leg when given (only for
// Recorridos that stop at `slowAt`, when that is given too).
const routerWith = (legSeconds?: number, slowAt?: Point): Router => async (points) => {
  const slow = legSeconds !== undefined && (!slowAt || points.some((point) => point.lat === slowAt.lat && point.lng === slowAt.lng));
  return points.slice(1).map((to, index) => {
    const from = points[index];
    const meters = Math.round((Math.abs(from.lat - to.lat) + Math.abs(from.lng - to.lng)) * 100000);
    return { distanceMeters: meters, durationSeconds: slow ? legSeconds : meters / 10 };
  });
};

type Shipment = {
  amount: number[];
  pickup: { id: number; time_windows: number[][] };
  delivery: { id: number; time_windows: number[][] };
};

/**
 * Stand-in for VROOM: picks up the Traslados in input order and drops them all off when each window closes; the last
 * `leaveOut` Traslados of each Recorrido are left unassigned.
 */
function fakeEngine(options: { leaveOut?: number } = {}) {
  const problems: unknown[] = [];
  const solver: VroomSolver = async (problem: VroomProblem) => {
    problems.push(problem);
    const shipments = (problem as unknown as { shipments: Shipment[] }).shipments;
    const taken = shipments.slice(0, shipments.length - (options.leaveOut ?? 0));
    const unassigned = shipments.slice(taken.length)
      .flatMap((shipment) => [{ id: shipment.pickup.id, type: "pickup" }, { id: shipment.delivery.id, type: "delivery" }]);
    const steps = [
      { type: "start", arrival: 0, distance: 0 },
      ...taken.map((shipment, index) => ({
        type: "pickup", id: shipment.pickup.id, arrival: shipment.pickup.time_windows[0][0], waiting_time: 0, distance: 1000 * (index + 1),
      })),
      ...taken.map((shipment, index) => ({
        type: "delivery",
        id: shipment.delivery.id,
        arrival: shipment.delivery.time_windows[0][1],
        waiting_time: 0,
        distance: 1000 * (taken.length + index + 1),
      })),
    ];
    return { unassigned, routes: taken.length ? [{ steps }] : [] };
  };
  return { problems, solver };
}

type Call = { url: string; method: string; origin: string | null; body: string | undefined };

/** The API under test behind the office URL, plus every call the seed made. */
function environment(engine = fakeEngine(), options: { down?: boolean; legSeconds?: number; slowAt?: Point } = {}) {
  const app = createApp({
    db: appPool,
    routing: routingUp,
    router: routerWith(options.legSeconds, options.slowAt),
    solver: engine.solver,
    travelTime: async () => 600,
    config: { serverEpoch: "demo-seed-test", trustedOrigins: [OFFICE], now: () => clock.now, getClientIp: () => "198.51.100.41" },
  });
  const calls: Call[] = [];
  const fetch: SeedFetch = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", origin: headers.get("Origin"), body: init.body as string | undefined });
    if (options.down) throw new TypeError("fetch failed");
    return await app.request(url.replace(`${OFFICE}/api`, "http://localhost"), init);
  };
  return { app, calls, fetch, engine };
}

async function stateDir(project = "staging", options: { urls?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "demo-seed-"));
  states.push(dir);
  await writeFile(join(dir, ".env"), `DEPLOY_PROJECT=${project}\nIMAGE_TAG=test\n`);
  if (options.urls ?? true) await writeFile(join(dir, "urls"), `office: ${OFFICE}\ndriver: https://driver.test\n`);
  await writeFile(join(dir, "office-password"), "oficina-demo-password\n");
  return dir;
}

/** The synthetic Oficina account the environment creates (#134), optionally with its TOTP already enrolled. */
async function officeAccount(enrolledKey?: Buffer) {
  await migrationPool.query(
    "INSERT INTO users (username, password_hash, role, totp_secret, totp_confirmed_at) VALUES ($1, $2, 'office', $3, $4)",
    ["demo-oficina", await hashPassword("oficina-demo-password"), enrolledKey ? enrolledKey.toString("base64url") : null, enrolledKey ? clock.now : null],
  );
}

async function seed(env: ReturnType<typeof environment>, state: string, date = DAY, project = "staging") {
  const lines: string[] = [];
  await runDemoSeed({ project, stateDir: state, date, fetch: env.fetch, now: () => clock.now, log: (line) => lines.push(line) });
  return lines;
}

/** Reads through the API with a second Oficina session, as a person at the office would. */
async function office(env: ReturnType<typeof environment>) {
  await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ('lectura-oficina', $1, 'office') ON CONFLICT (username) DO NOTHING",
    [await hashPassword("lectura")],
  );
  const { cookie } = await signInOffice(env.app, migrationPool, "lectura-oficina", "lectura");
  return async (path: string) => {
    const response = await env.app.request(path, { headers: { Cookie: cookie, Origin: "http://localhost" } });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as Record<string, Record<string, unknown>[]> & Record<string, unknown>;
  };
}

async function counts(read: Awaited<ReturnType<typeof office>>) {
  const passengers = (await read("/passengers")).passengers;
  return {
    destinations: (await read("/destinations")).destinations.length,
    vehicles: (await read("/vehicles")).vehicles.length,
    drivers: (await read("/drivers")).drivers.length,
    passengers: passengers.length,
    users: (await read("/users")).users.length,
    adults: (await Promise.all(passengers.map(async (passenger) =>
      (await read(`/passengers/${passenger.id}/authorized-adults`)).adults.length))).reduce((sum, count) => sum + count, 0),
  };
}

describe("demo seed", () => {
  it("Regla 1: creates the demo only through the API's HTTP routes with the office Origin, ordering with the engine", async () => {
    const env = environment();
    await officeAccount();
    await seed(env, await stateDir());
    expect(env.calls.length).toBeGreaterThan(0);
    expect(env.calls.every((call) => call.url.startsWith(`${OFFICE}/api/`) && call.origin === OFFICE)).toBe(true);
    const day = await (await office(env))(`/daily-plans/${DAY}`);
    expect(day.routes).toHaveLength(3);
    expect(day.routes.every((route) => route.version === 1)).toBe(true);
    expect(day.unpublishedTransferIds).toEqual([]);
    expect(env.engine.problems).toHaveLength(3);
  });

  it("Regla 2: uses synthetic names, invalid DNI and phones, and only neutral requirements", async () => {
    const env = environment();
    await officeAccount();
    await seed(env, await stateDir());
    const read = await office(env);
    const passengers = (await read("/passengers")).passengers;
    expect(passengers.map((passenger) => passenger.name)).toEqual(Array.from({ length: 12 }, (_, i) => `Pasajero Demo ${String(i + 1).padStart(2, "0")}`));
    expect(passengers.every((passenger) => passenger.medicalAlert === null && passenger.accessNotes === null)).toBe(true);
    expect(passengers.filter((passenger) => passenger.frontSeat).length).toBeGreaterThan(0);
    expect(Object.keys(passengers[0]).some((field) => /sex|gender|genero|diagn/i.test(field))).toBe(false);
    for (const passenger of passengers) {
      const [adult] = (await read(`/passengers/${passenger.id}/authorized-adults`)).adults;
      expect(adult.name).toMatch(/^Adulto Demo \d\d$/);
      expect(adult.dni).toMatch(/^DEMO-\d\d$/);
      expect(adult.phone).toMatch(/^000-000-00\d\d$/);
    }
    const drivers = (await read("/drivers")).drivers;
    expect(drivers.map((driver) => driver.name)).toEqual(["Chofer Demo 1", "Chofer Demo 2", "Chofer Demo 3"]);
    const places = [...(await read("/destinations")).destinations.map((row) => row.address), ...passengers.map((row) => row.homeAddress)];
    expect(places.every((address) => String(address).endsWith("San Miguel de Tucumán"))).toBe(true);
  });

  it("Regla 3: loads 3 Choferes with account and usual Vehículo, 3 Vehículos, 4 Destinos, 12 Pasajeros and 3 morning entradas of 4", async () => {
    const env = environment();
    await officeAccount();
    await seed(env, await stateDir());
    const read = await office(env);
    const drivers = (await read("/drivers")).drivers;
    expect(drivers).toHaveLength(3);
    expect(drivers.every((driver) => typeof driver.username === "string" && driver.usualVehicleId !== null)).toBe(true);
    expect((await read("/vehicles")).vehicles).toHaveLength(3);
    expect((await read("/destinations")).destinations).toHaveLength(4);
    expect((await read("/passengers")).passengers).toHaveLength(12);
    const day = await read(`/daily-plans/${DAY}`);
    expect(day.transfers).toHaveLength(12);
    expect(day.transfers.every((transfer) => transfer.direction === "entrada" && String(transfer.targetTime) < "12:00")).toBe(true);
    for (const route of day.routes) {
      expect(day.transfers.filter((transfer) => transfer.routeId === route.id)).toHaveLength(4);
      expect(String(route.startTime) < "12:00").toBe(true);
    }
  });

  it("Regla 4: a second run with the same date duplicates nothing and says the published plan is left untouched", async () => {
    const env = environment();
    await officeAccount();
    const state = await stateDir();
    await seed(env, state);
    const read = await office(env);
    const before = await counts(read);
    const dayBefore = await read(`/daily-plans/${DAY}`);
    const lines = await seed(env, state);
    expect(await counts(read)).toEqual(before);
    expect(await read(`/daily-plans/${DAY}`)).toEqual(dayBefore);
    expect(lines).toContain(`El Plan diario ${DAY} ya tiene Recorridos publicados: no lo toco.`);
    expect(env.calls.filter((call) => call.url.endsWith("/publish"))).toHaveLength(3);
  });

  it("Regla 5: another date reuses the masters and only creates that date's Plan diario", async () => {
    const env = environment();
    await officeAccount();
    const state = await stateDir();
    await seed(env, state);
    const read = await office(env);
    const before = await counts(read);
    await seed(env, state, "2026-12-06");
    expect(await counts(read)).toEqual(before);
    const other = await read("/daily-plans/2026-12-06");
    expect(other.routes).toHaveLength(3);
    expect(other.routes.every((route) => route.version === 1)).toBe(true);
    expect((await read(`/daily-plans/${DAY}`)).routes).toHaveLength(3);
  });

  it("Regla 6: saves the generated Chofer passwords in demo-driver-passwords, operator-only, and they sign the Choferes in", async () => {
    const env = environment();
    await officeAccount();
    const state = await stateDir();
    const lines = await seed(env, state);
    const file = join(state, "demo-driver-passwords");
    const entries = (await readFile(file, "utf8")).trim().split("\n").map((line) => line.split(":"));
    expect(entries.map(([username]) => username)).toEqual(["chofer-demo-1", "chofer-demo-2", "chofer-demo-3"]);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    const signIn = async (username: string, password: string) => (await env.app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ username, password, deviceLabel: "Teléfono de prueba" }),
    })).status;
    for (const [username, password] of entries) {
      expect(await signIn(username, password)).toBe(200);
      expect(lines.join("\n")).not.toContain(password);
    }
    // Without the file, a rerun gives the existing accounts new passwords instead of leaving them unusable.
    await rm(file);
    await seed(env, state);
    const renewed = (await readFile(file, "utf8")).trim().split("\n").map((line) => line.split(":"));
    for (const [username, password] of renewed) expect(await signIn(username, password)).toBe(200);
  });

  it("prints the Oficina and Chofer usernames and the password files, never the passwords", async () => {
    const env = environment();
    await officeAccount();
    const state = await stateDir();
    const lines = await seed(env, state);
    expect(lines.slice(-3)).toEqual([
      "Credenciales:",
      `  Oficina: demo-oficina (contraseña en ${join(state, "office-password")}, TOTP en ${join(state, "office-totp-secret")})`,
      `  Choferes: chofer-demo-1, chofer-demo-2, chofer-demo-3 (contraseñas en ${join(state, "demo-driver-passwords")})`,
    ]);
    expect(lines.join("\n")).not.toContain("oficina-demo-password");
  });

  it("Regla 7: enrols the TOTP the first time, saves the secret and prints the otpauth URI; later runs use the saved secret", async () => {
    const env = environment();
    await officeAccount();
    const state = await stateDir();
    const lines = await seed(env, state);
    const secret = (await readFile(join(state, "office-totp-secret"), "utf8")).trim();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    if (process.platform !== "win32") expect((await stat(join(state, "office-totp-secret"))).mode & 0o777).toBe(0o600);
    const uri = lines.find((line) => line.includes("otpauth://"))!;
    expect(uri).toContain(`secret=${secret}`);
    // Same 30-second step as the enrolment: the rerun must still pass the second factor with the saved secret.
    const rerun = await seed(env, state, "2026-12-06");
    expect(rerun.some((line) => line.includes("otpauth://"))).toBe(false);
    expect((await (await office(env))("/daily-plans/2026-12-06")).routes).toHaveLength(3);
    expect((await readFile(join(state, "office-totp-secret"), "utf8")).trim()).toBe(secret);
  });

  it("Regla 7: with the TOTP enrolled and office-totp-secret missing it fails pointing to db:break-glass-office and creates nothing", async () => {
    const env = environment();
    await officeAccount(Buffer.alloc(20, 7));
    const state = await stateDir();
    await expect(seed(env, state)).rejects.toThrow(
      `demo-oficina ya tiene el TOTP enrolado pero falta ${join(state, "office-totp-secret")}: recuperá la cuenta con db:break-glass-office y volvé a correr el seed`,
    );
    expect(await counts(await office(env))).toEqual({ destinations: 0, vehicles: 0, drivers: 0, passengers: 0, users: 2, adults: 0 });
    await expect(readFile(join(state, "demo-driver-passwords"))).rejects.toThrow();
  });

  it("Regla 8: fails with the engine's result when a Traslado is left without Recorrido and publishes nothing", async () => {
    const env = environment(fakeEngine({ leaveOut: 1 }));
    await officeAccount();
    await expect(seed(env, await stateDir())).rejects.toThrow(/El motor de rutas dejó sin Recorrido, en el de Chofer Demo 1: Pasajero Demo 04 \(/);
    const day = await (await office(env))(`/daily-plans/${DAY}`);
    expect(day.routes.every((route) => route.version === null)).toBe(true);
    expect(env.calls.some((call) => call.url.endsWith("/publish"))).toBe(false);
  });

  it("Regla 8: fails with the validator's error and never forces the publication", async () => {
    // Every leg takes an hour, so the rides break the 60-minute limit the seed gives each Pasajero.
    const env = environment(fakeEngine(), { legSeconds: 3600 });
    await officeAccount();
    await expect(seed(env, await stateDir())).rejects.toThrow(/respondió 409: The Recorrido breaks limits: fix it or publish it with a reason \[/);
    const day = await (await office(env))(`/daily-plans/${DAY}`);
    expect(day.routes.every((route) => route.version === null)).toBe(true);
    const publishes = env.calls.filter((call) => call.url.endsWith("/publish"));
    expect(publishes).toHaveLength(1);
    expect(publishes.every((call) => call.body === "{}")).toBe(true);
  });

  it("Regla 4: a rerun on a day published only in part leaves it untouched and fails saying what is missing", async () => {
    // Only the Recorrido to the Centro de día Demo (Chofer Demo 2) breaks limits, after Chofer Demo 1's is published.
    const env = environment(fakeEngine(), { legSeconds: 3600, slowAt: { lat: -26.8369, lng: -65.2124 } });
    await officeAccount();
    const state = await stateDir();
    await expect(seed(env, state)).rejects.toThrow(/respondió 409: The Recorrido breaks limits/);
    const read = await office(env);
    const before = await read(`/daily-plans/${DAY}`);
    expect(before.routes.map((route) => route.version)).toEqual([1, null, null]);
    await expect(seed(env, state)).rejects.toThrow(
      `El Plan diario ${DAY} quedó publicado a medias (falta: el Recorrido de Chofer Demo 2, el Recorrido de Chofer Demo 3, Traslados sin publicar): no lo toco; terminá de publicarlo desde la Oficina`,
    );
    expect(await read(`/daily-plans/${DAY}`)).toEqual(before);
  });

  it("Regla 9: an invalid or past date fails before any request", async () => {
    const env = environment();
    await officeAccount();
    const state = await stateDir();
    await expect(seed(env, state, "2026-02-30")).rejects.toThrow('Fecha inválida "2026-02-30": usá AAAA-MM-DD');
    await expect(seed(env, state, "05/12/2026")).rejects.toThrow('Fecha inválida "05/12/2026": usá AAAA-MM-DD');
    await expect(seed(env, state, "2026-11-22")).rejects.toThrow("La fecha 2026-11-22 ya pasó: elegí hoy (2026-11-23) o una fecha futura");
    expect(env.calls).toEqual([]);
  });

  it("Regla 9: without the environment up it fails with \"levantá el staging con local-staging.sh up\"", async () => {
    await officeAccount();
    const notStarted = environment();
    await expect(seed(notStarted, await stateDir("staging", { urls: false }))).rejects.toThrow(/^levantá el staging con local-staging.sh up$/);
    expect(notStarted.calls).toEqual([]);
    const unreachable = environment(fakeEngine(), { down: true });
    await expect(seed(unreachable, await stateDir())).rejects.toThrow(/^levantá el staging con local-staging.sh up$/);
    expect(unreachable.calls.map((call) => call.url)).toEqual([`${OFFICE}/api/health`]);
  });

  it("Regla 10: runs only with DEPLOY_PROJECT staging or prueba-de-campo", async () => {
    const env = environment();
    await officeAccount();
    await expect(seed(env, await stateDir("production"), DAY, "production"))
      .rejects.toThrow('El seed de demo solo corre con DEPLOY_PROJECT=staging o DEPLOY_PROJECT=prueba-de-campo, no con "production"');
    const stagingState = await stateDir("staging");
    await expect(seed(env, stagingState, DAY, "prueba-de-campo")).rejects.toThrow(`${join(stagingState, ".env")} no es del proyecto prueba-de-campo: no siembro nada`);
    expect(env.calls).toEqual([]);
    await seed(env, await stateDir("prueba-de-campo"), DAY, "prueba-de-campo");
    expect((await (await office(env))(`/daily-plans/${DAY}`)).routes.every((route) => route.version === 1)).toBe(true);
  });
});
