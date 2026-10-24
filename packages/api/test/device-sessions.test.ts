import { beforeEach, describe, expect, it } from "vitest";
import { cookieFrom, createHarness } from "./helpers/harness.js";
import { signInOffice } from "./helpers/office-session.js";

const h = createHarness("device-sessions-test");
beforeEach(() => h.reset());

async function office(username = "office", deviceLabel = "Office browser") {
  return await signInOffice(h.app, h.migrationPool, username, "password", deviceLabel);
}

describe("device sessions and accounts", () => {
  it("lists and revokes a user's device sessions only for the Oficina and only by a matching user and session", async () => {
    await h.seed("office", "office");
    await h.seed("driver", "driver");
    await h.seed("other", "driver");
    const admin = await office();
    const phone = await h.login("driver", "password", "Van phone");
    const otherPhone = await h.login("other", "password", "Other phone");

    const listed = await h.request("/users/2/sessions", "GET", undefined, admin.cookie);
    expect(await listed.json()).toEqual({
      sessions: [{ id: 2, device_label: "Van phone", created_at: h.clock.now.toISOString(), last_used_at: h.clock.now.toISOString(), current: false }],
    });
    const own = await (await h.request("/users/1/sessions", "GET", undefined, admin.cookie)).json();
    expect(own.sessions.map((session: { id: number; current: boolean }) => [session.id, session.current])).toEqual([[1, true]]);
    expect((await h.request("/users/99/sessions", "GET", undefined, admin.cookie)).status).toBe(404);

    expect((await h.request("/users/2/sessions", "GET", undefined, otherPhone.cookie)).status).toBe(403);
    expect((await h.request("/users/2/sessions/2", "DELETE", undefined, otherPhone.cookie)).status).toBe(403);
    const mismatched = await h.request("/users/2/sessions/3", "DELETE", undefined, admin.cookie);
    expect(mismatched.status).toBe(404);
    expect(await mismatched.json()).toEqual({ error: "Session not found" });
    expect((await h.request("/auth/me", "GET", undefined, otherPhone.cookie)).status).toBe(200);

    expect((await h.request("/users/2/sessions/2", "DELETE", undefined, admin.cookie)).status).toBe(204);
    expect((await h.request("/users/2/sessions/2", "DELETE", undefined, admin.cookie)).status).toBe(204);
    expect(await (await h.request("/auth/me", "GET", undefined, phone.cookie)).json()).toEqual({ error: "Authentication required", code: "session_revoked" });
    expect(await (await h.request("/users/2/sessions", "GET", undefined, admin.cookie)).json()).toEqual({ sessions: [] });
    const log = await h.migrationPool.query("SELECT actor_user_id, entity, entity_id, action, after_data FROM change_log WHERE action = 'device_revoked'");
    expect(log.rows).toEqual([{
      actor_user_id: 1,
      entity: "session",
      entity_id: "2",
      action: "device_revoked",
      after_data: { active: false, userId: 2, deviceLabel: "Van phone" },
    }]);

    const preflight = await h.app.request("/users/2/sessions/2", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost", "Access-Control-Request-Method": "DELETE" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,PATCH,DELETE,OPTIONS");
    const untrusted = await h.app.request("/users/2/sessions/2", { method: "DELETE", headers: { Origin: "https://attacker.example", Cookie: admin.cookie } });
    expect(untrusted.status).toBe(403);
  });

  it("resets the TOTP, remembered devices and sessions of a user whose password the Oficina resets", async () => {
    await h.seed("office", "office");
    await h.seed("planner", "office");
    const admin = await office();
    const planner = await h.login("planner");
    const verified = await h.request("/auth/totp/verify", "POST", { code: h.code(), rememberDevice: true }, planner.cookie);
    const remember = cookieFrom(verified, "remember_device");

    expect((await h.request("/users/2/password", "PATCH", { password: "new-password" }, admin.cookie)).status).toBe(204);
    const user = await h.migrationPool.query("SELECT totp_secret, totp_confirmed_at, totp_last_step FROM users WHERE id = 2");
    expect(user.rows).toEqual([{ totp_secret: null, totp_confirmed_at: null, totp_last_step: null }]);
    await expect(h.migrationPool.query("SELECT count(*)::int AS count FROM remembered_devices")).resolves.toMatchObject({ rows: [{ count: 0 }] });
    const ended = await h.migrationPool.query("SELECT ended_reason FROM sessions WHERE user_id = 2");
    expect(ended.rows).toEqual([{ ended_reason: "password_reset" }]);
    expect(await (await h.request("/auth/me", "GET", undefined, planner.cookie)).json()).toEqual({ error: "Authentication required", code: "session_expired" });
    expect((await h.login("planner", "new-password", "Test device", remember)).body.secondFactor).toBe("enrolment_required");
  });

  it("refuses to disable the last active Oficina account with a clear message", async () => {
    await h.seed("office", "office");
    const admin = await office();
    const refused = await h.request("/users/1/disable", "PATCH", {}, admin.cookie);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "The last active Oficina account cannot be disabled" });
    await expect(h.migrationPool.query("SELECT disabled_at FROM users WHERE id = 1")).resolves.toMatchObject({ rows: [{ disabled_at: null }] });
    expect((await h.request("/auth/me", "GET", undefined, admin.cookie)).status).toBe(200);
  });

  it("leaves one Oficina account enabled when the last two are disabled concurrently", async () => {
    await h.seed("office", "office");
    await h.seed("planner", "office");
    await h.seed("gone", "office");
    const admin = await office();
    const planner = await office("planner");
    expect((await h.request("/users/3/disable", "PATCH", {}, admin.cookie)).status).toBe(204);
    expect((await h.request("/users/3/disable", "PATCH", {}, admin.cookie)).status).toBe(204);

    // Hold the Oficina rows so both requests authenticate and then queue on the same lock.
    const blocker = await h.migrationPool.connect();
    let statuses: number[];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM users WHERE role = 'office' FOR UPDATE");
      const requests = Promise.all([
        h.request("/users/2/disable", "PATCH", {}, admin.cookie),
        h.request("/users/1/disable", "PATCH", {}, planner.cookie),
      ]);
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await h.migrationPool.query("SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted");
        if (waiting.rows[0].count >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await blocker.query("COMMIT");
      statuses = (await requests).map((response) => response.status);
    } finally {
      blocker.release();
    }
    expect(statuses.sort()).toEqual([204, 409]);
    const enabled = await h.migrationPool.query("SELECT count(*)::int AS count FROM users WHERE role = 'office' AND disabled_at IS NULL");
    expect(enabled.rows[0].count).toBe(1);
  });
});
