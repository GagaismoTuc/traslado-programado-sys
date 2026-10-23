import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);
let requestIp = "192.0.2.1";
let testNumber = 0;
const app = createApp({ db: appPool, config: { serverEpoch: "auth-test", getClientIp: () => requestIp } });

async function request(path: string, method: string, body?: unknown, cookie?: string, origin = "http://localhost") {
  return await app.request(path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function login(username: string, password: string, deviceLabel = "Test browser") {
  return request("/auth/login", "POST", { username, password, deviceLabel });
}

async function seedUser(username: string, password: string, role: "office" | "driver") {
  const result = await migrationPool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
    [username, await hashPassword(password), role],
  );
  return Number(result.rows[0].id);
}

function getSessionCookie(response: Response) {
  const cookie = response.headers.get("set-cookie");
  const token = cookie?.match(/^session=([^;]+)/)?.[1];
  if (!cookie || !token) throw new Error("session cookie was not set");
  return { cookie: `session=${token}`, header: cookie };
}

beforeAll(async () => {
  await appPool.query("SELECT 1");
});
beforeEach(() => {
  requestIp = `192.0.2.${++testNumber}`;
});
afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

describe("account authentication", () => {
  it("returns the same login error for unknown and incorrect credentials", async () => {
    await migrationPool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)", [
      "known",
      await hashPassword("correct-password"),
      "office",
    ]);
    const unknown = await login("unknown", "wrong-password");
    const incorrect = await login("known", "wrong-password");

    expect(unknown.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "Invalid username or password" });
    expect(await incorrect.json()).toEqual({ error: "Invalid username or password" });
  });

  it("creates labeled per-device sessions, sets a secure cookie, and logs out", async () => {
    await seedUser("office", "correct-password", "office");
    const first = await login("office", "correct-password", "Office laptop");
    const firstCookie = getSessionCookie(first);
    const second = await login("office", "correct-password", "Office phone");
    const secondCookie = getSessionCookie(second);

    expect(first.status).toBe(200);
    expect(firstCookie.header).toMatch(/HttpOnly/i);
    expect(firstCookie.header).toMatch(/Secure/i);
    expect(firstCookie.header).toMatch(/SameSite=Lax/i);
    expect(secondCookie.cookie).not.toBe(firstCookie.cookie);
    const sessions = await request("/auth/sessions", "GET", undefined, firstCookie.cookie);
    expect((await sessions.json()).sessions.map((session: { device_label: string }) => session.device_label)).toEqual([
      "Office phone",
      "Office laptop",
    ]);

    const logout = await request("/auth/logout", "POST", undefined, firstCookie.cookie);
    expect(logout.status).toBe(204);
    expect((await request("/auth/me", "GET", undefined, firstCookie.cookie)).status).toBe(401);
    expect((await request("/auth/me", "GET", undefined, secondCookie.cookie)).status).toBe(200);
  });

  it("rate-limits login failures by username and by client IP", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      requestIp = `192.0.2.${20 + attempt}`;
      expect((await login("same-user", "wrong-password")).status).toBe(401);
    }
    requestIp = "192.0.2.50";
    expect((await login("same-user", "wrong-password")).status).toBe(429);

    requestIp = "192.0.2.60";
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await login(`user-${attempt}`, "wrong-password")).status).toBe(401);
    }
    expect((await login("another-user", "wrong-password")).status).toBe(429);
  });

  it("requires an allowed Origin on credential-changing requests", async () => {
    const missing = await request("/auth/logout", "POST", undefined, undefined, "");
    const untrusted = await request("/auth/logout", "POST", undefined, undefined, "https://attacker.example");
    const trusted = await login("no-such-user", "wrong-password");

    expect(missing.status).toBe(403);
    expect(untrusted.status).toBe(403);
    expect(trusted.status).toBe(401);
  });

  it("rejects Chofer on every Oficina-only user route", async () => {
    await seedUser("driver", "driver-password", "driver");
    const driverCookie = getSessionCookie(await login("driver", "driver-password")).cookie;
    const probes = [
      await request("/users", "GET", undefined, driverCookie),
      await request("/users", "POST", { username: "new", password: "secret", role: "driver" }, driverCookie),
      await request("/users/1/password", "PATCH", { password: "new-secret" }, driverCookie),
      await request("/users/1/disable", "PATCH", {}, driverCookie),
    ];
    expect(probes.map((response) => response.status)).toEqual([403, 403, 403, 403]);
  });

  it("lets Oficina manage users and immediately invalidates a disabled user's sessions", async () => {
    await seedUser("office", "office-password", "office");
    const officeCookie = getSessionCookie(await login("office", "office-password")).cookie;
    const created = await request("/users", "POST", { username: "driver", password: "driver-password", role: "driver" }, officeCookie);
    const driver = (await created.json()).user;
    const driverCookie = getSessionCookie(await login("driver", "driver-password")).cookie;
    expect(created.status).toBe(201);
    expect((await request("/users", "GET", undefined, driverCookie)).status).toBe(403);

    expect((await request(`/users/${driver.id}/password`, "PATCH", { password: "new-driver-password" }, officeCookie)).status).toBe(204);
    expect((await login("driver", "new-driver-password")).status).toBe(200);
    expect((await request(`/users/${driver.id}/disable`, "PATCH", {}, officeCookie)).status).toBe(204);
    expect((await request("/auth/me", "GET", undefined, driverCookie)).status).toBe(401);
  });

  it("keeps password material out of change log rows and denies application updates or deletes", async () => {
    await seedUser("office", "office-password", "office");
    const officeCookie = getSessionCookie(await login("office", "office-password")).cookie;
    const created = await request("/users", "POST", { username: "driver", password: "first-secret", role: "driver" }, officeCookie);
    const driver = (await created.json()).user;
    expect(await request(`/users/${driver.id}/password`, "PATCH", { password: "second-secret" }, officeCookie).then((response) => response.status)).toBe(204);

    const log = await migrationPool.query("SELECT before_data::text, after_data::text FROM change_log");
    const serialized = JSON.stringify(log.rows);
    expect(serialized).not.toContain("first-secret");
    expect(serialized).not.toContain("second-secret");
    expect(serialized).not.toContain("password_hash");
    await expect(appPool.query("UPDATE change_log SET action = 'changed' WHERE id = 1")).rejects.toThrow(/permission denied/i);
    await expect(appPool.query("DELETE FROM change_log WHERE id = 1")).rejects.toThrow(/permission denied/i);
  });

  it("rolls back an account write when its change log append fails", async () => {
    await seedUser("office", "office-password", "office");
    const officeCookie = getSessionCookie(await login("office", "office-password")).cookie;
    await migrationPool.query("REVOKE INSERT ON change_log FROM traslado_app");
    let result: Response;
    try {
      result = await request("/users", "POST", { username: "rolled-back", password: "temporary", role: "driver" }, officeCookie);
    } finally {
      await migrationPool.query("GRANT INSERT ON change_log TO traslado_app");
    }

    expect(result!.status).toBe(500);
    await expect(migrationPool.query("SELECT id FROM users WHERE username = 'rolled-back'")).resolves.toMatchObject({ rows: [] });
  });
});
