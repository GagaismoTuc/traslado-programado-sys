import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { createApp, type Router, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
// Stand-in for OSRM: 1 m per 0.00001 degree of lat plus lng, at 10 m/s.
const fakeRouter: Router = async (points) => points.slice(1).map((to, index) => {
  const from = points[index];
  const meters = Math.round((Math.abs(from.lat - to.lat) + Math.abs(from.lng - to.lng)) * 100000);
  return { distanceMeters: meters, durationSeconds: meters / 10 };
});
const clock = { now: new Date("2026-10-23T12:00:00.000Z") };
const app = createApp({ db: appPool, routing: routingUp, router: fakeRouter, config: { serverEpoch: "plan-size-test", now: () => clock.now } });

const TODAY = "2026-10-23";
const TOMORROW = "2026-10-24";
const BUDGET_BYTES = 100 * 1024;
// Synthetic places only: the homes are near H and the school is D.
const H = { lat: -26.83, lng: -65.21 };
const D = { lat: -26.829, lng: -65.209 };
const PASSENGERS = 5;

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

async function request(path: string, method: string, body?: unknown, cookie?: string) {
  return await app.request(path, {
    method,
    headers: {
      Origin: "http://localhost",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function answer(response: Response | Promise<Response>, status: number) {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return await resolved.json();
}

async function seedUser(username: string, role: "office" | "driver") {
  const result = await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
    [username, await hashPassword(`${username}-password`), role],
  );
  return Number(result.rows[0].id);
}

type Download = { path: string; status: number; contentType: string; body: string };

/** The Oficina plans a Chofer's today and tomorrow, 10 Traslados each; returns the Chofer's session. */
async function planTwoDays() {
  await seedUser("oficina-plansize", "office");
  const office = (await signInOffice(app, migrationPool, "oficina-plansize", "oficina-plansize-password")).cookie;
  const post = async (path: string, body: unknown, status = 201) => await answer(request(path, "POST", body, office), status);
  const school = (await post("/destinations", {
    name: "Escuela plansize", kind: "school", address: "Avenida Sintetica 303", accessNotes: "Entrada por el portón lateral, esperar al personal de la escuela", ...D,
  })).destination.id as number;
  const vehicle = (await post("/vehicles", { plate: "PLS001", model: "Furgón Sintético", seats: 14 })).vehicle.id as number;
  const username = "chofer-plansize";
  const userId = await seedUser(username, "driver");
  const driverId = (await post("/drivers", {
    userId, name: "Chofer Sintético plansize", homeAddress: "Pasaje de Prueba 202", homeLat: -26.85, homeLng: -65.23, usualVehicleId: vehicle,
  })).driver.id as number;
  const login = await request("/auth/login", "POST", { username, password: `${username}-password`, deviceLabel: "Celular sintético" });
  expect(login.status).toBe(200);
  const cookie = getSessionCookie(login).cookie;

  const passengers: number[] = [];
  for (let index = 1; index <= PASSENGERS; index++) {
    const passenger = (await post("/passengers", {
      name: `Pasajero Sintético plansize ${index}`, homeAddress: `Calle Inventada ${100 + index}, barrio sintético, San Miguel de Tucumán`,
      homeLat: H.lat + index * 0.0005, homeLng: H.lng + index * 0.0005,
      accessNotes: "Timbre del fondo, portón verde con rejas; esperar en la vereda hasta que el adulto abra la puerta y baje la rampa",
      companions: 1, frontSeat: false, wheelchair: false, maxRideTimeMinutes: 90, pickupDurationMinutes: 1, dropoffDurationMinutes: 1,
      medicalAlert: "Alergia sintética a la penicilina; llevar la medicación en la mochila y avisar a la escuela ante cualquier síntoma",
    })).passenger.id as number;
    const adults: number[] = [];
    for (const adult of [1, 2]) {
      adults.push((await post(`/passengers/${passenger}/authorized-adults`, {
        name: `Adulto Sintético ${index}-${adult}`, dni: `-${2000000 + index * 10 + adult}`, relation: adult === 1 ? "madre" : "tía",
        phone: `381-000-${index}00${adult}`, legalGuardian: adult === 1,
      })).adult.id as number);
    }
    await post(`/passengers/${passenger}/consent`, { signedByAdultId: adults[0], signedAt: "2026-10-01", otherAdultAllowed: false });
    passengers.push(passenger);
  }

  for (const date of [TODAY, TOMORROW]) {
    await post("/daily-plans", { date });
    // The planner does not wait between stops, so the morning entradas and the noon salidas are two Recorridos of the day.
    for (const [direction, targetTime, startTime, endTime] of [["entrada", "08:00", "07:15", "09:00"], ["salida", "13:00", "12:45", "14:30"]] as const) {
      const routeId = (await post(`/daily-plans/${date}/routes`, { driverId, startTime, endTime })).route.id as number;
      for (const passengerId of passengers) {
        const transferId = (await post(`/daily-plans/${date}/transfers`, { passengerId, direction, destinationId: school, targetTime })).transfer.id as number;
        await answer(request(`/transfers/${transferId}`, "PATCH", { routeId }, office), 200);
      }
      await post(`/routes/${routeId}/publish`, {});
    }
  }
  return cookie;
}

describe("Plan download size", () => {
  it("measures a Chofer's plan download: JSON only, no map images, under 100 KB", async () => {
    const cookie = await planTwoDays();
    const downloads: Download[] = [];
    const get = async (path: string) => {
      const response = await request(path, "GET", undefined, cookie);
      const download = { path, status: response.status, contentType: response.headers.get("content-type") ?? "", body: await response.text() };
      downloads.push(download);
      return download;
    };

    // What the driver app downloads: the two days, then the handover of every drop-off at a home.
    const days = [await get(`/driver/days/${TODAY}`), await get(`/driver/days/${TOMORROW}`)];
    const stops = days.flatMap((day) => (JSON.parse(day.body) as { routes: { routeId: number; stops: { kind: string; transferId: number; place: { destinationId: number | null } }[] }[] })
      .routes.flatMap((route) => route.stops
        .filter((stop) => stop.kind === "dropoff" && stop.place.destinationId === null)
        .map((stop) => ({ routeId: route.routeId, transferId: stop.transferId }))));
    const handovers = [];
    for (const { routeId, transferId } of stops) handovers.push(await get(`/driver/routes/${routeId}/transfers/${transferId}/handover`));

    const bytes = (items: Download[]) => items.reduce((sum, item) => sum + Buffer.byteLength(item.body), 0);
    const raw = bytes(downloads);
    const gzip = downloads.reduce((sum, item) => sum + gzipSync(item.body).length, 0);
    console.log(`plan download: ${downloads.length} requests, ${raw} bytes raw, ${gzip} bytes gzip (days ${bytes(days)} B, handovers ${bytes(handovers)} B)`);

    for (const download of downloads) {
      expect(download.status, download.path).toBe(200);
      expect(download.contentType, download.path).toContain("application/json");
      expect(download.body, download.path).not.toMatch(/\.(png|jpe?g|webp|pbf|mvt)\b|tiles?\//i);
    }
    expect(handovers).toHaveLength(PASSENGERS * 2);
    expect(raw).toBeLessThan(BUDGET_BYTES);
  });
});
