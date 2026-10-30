import { beforeEach, describe, expect, it } from "vitest";
import { createSessionToken, hashSessionToken } from "../src/auth.js";
import { runBreakGlassOffice } from "../src/break-glass-office.js";
import { createHarness } from "./helpers/harness.js";
import { signInOffice } from "./helpers/office-session.js";

const h = createHarness("session-lifetime-test");
beforeEach(() => h.reset());

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const expired = { error: "Authentication required", code: "session_expired" };
const revoked = { error: "Authentication required", code: "session_revoked" };

async function me(cookie: string) {
  const response = await h.request("/auth/me", "GET", undefined, cookie);
  return { status: response.status, body: await response.json() };
}

async function office(username = "office", deviceLabel = "Office browser") {
  return await signInOffice(h.app, h.migrationPool, username, "password", deviceLabel);
}

async function insertSession(userId: number, values: { createdAt: Date; secondFactorAt?: Date | null; endedReason?: string }) {
  const token = createSessionToken();
  await h.migrationPool.query(
    `INSERT INTO sessions (user_id, token_hash, device_label, created_at, last_used_at, second_factor_at, revoked_at, ended_reason)
     VALUES ($1, $2, 'Inserted', $3, $3, $4, $5, $6)`,
    [userId, hashSessionToken(token), values.createdAt, values.secondFactorAt ?? null, values.endedReason ? values.createdAt : null, values.endedReason ?? null],
  );
  return `session=${token}`;
}

describe("session lifetime and responses", () => {
  it("answers a revoked device differently from an expired session", async () => {
    await h.seed("office", "office");
    await h.seed("driver", "driver");
    const admin = await office();
    const revokedPhone = await h.login("driver", "password", "Revoked phone");
    const idlePhone = await h.login("driver", "password", "Idle phone");
    await h.request(`/users/2/sessions/${revokedPhone.body.sessionId}`, "DELETE", undefined, admin.cookie);
    h.advance(30 * DAY);
    expect(await me(revokedPhone.cookie)).toEqual({ status: 401, body: revoked });
    expect(await me(idlePhone.cookie)).toEqual({ status: 401, body: expired });
  });

  it("stores why each session ended and maps each reason to one response code", async () => {
    await h.seed("office", "office");
    await h.seed("driver", "driver");
    await h.seed("other", "office");
    const admin = await office();
    const loggedOut = await h.login("driver", "password", "Logged out");
    await h.request("/auth/logout", "POST", {}, loggedOut.cookie);
    const deviceRevoked = await h.login("driver", "password", "Revoked");
    await h.request(`/users/2/sessions/${deviceRevoked.body.sessionId}`, "DELETE", undefined, admin.cookie);
    const passwordReset = await h.login("driver", "password", "Reset");
    await h.request("/users/2/password", "PATCH", { password: "password" }, admin.cookie);
    const breakGlass = await office("other", "Break glass");
    await runBreakGlassOffice(h.migrationPool, ["other"], { BREAK_GLASS_OFFICE_PASSWORD: "password" });
    const totpReset = await insertSession(2, { createdAt: h.clock.now, endedReason: "totp_reset" });
    const disabled = await h.login("driver", "password", "Disabled");
    await h.request("/users/2/disable", "PATCH", {}, admin.cookie);

    const reasons = await h.migrationPool.query("SELECT device_label, ended_reason FROM sessions WHERE ended_reason IS NOT NULL ORDER BY id");
    expect(reasons.rows).toEqual([
      { device_label: "Logged out", ended_reason: "logout" },
      { device_label: "Revoked", ended_reason: "device_revoked" },
      { device_label: "Reset", ended_reason: "password_reset" },
      { device_label: "Break glass", ended_reason: "break_glass" },
      { device_label: "Inserted", ended_reason: "totp_reset" },
      { device_label: "Disabled", ended_reason: "account_disabled" },
    ]);
    await h.migrationPool.query("UPDATE users SET disabled_at = NULL WHERE id = 2");
    expect((await me(loggedOut.cookie)).body).toEqual(expired);
    expect((await me(deviceRevoked.cookie)).body).toEqual(revoked);
    expect((await me(passwordReset.cookie)).body).toEqual(expired);
    expect((await me(breakGlass.cookie)).body).toEqual(revoked);
    expect((await me(totpReset)).body).toEqual(expired);
    expect((await me(disabled.cookie)).body).toEqual(revoked);
  });

  it("adds session_expired or session_revoked codes and answers session_revoked when a session is both", async () => {
    await h.seed("office", "office");
    await h.seed("driver", "driver");
    const admin = await office();
    const revokedPhone = await h.login("driver", "password", "Revoked phone");
    const idlePhone = await h.login("driver", "password", "Idle phone");
    await h.request(`/users/2/sessions/${revokedPhone.body.sessionId}`, "DELETE", undefined, admin.cookie);
    h.advance(31 * DAY);
    expect(await me(revokedPhone.cookie)).toEqual({ status: 401, body: revoked });
    expect(await me(idlePhone.cookie)).toEqual({ status: 401, body: expired });
    expect(await me("session=unknown-token")).toEqual({ status: 401, body: expired });
    expect(await me("")).toEqual({ status: 401, body: { error: "Authentication required" } });
  });

  it("answers session_revoked after a disable or break-glass and session_expired after a password reset", async () => {
    await h.seed("office", "office");
    await h.seed("driver", "driver");
    await h.seed("other", "office");
    const admin = await office();
    const resetPhone = await h.login("driver", "password", "Reset phone");
    await h.request("/users/2/password", "PATCH", { password: "new-password" }, admin.cookie);
    expect(await me(resetPhone.cookie)).toEqual({ status: 401, body: expired });
    const loggedOutPhone = await h.login("driver", "new-password", "Logged out phone");
    await h.request("/auth/logout", "POST", {}, loggedOutPhone.cookie);
    const disabledPhone = await h.login("driver", "new-password", "Disabled phone");
    expect((await h.request("/users/2/disable", "PATCH", {}, admin.cookie)).status).toBe(204);
    expect(await me(disabledPhone.cookie)).toEqual({ status: 401, body: revoked });
    expect(await me(loggedOutPhone.cookie)).toEqual({ status: 401, body: revoked });
    expect(await me(resetPhone.cookie)).toEqual({ status: 401, body: revoked });
    const otherBrowser = await office("other");
    await runBreakGlassOffice(h.migrationPool, ["other"], { BREAK_GLASS_OFFICE_PASSWORD: "recovered" });
    expect(await me(otherBrowser.cookie)).toEqual({ status: 401, body: revoked });
  });

  it("keeps persistent sessions, slides other Oficina sessions over 12 hours and Chofer sessions over 30 days", async () => {
    await h.seed("owner", "office", { persistent: true });
    await h.seed("secretary", "office");
    await h.seed("driver", "driver");
    const owner = await office("owner");
    const secretary = await office("secretary");
    const driver = await h.login("driver");

    const refreshed = await h.request("/auth/me", "GET", undefined, secretary.cookie);
    expect(refreshed.headers.get("set-cookie")).toBe(`${secretary.cookie}; Max-Age=34560000; Path=/; HttpOnly; Secure; SameSite=Lax`);
    h.advance(30_000);
    await me(secretary.cookie);
    const lastUsed = () => h.migrationPool.query("SELECT last_used_at FROM sessions WHERE id = $1", [secretary.sessionId]).then((result) => result.rows[0].last_used_at);
    expect(await lastUsed()).toEqual(new Date(h.clock.now.getTime() - 30_000));
    h.advance(30_000);
    await me(secretary.cookie);
    expect(await lastUsed()).toEqual(h.clock.now);

    h.advance(12 * HOUR - 1000);
    expect((await me(secretary.cookie)).status).toBe(200);
    h.advance(12 * HOUR - 1000);
    expect((await me(secretary.cookie)).status).toBe(200);
    h.advance(12 * HOUR);
    expect(await me(secretary.cookie)).toEqual({ status: 401, body: expired });

    expect((await me(driver.cookie)).status).toBe(200);
    h.advance(30 * DAY - 1000);
    expect((await me(driver.cookie)).status).toBe(200);
    h.advance(30 * DAY);
    expect(await me(driver.cookie)).toEqual({ status: 401, body: expired });
    h.advance(400 * DAY);
    expect((await me(owner.cookie)).status).toBe(200);
  });

  it("lets only the Oficina change the persistent-session setting of Oficina accounts and logs each change", async () => {
    await h.seed("office", "office");
    await h.seed("planner", "office");
    await h.seed("driver", "driver");
    const admin = await office();
    const usedPlanner = await office("planner", "Used");
    const idlePlanner = await office("planner", "Idle");
    const driver = await h.login("driver");
    const toggle = (id: number, persistent: unknown, cookie = admin.cookie) => h.request(`/users/${id}/persistent-session`, "PATCH", { persistent }, cookie);

    expect((await toggle(2, true, driver.cookie)).status).toBe(403);
    expect(await (await toggle(3, true)).json()).toEqual({ error: "Persistent sessions exist for Oficina accounts only" });
    expect((await toggle(2, "yes")).status).toBe(400);
    expect((await toggle(99, true)).status).toBe(404);
    expect((await toggle(2, true)).status).toBe(204);
    expect((await toggle(2, true)).status).toBe(204);
    const users = await (await h.request("/users", "GET", undefined, admin.cookie)).json();
    expect(users.users.map((user: { username: string; persistent_session: boolean }) => [user.username, user.persistent_session])).toEqual([
      ["driver", false], ["office", false], ["planner", true],
    ]);

    h.advance(13 * HOUR);
    expect((await me(usedPlanner.cookie)).status).toBe(200);
    h.advance(11 * HOUR);
    const admin2 = await office("office", "Second browser");
    expect((await toggle(2, false, admin2.cookie)).status).toBe(204);
    expect(await me(idlePlanner.cookie)).toEqual({ status: 401, body: expired });
    expect((await me(usedPlanner.cookie)).status).toBe(200);
    h.advance(12 * HOUR);
    expect(await me(usedPlanner.cookie)).toEqual({ status: 401, body: expired });

    const log = await h.migrationPool.query("SELECT actor_user_id, entity_id, action, before_data, after_data FROM change_log WHERE action = 'persistent_session_changed' ORDER BY id");
    expect(log.rows).toEqual([
      { actor_user_id: 1, entity_id: "2", action: "persistent_session_changed", before_data: { persistentSession: false }, after_data: { persistentSession: true } },
      { actor_user_id: 1, entity_id: "2", action: "persistent_session_changed", before_data: { persistentSession: true }, after_data: { persistentSession: false } },
    ]);
  });

  it("lists own sessions under the new expiry rules for both roles", async () => {
    await h.seed("office", "office");
    await h.seed("driver", "driver");
    const idleOffice = await office("office", "Idle office");
    const idleDriver = await h.login("driver", "password", "Idle phone");
    h.advance(12 * HOUR);
    const activeOffice = await office("office", "Active office");
    const labels = async (cookie: string) => (await (await h.request("/auth/sessions", "GET", undefined, cookie)).json()).sessions
      .map((session: { device_label: string }) => session.device_label);
    expect(await labels(activeOffice.cookie)).toEqual(["Active office"]);
    expect(await labels(idleDriver.cookie)).toEqual(["Idle phone"]);
    h.advance(30 * DAY);
    const activeDriver = await h.login("driver", "password", "Active phone");
    expect(await labels(activeDriver.cookie)).toEqual(["Active phone"]);
    expect(await me(idleOffice.cookie)).toEqual({ status: 401, body: expired });
  });

  it("treats Oficina sessions from before the migration as not having passed the second factor", async () => {
    const officeId = await h.seed("office", "office");
    const driverId = await h.seed("driver", "driver");
    const oldOffice = await insertSession(officeId, { createdAt: new Date(h.clock.now.getTime() - DAY) });
    const recentOffice = await insertSession(officeId, { createdAt: new Date(h.clock.now.getTime() - 60_000) });
    const oldDriver = await insertSession(driverId, { createdAt: new Date(h.clock.now.getTime() - DAY) });
    expect(await me(oldOffice)).toEqual({ status: 401, body: expired });
    expect((await h.request("/users", "GET", undefined, recentOffice)).status).toBe(401);
    expect((await me(recentOffice)).body.secondFactor).toBe("code_required");
    expect((await me(oldDriver)).status).toBe(200);
  });

  it("keeps revoked session rows so a returning phone still gets session_revoked", async () => {
    await h.seed("office", "office");
    await h.seed("driver", "driver");
    const admin = await office();
    const phone = await h.login("driver");
    await h.request(`/users/2/sessions/${phone.body.sessionId}`, "DELETE", undefined, admin.cookie);
    await h.request("/users/2/password", "PATCH", { password: "new" }, admin.cookie);
    await h.request("/users/2/disable", "PATCH", {}, admin.cookie);
    h.advance(365 * DAY);
    await h.migrationPool.query("UPDATE users SET disabled_at = NULL WHERE id = 2");
    expect(await me(phone.cookie)).toEqual({ status: 401, body: revoked });
    await expect(h.migrationPool.query("SELECT count(*)::int AS count FROM sessions")).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("writes session times from the injected clock", async () => {
    await h.seed("driver", "driver");
    h.advance(DAY);
    const phone = await h.login("driver");
    const loggedInAt = h.clock.now;
    h.advance(HOUR);
    expect((await h.request("/auth/logout", "POST", {}, phone.cookie)).status).toBe(204);
    const stored = await h.migrationPool.query("SELECT created_at, last_used_at, revoked_at FROM sessions WHERE id = $1", [phone.body.sessionId]);
    expect(stored.rows).toEqual([{ created_at: loggedInAt, last_used_at: loggedInAt, revoked_at: h.clock.now }]);
  });
});
