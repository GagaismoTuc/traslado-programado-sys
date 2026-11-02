import { randomUUID } from "node:crypto";
import { afterAll, expect } from "vitest";
import { createApp, type AppConfig, type HealthDatabase, type Router, type RoutingHealth } from "../../src/app.js";
import { hashPassword } from "../../src/auth.js";
import { createPool } from "../../src/db.js";
import type { VroomSolver } from "../../src/planner.js";
import type { TravelTime } from "../../src/routing.js";
import { getSessionCookie, signInOffice } from "./office-session.js";

const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
// Stand-in for OSRM: 1 m per 0.00001 degree of lat plus lng, at 10 m/s.
const fakeRouter: Router = async (points) => points.slice(1).map((to, index) => {
  const from = points[index];
  const meters = Math.round((Math.abs(from.lat - to.lat) + Math.abs(from.lng - to.lng)) * 100000);
  return { distanceMeters: meters, durationSeconds: meters / 10 };
});

// 09:00 of 2026-10-23 in Tucumán (UTC-3).
export const NOW = "2026-10-23T12:00:00.000Z";
export const TODAY = "2026-10-23";
export const YESTERDAY = "2026-10-22";
// Synthetic places only.
export const HOME = { lat: -26.83, lng: -65.21 };
const SCHOOL = { lat: -26.82, lng: -65.2 };

type Direction = "entrada" | "salida";

/**
 * Test app for the execution day: an Oficina, a school, Pasajeros with a Responsable legal and a Consentimiento, Choferes
 * with their own Vehículo, and helpers to plan, publish and mark Recorridos. Synthetic data only.
 */
export function createExecutionHarness(
  epoch: string,
  extra: Partial<AppConfig> = {},
  engine: { solver?: VroomSolver; travelTime?: TravelTime; wrapDb?: (db: HealthDatabase) => HealthDatabase } = {},
) {
  const appPool = createPool(process.env.TEST_DATABASE_URL!);
  const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
  afterAll(async () => {
    await Promise.all([appPool.end(), migrationPool.end()]);
  });
  const clock = { now: new Date(NOW) };
  const { wrapDb = (db: HealthDatabase) => db, ...engines } = engine;
  const app = createApp({ db: wrapDb(appPool), routing: routingUp, router: fakeRouter, ...engines, config: { serverEpoch: epoch, now: () => clock.now, ...extra } });

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

  async function rows(sql: string, values: unknown[] = []) {
    return (await migrationPool.query(sql, values)).rows;
  }

  async function setup(name: string) {
    clock.now = new Date(NOW);
    const officeId = await seedUser(`oficina-${name}`, "office");
    const office = (await signInOffice(app, migrationPool, `oficina-${name}`, `oficina-${name}-password`)).cookie;
    const post = async (path: string, body: unknown, status = 201) => await answer(request(path, "POST", body, office), status);
    const school = (await post("/destinations", {
      name: `Escuela ${name}`, kind: "school", address: "Avenida Sintetica 303", ...SCHOOL,
    })).destination.id as number;
    const therapy = (await post("/destinations", {
      name: `Terapia ${name}`, kind: "therapy", address: "Pasaje de Prueba 202", lat: -26.81, lng: -65.19,
    })).destination.id as number;
    let choferes = 0;
    const chofer = async () => {
      const index = ++choferes;
      const vehicle = (await post("/vehicles", { plate: `${name.slice(0, 3).toUpperCase()}00${index}`, model: "Furgón Sintético", seats: 8 })).vehicle.id as number;
      const username = `chofer-${name}-${index}`;
      const userId = await seedUser(username, "driver");
      const driverId = (await post("/drivers", {
        userId, name: `Chofer Sintético ${index}`, homeAddress: "Pasaje de Prueba 202", homeLat: -26.85, homeLng: -65.23, usualVehicleId: vehicle,
      })).driver.id as number;
      const login = await request("/auth/login", "POST", { username, password: `${username}-password`, deviceLabel: "Celular sintético" });
      expect(login.status).toBe(200);
      return { userId, driverId, cookie: getSessionCookie(login).cookie, sessionId: Number((await login.json()).sessionId) };
    };
    let passengers = 0;
    /** A Pasajero with a Responsable legal who signed the Consentimiento and an Adulto autorizado without the flag. */
    const passenger = async (otherAdultAllowed = false) => {
      const index = ++passengers;
      const passengerId = (await post("/passengers", {
        name: `Pasajero Sintético ${index}`, homeAddress: "Calle Inventada 101", homeLat: HOME.lat, homeLng: HOME.lng, companions: 0,
        frontSeat: false, wheelchair: false, maxRideTimeMinutes: 60, pickupDurationMinutes: 5, dropoffDurationMinutes: 5,
      })).passenger.id as number;
      const guardian = (await post(`/passengers/${passengerId}/authorized-adults`, {
        name: "Madre Sintética", dni: `-100000${index}`, relation: "madre", phone: `381-000-000${index}`, legalGuardian: true,
      })).adult.id as number;
      const neighbour = (await post(`/passengers/${passengerId}/authorized-adults`, {
        name: "Vecino Sintético", dni: `-200000${index}`, relation: "vecino", phone: `381-000-100${index}`, legalGuardian: false,
      })).adult.id as number;
      await post(`/passengers/${passengerId}/consent`, { signedByAdultId: guardian, signedAt: "2026-10-01", otherAdultAllowed });
      return { passengerId, guardian, neighbour };
    };
    const plans = new Set<string>();
    const route = async (driverId: number, date = TODAY) => {
      if (!plans.has(date)) await post("/daily-plans", { date });
      plans.add(date);
      return (await post(`/daily-plans/${date}/routes`, { driverId, startTime: "06:00", endTime: "18:00" })).route.id as number;
    };
    const transfer = async (passengerId: number, direction: Direction, targetTime: string, date = TODAY, originDestinationId?: number) => {
      if (!plans.has(date)) await post("/daily-plans", { date });
      plans.add(date);
      return (await post(`/daily-plans/${date}/transfers`, {
        passengerId, direction, destinationId: school, targetTime,
        ...(originDestinationId ? { originDestinationId, exitTime: "10:00" } : {}),
      })).transfer.id as number;
    };
    const assign = async (transferId: number, routeId: number | null) => {
      await answer(request(`/transfers/${transferId}`, "PATCH", { routeId }, office), 200);
    };
    const publish = async (routeId: number) => (await post(`/routes/${routeId}/publish`, {})).version.version as number;
    /** One published Recorrido of a new Chofer serving one Traslado of the Pasajero. */
    const served = async (passengerId: number, direction: Direction, targetTime = direction === "entrada" ? "08:00" : "13:00", date = TODAY) => {
      const driver = await chofer();
      const routeId = await route(driver.driverId, date);
      const transferId = await transfer(passengerId, direction, targetTime, date);
      await assign(transferId, routeId);
      await publish(routeId);
      return { driver, routeId, transferId };
    };
    return { officeId, office, post, school, therapy, chofer, passenger, route, transfer, assign, publish, served };
  }

  /** A Marca as the phone sends it, with a fresh UUID and the current clock as phone time. */
  function markBody(transferId: number, kind: "subio" | "ausente" | "entregado" | "undo", fields: Record<string, unknown> = {}) {
    return { id: randomUUID(), transferId, kind, phoneTime: clock.now.toISOString(), location: HOME, version: 1, ...fields };
  }

  async function mark(cookie: string, routeId: number, body: unknown) {
    return await request(`/driver/routes/${routeId}/marks`, "POST", body, cookie);
  }

  return { appPool, migrationPool, clock, app, request, answer, rows, setup, markBody, mark };
}
