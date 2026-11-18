import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type PushSender, type PushSubscriptionData, type Router, type RoutingHealth } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";
import { getSessionCookie, signInOffice } from "./helpers/office-session.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
const routingUp: RoutingHealth = { osrm: async () => undefined, vroom: async () => undefined };

type Point = { lat: number; lng: number };
const fakeRouter: Router = async (points: Point[]) => {
  return points.slice(1).map(() => ({ distanceMeters: 100, durationSeconds: 60 }));
};

const fakeVapid = {
  publicKey: "BP_test_vapid_public_key",
  privateKey: "test_vapid_private_key",
  subject: "mailto:support@example.com",
};

const sentNotifications: Array<{ subscription: PushSubscriptionData; payload: string }> = [];
let pushSenderFailMode: "none" | "throw_410" | "throw_error" | "status_410" | "hang" = "none";

const pushSender: PushSender = async (subscription, payload) => {
  sentNotifications.push({ subscription, payload });
  if (pushSenderFailMode === "hang") {
    await new Promise(() => {});
  }
  if (pushSenderFailMode === "throw_410") {
    const error: any = new Error("Subscription expired");
    error.statusCode = 410;
    throw error;
  }
  if (pushSenderFailMode === "status_410") {
    return { statusCode: 410 };
  }
  if (pushSenderFailMode === "throw_error") {
    throw new Error("Push service network error");
  }
};

const app = createApp({
  db: appPool,
  routing: routingUp,
  router: fakeRouter,
  pushSender,
  config: {
    serverEpoch: "push-test",
    vapid: fakeVapid,
  },
});

const DAY = "2026-11-02";
const H = { lat: -26.83, lng: -65.21 };
const D = { lat: -26.82, lng: -65.2 };

beforeEach(async () => {
  sentNotifications.length = 0;
  pushSenderFailMode = "none";
});

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

async function seedUser(username: string, role: "office" | "driver") {
  const result = await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
    [username, await hashPassword(`${username}-password`), role],
  );
  return Number(result.rows[0].id);
}

async function ok(response: Response | Promise<Response>, status = 201) {
  const resolved = await response;
  expect(resolved.status, await resolved.clone().text()).toBe(status);
  return await resolved.json();
}

async function loginDriver(username = "driver-push", deviceLabel = "Phone device") {
  const passwordHash = await hashPassword("password");
  const userResult = await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'driver') RETURNING id",
    [username, passwordHash],
  );
  const userId = Number(userResult.rows[0].id);
  const driverResult = await migrationPool.query(
    "INSERT INTO drivers (user_id, name, home_address, home_latitude, home_longitude) VALUES ($1, $2, 'Calle Inventada 100', -26.8, -65.2) RETURNING id",
    [userId, `Chofer ${username}`],
  );
  const driverId = Number(driverResult.rows[0].id);

  const loginRes = await request("/auth/login", "POST", { username, password: "password", deviceLabel });
  const { cookie } = getSessionCookie(loginRes);
  return { userId, driverId, cookie };
}

async function setup(name: string) {
  const officeId = await seedUser(`oficina-${name}`, "office");
  const office = (await signInOffice(app, migrationPool, `oficina-${name}`, `oficina-${name}-password`)).cookie;
  const post = async (path: string, body: unknown, status = 201) => await ok(request(path, "POST", body, office), status);
  const destination = async (place: Point, label: string) =>
    (await post("/destinations", { name: label, kind: "school", address: "Avenida Sintetica 303", ...place })).destination.id as number;
  const school = await destination(D, `Escuela ${name}`);
  let plates = 0;
  const vehicle = async () =>
    (await post("/vehicles", { plate: `${name.slice(0, 3).toUpperCase()}${String(++plates).padStart(3, "0")}`, model: "Furgón Sintético", seats: 8 })).vehicle.id as number;

  const driverWithUser = async (usualVehicleId: number) => {
    const username = `driver-${name}-${++plates}`;
    const passwordHash = await hashPassword("password");
    const userResult = await migrationPool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'driver') RETURNING id",
      [username, passwordHash],
    );
    const userId = Number(userResult.rows[0].id);
    const driverResult = await post("/drivers", {
      userId, name: `Chofer ${username}`, homeAddress: "Pasaje de Prueba 202", homeLat: -26.85, homeLng: -65.23, usualVehicleId,
    });
    const driverId = Number(driverResult.driver.id);
    const loginRes = await request("/auth/login", "POST", { username, password: "password", deviceLabel: "Driver phone" });
    const { cookie: driverCookie } = getSessionCookie(loginRes);
    return { userId, driverId, driverCookie };
  };

  const passenger = async (overrides: Record<string, unknown> = {}, home: Point = H) => {
    const id = (await post("/passengers", {
      name: `Pasajero Sintético ${name}`, homeAddress: "Calle Inventada 101", homeLat: home.lat, homeLng: home.lng,
      companions: 1, frontSeat: false, wheelchair: false, maxRideTimeMinutes: 60, pickupDurationMinutes: 5, dropoffDurationMinutes: 5,
      ...overrides,
    })).passenger.id as number;
    const signer = (await post(`/passengers/${id}/authorized-adults`, {
      name: "Madre Sintética", dni: "-1000001", relation: "madre", phone: "381-000-0001", legalGuardian: true,
    })).adult.id as number;
    await post(`/passengers/${id}/consent`, { signedByAdultId: signer, signedAt: "2026-10-01", otherAdultAllowed: false });
    return id;
  };

  await post("/daily-plans", { date: DAY });
  const route = async (driverId: number, startTime: string, endTime: string, vehicleId?: number) =>
    (await post(`/daily-plans/${DAY}/routes`, { driverId, startTime, endTime, ...(vehicleId ? { vehicleId } : {}) })).route.id as number;
  const transfer = async (passengerId: number, targetTime: string, routeId: number | null, extra: Record<string, unknown> = {}) => {
    const created = (await post(`/daily-plans/${DAY}/transfers`, {
      passengerId, direction: "entrada", destinationId: school, targetTime, ...extra,
    })).transfer.id as number;
    if (routeId !== null) await ok(request(`/transfers/${created}`, "PATCH", { routeId }, office), 200);
    return created;
  };
  const publish = (routeId: number, body: unknown = {}) => request(`/routes/${routeId}/publish`, "POST", body, office);

  return { office, officeId, vehicle, driverWithUser, passenger, route, transfer, publish };
}

describe("push nudge on new versions", () => {
  it("returns VAPID public key when configured, requires authentication", async () => {
    const unauth = await request("/push/public-key", "GET");
    expect(unauth.status).toBe(401);

    const { cookie } = await loginDriver("driver-vapid");
    const res = await request("/push/public-key", "GET", undefined, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ publicKey: fakeVapid.publicKey });
  });

  it("registers and deletes push subscription per driver session", async () => {
    await seedUser("office-push", "office");
    const { cookie: officeCookie } = await signInOffice(app, migrationPool, "office-push", "office-push-password", "Office PC");
    // Office user cannot subscribe
    const officeSub = await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/sub/1",
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    }, officeCookie);
    expect(officeSub.status).toBe(403);

    // Driver can subscribe
    const { cookie, userId } = await loginDriver("driver-sub");
    const invalidSub = await request("/push/subscriptions", "POST", {
      endpoint: "ftp://invalid-url",
      keys: { p256dh: "key", auth: "key" },
    }, cookie);
    expect(invalidSub.status).toBe(400);

    const subRes = await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/sub/1",
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    }, cookie);
    expect(subRes.status).toBe(204);

    const stored = await migrationPool.query(
      `SELECT ps.endpoint, ps.p256dh, ps.auth
         FROM push_subscriptions ps
         JOIN sessions s ON s.id = ps.session_id
        WHERE s.user_id = $1`,
      [userId],
    );
    expect(stored.rows).toEqual([
      { endpoint: "https://push.example.com/sub/1", p256dh: "p256dh-key", auth: "auth-key" },
    ]);

    // Unsubscribe removes subscription
    const delRes = await request("/push/subscriptions", "DELETE", { endpoint: "https://push.example.com/sub/1" }, cookie);
    expect(delRes.status).toBe(204);

    const afterDel = await migrationPool.query("SELECT * FROM push_subscriptions WHERE endpoint = $1", ["https://push.example.com/sub/1"]);
    expect(afterDel.rows).toHaveLength(0);
  });

  it("deletes subscriptions on session revocation (Regla 2)", async () => {
    // 1. Logout deletes session's subscriptions
    const { cookie: driverCookie, userId } = await loginDriver("driver-revoke");
    await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/sub/logout",
      keys: { p256dh: "p256", auth: "auth" },
    }, driverCookie);

    const beforeLogout = await migrationPool.query(
      "SELECT id FROM push_subscriptions WHERE endpoint = 'https://push.example.com/sub/logout'",
    );
    expect(beforeLogout.rows).toHaveLength(1);

    await request("/auth/logout", "POST", undefined, driverCookie);
    const afterLogout = await migrationPool.query(
      "SELECT id FROM push_subscriptions WHERE endpoint = 'https://push.example.com/sub/logout'",
    );
    expect(afterLogout.rows).toHaveLength(0);

    // 2. Password reset revokes sessions and deletes subscriptions
    const { cookie: driver2Cookie, userId: user2Id } = await loginDriver("driver-reset");
    await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/sub/reset",
      keys: { p256dh: "p256", auth: "auth" },
    }, driver2Cookie);

    await seedUser("office-pw-reset", "office");
    const { cookie: officeCookie } = await signInOffice(app, migrationPool, "office-pw-reset", "office-pw-reset-password", "Office PC");
    await request(`/users/${user2Id}/password`, "PATCH", { password: "new-password" }, officeCookie);
    const afterReset = await migrationPool.query(
      "SELECT id FROM push_subscriptions WHERE endpoint = 'https://push.example.com/sub/reset'",
    );
    expect(afterReset.rows).toHaveLength(0);

    // 3. Disabling an account revokes sessions and deletes subscriptions
    const { cookie: driver3Cookie, userId: user3Id } = await loginDriver("driver-disable");
    await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/sub/disable",
      keys: { p256dh: "p256", auth: "auth" },
    }, driver3Cookie);
    const beforeDisable = await migrationPool.query(
      "SELECT id FROM push_subscriptions WHERE endpoint = 'https://push.example.com/sub/disable'",
    );
    expect(beforeDisable.rows).toHaveLength(1);
    await request(`/users/${user3Id}/disable`, "PATCH", {}, officeCookie);
    const afterDisable = await migrationPool.query(
      "SELECT id FROM push_subscriptions WHERE endpoint = 'https://push.example.com/sub/disable'",
    );
    expect(afterDisable.rows).toHaveLength(0);

    // 4. Revoking a specific device/session deletes its subscription
    const { cookie: driver4Cookie, userId: user4Id } = await loginDriver("driver-session-revoke");
    await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/sub/session-revoke",
      keys: { p256dh: "p256", auth: "auth" },
    }, driver4Cookie);
    const sessionRes = await migrationPool.query(
      "SELECT ps.session_id FROM push_subscriptions ps WHERE ps.endpoint = 'https://push.example.com/sub/session-revoke'",
    );
    expect(sessionRes.rows).toHaveLength(1);
    const sessionId = sessionRes.rows[0].session_id;
    await request(`/users/${user4Id}/sessions/${sessionId}`, "DELETE", undefined, officeCookie);
    const afterSessionRevoke = await migrationPool.query(
      "SELECT id FROM push_subscriptions WHERE endpoint = 'https://push.example.com/sub/session-revoke'",
    );
    expect(afterSessionRevoke.rows).toHaveLength(0);

    // 5. Break glass office resets sessions and deletes push subscriptions
    const bgOfficeId = await seedUser("office-bg", "office");
    await signInOffice(app, migrationPool, "office-bg", "office-bg-password", "Office BG PC");
    const bgSession = (await migrationPool.query("SELECT id FROM sessions WHERE user_id = $1", [bgOfficeId])).rows[0].id;
    await migrationPool.query(
      "INSERT INTO push_subscriptions (session_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)",
      [bgSession, "https://push.example.com/sub/break-glass", "p256", "auth"],
    );
    const { runBreakGlassOffice } = await import("../src/break-glass-office.js");
    await runBreakGlassOffice(migrationPool, ["office-bg"], { BREAK_GLASS_OFFICE_PASSWORD: "new-office-bg-password" });
    const afterBreakGlass = await migrationPool.query(
      "SELECT id FROM push_subscriptions WHERE endpoint = 'https://push.example.com/sub/break-glass'",
    );
    expect(afterBreakGlass.rows).toHaveLength(0);
  });

  it("delivers push nudge when publishing a new plan version", async () => {
    const { vehicle, driverWithUser, passenger, route, transfer, publish } = await setup("pushpub");
    const vehicleId = await vehicle();
    const { driverId, driverCookie } = await driverWithUser(vehicleId);
    const routeId = await route(driverId, "07:00", "09:00");
    await transfer(await passenger(), "08:00", routeId);

    // Subscribe driver's device to push
    await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/driver-phone",
      keys: { p256dh: "p256dh-token", auth: "auth-token" },
    }, driverCookie);

    // Publish route -> sends push nudge
    const publishRes = await publish(routeId);
    expect(publishRes.status).toBe(201);

    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0].subscription).toEqual({
      endpoint: "https://push.example.com/driver-phone",
      keys: { p256dh: "p256dh-token", auth: "auth-token" },
    });
    const payload = JSON.parse(sentNotifications[0].payload);
    expect(payload).toEqual({
      title: "Nueva versión del plan",
      body: "Se publicó la versión 1 de tu recorrido",
      routeId,
      version: 1,
      url: `/?routeId=${routeId}`,
    });
  });

  it("prunes subscription on 410 Gone and does not block publication on delivery failure", async () => {
    const { vehicle, driverWithUser, passenger, route, transfer, publish } = await setup("pushfail");
    const vehicleId = await vehicle();
    const { driverId, driverCookie } = await driverWithUser(vehicleId);
    const routeId = await route(driverId, "07:00", "09:00");
    await transfer(await passenger(), "08:00", routeId);

    // Subscribe driver's device
    await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/driver-expired",
      keys: { p256dh: "p256dh", auth: "auth" },
    }, driverCookie);

    // Simulate 410 Gone from push service
    pushSenderFailMode = "throw_410";
    const publishRes = await publish(routeId);
    // Publication succeeds! (Failure to deliver never blocks publication)
    expect(publishRes.status).toBe(201);

    // Subscription should be deleted from DB
    const sub = await migrationPool.query("SELECT id FROM push_subscriptions WHERE endpoint = 'https://push.example.com/driver-expired'");
    expect(sub.rows).toHaveLength(0);

    // Simulate network error
    await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/driver-network-err",
      keys: { p256dh: "p256dh", auth: "auth" },
    }, driverCookie);

    pushSenderFailMode = "throw_error";
    // Publication still succeeds!
    const publish2Res = await publish(routeId, { reason: "Nueva versión forzada" });
    expect(publish2Res.status).toBe(201);
  });

  it("AC4: a push service that never answers does not hold the publication", async () => {
    const { vehicle, driverWithUser, passenger, route, transfer, publish } = await setup("pushhang");
    const vehicleId = await vehicle();
    const { driverId, driverCookie } = await driverWithUser(vehicleId);
    const routeId = await route(driverId, "07:00", "09:00");
    await transfer(await passenger(), "08:00", routeId);

    // Subscribe driver's device
    await request("/push/subscriptions", "POST", {
      endpoint: "https://push.example.com/driver-hang",
      keys: { p256dh: "p256dh", auth: "auth" },
    }, driverCookie);

    // Make custom pushSender hang forever
    pushSenderFailMode = "hang";
    const publishPromise = publish(routeId);
    const outcome = await Promise.race([
      publishPromise.then((r) => r.status),
      new Promise((resolve) => setTimeout(() => resolve("still waiting after 3 s"), 3000)),
    ]);
    expect(outcome).toBe(201);
  });
});
