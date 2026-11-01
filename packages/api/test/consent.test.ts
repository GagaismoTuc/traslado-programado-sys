import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };
const app = createApp({ db: appPool, routing: routingUp, config: { serverEpoch: "consent-test" } });

const DAY = "2026-11-02";

// Synthetic data only: negative DNIs are never real identity numbers.
const validPassenger = {
  name: "Pasajero Sintético",
  homeAddress: "Calle Inventada 101",
  homeLat: -26.83,
  homeLng: -65.21,
  companions: 0,
  frontSeat: false,
  wheelchair: false,
  maxRideTimeMinutes: 60,
  pickupDurationMinutes: 5,
  dropoffDurationMinutes: 5,
};
const mother = { name: "Madre Sintética", dni: "-1000001", relation: "madre", phone: "381-000-0001", legalGuardian: true };
const neighbour = { name: "Vecino Sintético", dni: "-1000002", relation: "vecino", phone: "381-000-0002", legalGuardian: false };

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

async function seedUser(username: string, role: "office" | "driver") {
  const result = await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
    [username, await hashPassword(`${username}-password`), role],
  );
  return Number(result.rows[0].id);
}

async function signIn(username: string, role: "office" | "driver") {
  const id = await seedUser(username, role);
  if (role === "office") return { id, cookie: (await signInOffice(app, migrationPool, username, `${username}-password`)).cookie };
  const response = await request("/auth/login", "POST", { username, password: `${username}-password`, deviceLabel: "Test browser" });
  return { id, cookie: getSessionCookie(response).cookie };
}

async function ok(response: Response | Promise<Response>, status = 201) {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return resolved.status === 204 ? null : await resolved.json();
}

async function passenger(office: string, name = validPassenger.name) {
  return (await ok(request("/passengers", "POST", { ...validPassenger, name }, office))).passenger.id as number;
}

async function adult(office: string, passengerId: number, fields: Record<string, unknown> = mother) {
  return (await ok(request(`/passengers/${passengerId}/authorized-adults`, "POST", fields, office))).adult;
}

async function changes(entity: string) {
  return (await migrationPool.query(
    "SELECT actor_user_id, entity_id, action, before_data, after_data FROM change_log WHERE entity = $1 ORDER BY id",
    [entity],
  )).rows;
}

async function stored(table: string) {
  return (await migrationPool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
}

beforeAll(async () => {
  await appPool.query("SELECT 1");
});

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

describe("Adultos autorizados and Consentimiento", () => {
  it("lets only the Oficina add, edit and remove Adultos autorizados and record the Consentimiento, logging each write", async () => {
    const driver = await signIn("chofer-adultos", "driver");
    const office = await signIn("oficina-adultos", "office");
    const passengerId = await passenger(office.cookie);

    for (const [method, path, body] of [
      ["GET", `/passengers/${passengerId}/authorized-adults`, undefined],
      ["POST", `/passengers/${passengerId}/authorized-adults`, mother],
      ["PATCH", "/authorized-adults/1", mother],
      ["DELETE", "/authorized-adults/1", undefined],
      ["GET", `/passengers/${passengerId}/consent`, undefined],
      ["POST", `/passengers/${passengerId}/consent`, { signedByAdultId: 1, signedAt: "2026-10-01", otherAdultAllowed: false }],
    ] as const) {
      expect((await request(path, method, body)).status, `${method} ${path} without session`).toBe(401);
      expect((await request(path, method, body, driver.cookie)).status, `${method} ${path} as Chofer`).toBe(403);
    }
    expect(await stored("authorized_adults")).toEqual([]);
    expect(await stored("consents")).toEqual([]);

    const created = await adult(office.cookie, passengerId, { ...mother, name: "  Madre Sintética  " });
    expect(created).toEqual({ id: expect.any(Number), passengerId, ...mother });
    const other = await adult(office.cookie, passengerId, neighbour);
    const edited = { ...neighbour, name: "Vecina Sintética", phone: "381-000-0099" };
    expect(await ok(request(`/authorized-adults/${other.id}`, "PATCH", edited, office.cookie), 200)).toEqual({
      adult: { id: other.id, passengerId, ...edited },
    });
    expect(await ok(request(`/passengers/${passengerId}/authorized-adults`, "GET", undefined, office.cookie), 200)).toEqual({
      adults: [created, { id: other.id, passengerId, ...edited }],
    });
    await ok(request(`/authorized-adults/${other.id}`, "DELETE", undefined, office.cookie), 204);
    // Removing is a logical delete: the row stays, so a Marca or an Autorización puntual can still name the adult.
    expect((await stored("authorized_adults")).map((row) => [row.id, row.removed_at !== null])).toEqual([[created.id, false], [other.id, true]]);
    expect(await ok(request(`/passengers/${passengerId}/authorized-adults`, "GET", undefined, office.cookie), 200)).toEqual({ adults: [created] });
    expect(await changes("authorized_adult")).toEqual([
      { actor_user_id: office.id, entity_id: String(created.id), action: "created", before_data: null, after_data: { passengerId, ...mother } },
      { actor_user_id: office.id, entity_id: String(other.id), action: "created", before_data: null, after_data: { passengerId, ...neighbour } },
      { actor_user_id: office.id, entity_id: String(other.id), action: "updated", before_data: neighbour, after_data: edited },
      { actor_user_id: office.id, entity_id: String(other.id), action: "removed", before_data: { passengerId, ...edited }, after_data: null },
    ]);

    for (const body of [
      { ...mother, name: "" }, { ...mother, dni: " " }, { ...mother, relation: undefined }, { ...mother, phone: undefined },
      { ...mother, legalGuardian: "yes" }, { ...mother, dni: "1".repeat(21) },
    ]) {
      expect((await request(`/passengers/${passengerId}/authorized-adults`, "POST", body, office.cookie)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await ok(request("/passengers/999999/authorized-adults", "POST", mother, office.cookie), 404)).toEqual({ error: "Passenger not found" });
    expect(await ok(request(`/authorized-adults/${other.id}`, "PATCH", mother, office.cookie), 404)).toEqual({ error: "Adulto autorizado not found" });
    expect((await request(`/authorized-adults/${other.id}`, "DELETE", undefined, office.cookie)).status).toBe(404);
    expect(await changes("authorized_adult")).toHaveLength(4);
  });

  it("records the Consentimiento with who signed it, when, and whether the Pasajero may be handed to another adult at home", async () => {
    const office = await signIn("oficina-consentimiento", "office");
    const passengerId = await passenger(office.cookie);
    const signer = await adult(office.cookie, passengerId);
    expect(await ok(request(`/passengers/${passengerId}/consent`, "GET", undefined, office.cookie), 200)).toEqual({ consent: null });

    const consent = { signedByAdultId: signer.id, signedAt: "2026-10-01", otherAdultAllowed: false };
    expect(await ok(request(`/passengers/${passengerId}/consent`, "POST", consent, office.cookie))).toEqual({
      consent: { ...consent, signedByName: "Madre Sintética" },
    });
    // The same Consentimiento again is a no-op: 200, the same row and no new log entry.
    expect((await request(`/passengers/${passengerId}/consent`, "POST", consent, office.cookie)).status).toBe(200);
    expect(await ok(request(`/passengers/${passengerId}/consent`, "GET", undefined, office.cookie), 200)).toEqual({
      consent: { ...consent, signedByName: "Madre Sintética" },
    });
    expect(await stored("consents")).toHaveLength(1);
    expect(await changes("consent")).toEqual([
      { actor_user_id: office.id, entity_id: String(passengerId), action: "recorded", before_data: null, after_data: consent },
    ]);

    for (const body of [
      { ...consent, signedAt: "2026-02-30" }, { ...consent, signedAt: undefined }, { ...consent, otherAdultAllowed: undefined },
      { ...consent, signedByAdultId: "1" },
    ]) {
      expect((await request(`/passengers/${passengerId}/consent`, "POST", body, office.cookie)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request("/passengers/999999/consent", "POST", consent, office.cookie)).status).toBe(404);
    expect((await request("/passengers/999999/consent", "GET", undefined, office.cookie)).status).toBe(404);
  });

  it("refuses to assign a Traslado to a Recorrido when its Pasajero has no Consentimiento, naming the Pasajero", async () => {
    const office = await signIn("oficina-asignar", "office");
    const passengerId = await passenger(office.cookie, "Pasajera Sin Consentimiento");
    const destination = await ok(request("/destinations", "POST", {
      name: "Escuela Sintética", kind: "school", address: "Avenida Sintetica 303", lat: -26.82, lng: -65.2,
    }, office.cookie));
    const vehicle = await ok(request("/vehicles", "POST", { plate: "CS001NT", model: "Furgón Sintético", seats: 8 }, office.cookie));
    const userId = await seedUser("chofer-asignar", "driver");
    const driver = await ok(request("/drivers", "POST", {
      userId, name: "Chofer Sintético", homeAddress: "Pasaje de Prueba 202", homeLat: -26.84, homeLng: -65.22, usualVehicleId: vehicle.vehicle.id,
    }, office.cookie));
    await ok(request("/daily-plans", "POST", { date: DAY }, office.cookie));
    const transfer = (await ok(request(`/daily-plans/${DAY}/transfers`, "POST", {
      passengerId, direction: "entrada", destinationId: destination.destination.id, targetTime: "08:00",
    }, office.cookie))).transfer;
    const route = (await ok(request(`/daily-plans/${DAY}/routes`, "POST", {
      driverId: driver.driver.id, startTime: "07:00", endTime: "09:00",
    }, office.cookie))).route;
    const refusal = { error: "No Consentimiento recorded for Pasajera Sin Consentimiento: record it before assigning a Recorrido" };

    expect(await ok(request(`/transfers/${transfer.id}`, "PATCH", { routeId: route.id }, office.cookie), 409)).toEqual(refusal);
    const otherDriver = await ok(request("/drivers", "POST", {
      userId: await seedUser("chofer-asignar-2", "driver"), name: "Chofer Dos", homeAddress: "Pasaje de Prueba 202", homeLat: -26.84,
      homeLng: -65.22, usualVehicleId: vehicle.vehicle.id,
    }, office.cookie));
    expect(await ok(request(`/daily-plans/${DAY}/driver-days`, "POST", {
      driverId: otherDriver.driver.id, transferIds: [transfer.id],
    }, office.cookie), 409)).toEqual(refusal);
    expect(await stored("stops")).toEqual([]);
    expect((await stored("routes")).map((row) => row.id)).toEqual([route.id]);
    expect((await changes("transfer")).map((row) => row.action)).toEqual(["created"]);

    const signer = await adult(office.cookie, passengerId);
    await ok(request(`/passengers/${passengerId}/consent`, "POST", {
      signedByAdultId: signer.id, signedAt: "2026-10-01", otherAdultAllowed: false,
    }, office.cookie));
    expect((await ok(request(`/transfers/${transfer.id}`, "PATCH", { routeId: route.id }, office.cookie), 200)).transfer.routeId).toBe(route.id);
  });

  it("logs a change of the other-adult flag with the Oficina user who made it", async () => {
    const office = await signIn("oficina-flag", "office");
    const secretary = await signIn("secretaria-flag", "office");
    const passengerId = await passenger(office.cookie);
    const signer = await adult(office.cookie, passengerId);
    const consent = { signedByAdultId: signer.id, signedAt: "2026-10-01", otherAdultAllowed: false };
    await ok(request(`/passengers/${passengerId}/consent`, "POST", consent, office.cookie));

    const changed = await ok(request(`/passengers/${passengerId}/consent`, "POST", { ...consent, otherAdultAllowed: true }, secretary.cookie), 200);
    expect(changed.consent.otherAdultAllowed).toBe(true);
    expect((await changes("consent")).at(-1)).toEqual({
      actor_user_id: secretary.id,
      entity_id: String(passengerId),
      action: "updated",
      before_data: consent,
      after_data: { ...consent, otherAdultAllowed: true },
    });
    expect((await stored("consents"))[0].other_adult_allowed).toBe(true);
  });

  it("keeps a Responsable legal apart from an Adulto autorizado without the flag, who cannot sign the Consentimiento", async () => {
    const office = await signIn("oficina-responsable", "office");
    const passengerId = await passenger(office.cookie);
    const otherPassengerId = await passenger(office.cookie, "Otro Pasajero Sintético");
    const guardian = await adult(office.cookie, passengerId, mother);
    const notGuardian = await adult(office.cookie, passengerId, neighbour);
    const otherFamily = await adult(office.cookie, otherPassengerId, mother);
    const adults = (await ok(request(`/passengers/${passengerId}/authorized-adults`, "GET", undefined, office.cookie), 200)).adults;
    expect(adults.map((item: { id: number; legalGuardian: boolean }) => [item.id, item.legalGuardian])).toEqual([
      [guardian.id, true], [notGuardian.id, false],
    ]);

    const refusal = { error: "The Consentimiento must be signed by a Responsable legal of this Pasajero" };
    for (const signedByAdultId of [notGuardian.id, otherFamily.id, 999999]) {
      expect(await ok(request(`/passengers/${passengerId}/consent`, "POST", {
        signedByAdultId, signedAt: "2026-10-01", otherAdultAllowed: false,
      }, office.cookie), 409), String(signedByAdultId)).toEqual(refusal);
    }
    expect(await stored("consents")).toEqual([]);
    await ok(request(`/passengers/${passengerId}/consent`, "POST", {
      signedByAdultId: guardian.id, signedAt: "2026-10-01", otherAdultAllowed: false,
    }, office.cookie));

    // The signer stays a Responsable legal while the Consentimiento names them.
    const signerMustStay = { error: "This Adulto autorizado signed the Consentimiento: record it with another Responsable legal first" };
    expect(await ok(request(`/authorized-adults/${guardian.id}`, "PATCH", { ...mother, legalGuardian: false }, office.cookie), 409))
      .toEqual(signerMustStay);
    expect(await ok(request(`/authorized-adults/${guardian.id}`, "DELETE", undefined, office.cookie), 409)).toEqual(signerMustStay);
    expect((await stored("authorized_adults")).find((row) => row.id === guardian.id)?.legal_guardian).toBe(true);
    expect((await changes("authorized_adult")).map((row) => row.action)).toEqual(["created", "created", "created"]);
  });
});
