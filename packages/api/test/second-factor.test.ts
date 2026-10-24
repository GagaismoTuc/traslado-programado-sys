import { createHash } from "node:crypto";
import { generateHOTP } from "@oslojs/otp";
import { beforeEach, describe, expect, it } from "vitest";
import { cookieFrom, createHarness } from "./helpers/harness.js";

const h = createHarness("second-factor-test");
beforeEach(() => h.reset());

const SECOND_FACTOR_REQUIRED = { error: "Authentication required", code: "second_factor_required" };

async function storedKey(username: string) {
  const result = await h.migrationPool.query("SELECT totp_secret FROM users WHERE username = $1", [username]);
  return Buffer.from(String(result.rows[0].totp_secret), "base64url");
}

describe("Oficina second factor", () => {
  it("asks for the TOTP code on a device that is not remembered, even for a persistent-session user", async () => {
    await h.seed("owner", "office", { persistent: true });
    const first = await h.login("owner");
    expect(first.body.secondFactor).toBe("code_required");
    expect(await (await h.request("/users", "GET", undefined, first.cookie)).json()).toEqual(SECOND_FACTOR_REQUIRED);

    const verified = await h.request("/auth/totp/verify", "POST", { code: h.code(), rememberDevice: true }, first.cookie);
    expect(verified.status).toBe(204);
    const remember = cookieFrom(verified, "remember_device");
    expect((await h.request("/users", "GET", undefined, first.cookie)).status).toBe(200);

    const rememberedDevice = await h.login("owner", "password", "Same laptop", remember);
    expect(rememberedDevice.body).toEqual({ user: { id: 1, username: "owner", role: "office" }, sessionId: 2 });
    expect((await h.request("/users", "GET", undefined, rememberedDevice.cookie)).status).toBe(200);

    const otherDevice = await h.login("owner", "password", "Other laptop");
    expect(otherDevice.body.secondFactor).toBe("code_required");
    expect((await h.request("/users", "GET", undefined, otherDevice.cookie)).status).toBe(401);
  });

  it("keeps an Oficina password login in a pending state outside TOTP, me and logout while the Chofer login stays as before", async () => {
    await h.seed("office", "office");
    await h.seed("driver", "driver");
    const pending = await h.login("office");
    expect(pending.response.status).toBe(200);
    expect(pending.body).toEqual({ user: { id: 1, username: "office", role: "office" }, sessionId: 1, secondFactor: "code_required" });

    const blocked = [
      await h.request("/users", "GET", undefined, pending.cookie),
      await h.request("/users", "POST", { username: "new", password: "secret", role: "driver" }, pending.cookie),
      await h.request("/users/2/password", "PATCH", { password: "new-secret" }, pending.cookie),
      await h.request("/users/2/disable", "PATCH", {}, pending.cookie),
      await h.request("/users/1/persistent-session", "PATCH", { persistent: true }, pending.cookie),
      await h.request("/users/2/sessions", "GET", undefined, pending.cookie),
      await h.request("/users/2/sessions/1", "DELETE", undefined, pending.cookie),
      await h.request("/auth/sessions", "GET", undefined, pending.cookie),
    ];
    for (const response of blocked) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(SECOND_FACTOR_REQUIRED);
    }
    expect((await h.request("/auth/me", "GET", undefined, pending.cookie)).status).toBe(200);
    expect((await h.request("/auth/totp/enrol", "POST", {}, pending.cookie)).status).toBe(409);
    expect((await h.request("/auth/totp/verify", "POST", { code: h.code() }, pending.cookie)).status).toBe(204);
    expect((await h.request("/auth/logout", "POST", {}, pending.cookie)).status).toBe(204);
    await expect(h.migrationPool.query("SELECT count(*)::int AS count FROM users")).resolves.toMatchObject({ rows: [{ count: 2 }] });

    const driver = await h.login("driver");
    expect(driver.body).toEqual({ user: { id: 2, username: "driver", role: "driver" }, sessionId: 2 });
    expect((await h.request("/auth/sessions", "GET", undefined, driver.cookie)).status).toBe(200);
    expect((await h.request("/auth/totp/verify", "POST", { code: h.code() }, driver.cookie)).status).toBe(403);
  });

  it("expires the pending second-factor state 10 minutes after the password step", async () => {
    await h.seed("office", "office");
    const pending = await h.login("office");
    h.advance(10 * 60 * 1000 - 1000);
    expect((await h.request("/auth/me", "GET", undefined, pending.cookie)).status).toBe(200);
    h.advance(1000);
    const expired = await h.request("/auth/totp/verify", "POST", { code: h.code() }, pending.cookie);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: "Authentication required", code: "session_expired" });
    expect(await (await h.request("/auth/me", "GET", undefined, pending.cookie)).json()).toMatchObject({ code: "session_expired" });
  });

  it("tells the client in GET /auth/me whether a code or an enrolment is required", async () => {
    await h.seed("enrolled", "office");
    await h.seed("fresh", "office", { enrolled: false });
    const enrolled = await h.login("enrolled");
    const fresh = await h.login("fresh");
    expect(await (await h.request("/auth/me", "GET", undefined, enrolled.cookie)).json()).toEqual({
      user: { id: 1, username: "enrolled", role: "office" },
      secondFactor: "code_required",
    });
    expect(await (await h.request("/auth/me", "GET", undefined, fresh.cookie)).json()).toEqual({
      user: { id: 2, username: "fresh", role: "office" },
      secondFactor: "enrolment_required",
    });
    await h.request("/auth/totp/verify", "POST", { code: h.code() }, enrolled.cookie);
    expect(await (await h.request("/auth/me", "GET", undefined, enrolled.cookie)).json()).toEqual({
      user: { id: 1, username: "enrolled", role: "office" },
    });
  });

  it("requires enrolment before any other route and enforces it only after the first valid code", async () => {
    await h.seed("fresh", "office", { enrolled: false });
    const first = await h.login("fresh");
    expect(first.body.secondFactor).toBe("enrolment_required");
    expect(await (await h.request("/users", "GET", undefined, first.cookie)).json()).toEqual(SECOND_FACTOR_REQUIRED);
    const abandoned = await (await h.request("/auth/totp/enrol", "POST", {}, first.cookie)).json();

    const second = await h.login("fresh");
    expect(second.body.secondFactor).toBe("enrolment_required");
    const started = await h.request("/auth/totp/enrol", "POST", {}, second.cookie);
    const enrolment = await started.json();
    expect(enrolment.secret).not.toBe(abandoned.secret);
    await expect(h.migrationPool.query("SELECT totp_confirmed_at FROM users")).resolves.toMatchObject({ rows: [{ totp_confirmed_at: null }] });

    const key = await storedKey("fresh");
    expect((await h.request("/auth/totp/verify", "POST", { code: h.code(0, key) }, second.cookie)).status).toBe(204);
    expect((await h.request("/users", "GET", undefined, second.cookie)).status).toBe(200);
    await expect(h.migrationPool.query("SELECT totp_confirmed_at FROM users")).resolves.toMatchObject({ rows: [{ totp_confirmed_at: h.clock.now }] });

    const third = await h.login("fresh");
    expect(third.body.secondFactor).toBe("code_required");
    expect(await (await h.request("/auth/totp/enrol", "POST", {}, third.cookie)).json()).toEqual({ error: "Two-factor authentication is already set up" });
  });

  it("accepts a TOTP code once within a window of one step either side", async () => {
    await h.seed("office", "office");
    await h.seed("other", "office");
    const a = await h.login("office");
    const b = await h.login("office");
    const verify = (cookie: string, code: string) => h.request("/auth/totp/verify", "POST", { code }, cookie).then((response) => response.status);

    expect(await verify(a.cookie, h.code(-2))).toBe(400);
    expect(await verify(a.cookie, h.code(2))).toBe(400);
    expect(await verify(a.cookie, h.code(0))).toBe(204);
    expect(await verify(b.cookie, h.code(0))).toBe(400);
    expect(await verify(b.cookie, h.code(-1))).toBe(400);
    expect(await verify(b.cookie, h.code(1))).toBe(204);

    const c = await h.login("other");
    const d = await h.login("other");
    const statuses = await Promise.all([verify(c.cookie, h.code()), verify(d.cookie, h.code())]);
    expect(statuses.sort()).toEqual([204, 400]);
  });

  it("rate-limits TOTP codes per user in a bucket separate from password login", async () => {
    const app = h.newApp();
    await h.seed("coder", "office");
    await h.seed("typist", "office");
    const coder = await h.login("coder", "password", "Device", undefined, app);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await h.request("/auth/totp/verify", "POST", { code: "000000" }, coder.cookie, app)).status).toBe(400);
    }
    const limited = await h.request("/auth/totp/verify", "POST", { code: h.code() }, coder.cookie, app);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("900");
    expect(await limited.json()).toEqual({ error: "Too many code attempts" });
    const passwordStillWorks = await h.login("coder", "password", "Device", undefined, app);
    expect(passwordStillWorks.response.status).toBe(200);

    const typist = await h.login("typist", "password", "Device", undefined, app);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await h.login("typist", "wrong-password", "Device", undefined, app)).response.status).toBe(401);
    }
    expect((await h.login("typist", "password", "Device", undefined, app)).response.status).toBe(429);
    expect((await h.request("/auth/totp/verify", "POST", { code: h.code() }, typist.cookie, app)).status).toBe(204);
  });

  it("never exposes the TOTP secret or its URI outside the enrol-start response", async () => {
    await h.seed("admin", "office");
    await h.seed("fresh", "office", { enrolled: false });
    const admin = await h.login("admin");
    await h.request("/auth/totp/verify", "POST", { code: h.code() }, admin.cookie);
    const fresh = await h.login("fresh");
    const enrolment = await (await h.request("/auth/totp/enrol", "POST", {}, fresh.cookie)).json();
    const key = await storedKey("fresh");

    const outputs = [
      await h.request("/auth/me", "GET", undefined, fresh.cookie),
      await h.request("/auth/totp/verify", "POST", { code: "000000" }, fresh.cookie),
      await h.request("/auth/totp/verify", "POST", { code: h.code(0, key) }, fresh.cookie),
      await h.request("/auth/totp/enrol", "POST", {}, fresh.cookie),
      await h.request("/auth/sessions", "GET", undefined, fresh.cookie),
      await h.request("/users", "GET", undefined, admin.cookie),
      await h.request("/users/2/sessions", "GET", undefined, admin.cookie),
      await h.request("/users/2/password", "PATCH", { password: "reset" }, admin.cookie),
    ];
    const log = await h.migrationPool.query("SELECT action, before_data, after_data FROM change_log WHERE entity = 'user' ORDER BY id");
    const exposed = (await Promise.all(outputs.map((response) => response.text()))).join("\n") + JSON.stringify(log.rows);
    expect(exposed).not.toContain(enrolment.secret);
    expect(exposed).not.toContain("otpauth");
    expect(log.rows).toEqual([
      { action: "totp_enrolled", before_data: null, after_data: { totpEnrolled: true } },
      { action: "password_reset", before_data: null, after_data: { username: "fresh", totpReset: true } },
    ]);
  });

  it("remembers a device for 30 days with a hashed token that only device revocation deletes", async () => {
    await h.seed("office", "office");
    const first = await h.login("office");
    const verified = await h.request("/auth/totp/verify", "POST", { code: h.code(), rememberDevice: true }, first.cookie);
    expect(verified.headers.get("set-cookie")).toMatch(/remember_device=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    const remember = cookieFrom(verified, "remember_device");
    const token = remember.split("=")[1];
    const stored = await h.migrationPool.query("SELECT user_id, session_id, token_hash, expires_at FROM remembered_devices");
    expect(stored.rows).toEqual([{
      user_id: 1,
      session_id: 1,
      token_hash: createHash("sha256").update(token).digest("hex"),
      expires_at: new Date(h.clock.now.getTime() + 30 * 24 * 60 * 60 * 1000),
    }]);

    expect((await h.request("/auth/logout", "POST", {}, first.cookie)).status).toBe(204);
    const afterLogout = await h.login("office", "password", "Test device", remember);
    expect(afterLogout.body.secondFactor).toBeUndefined();
    h.advance(30 * 24 * 60 * 60 * 1000 - 1000);
    expect((await h.login("office", "password", "Test device", remember)).body.secondFactor).toBeUndefined();
    h.advance(1000);
    expect((await h.login("office", "password", "Test device", remember)).body.secondFactor).toBe("code_required");

    h.reset();
    const again = await h.login("office");
    h.advance(60_000);
    const rememberAgain = cookieFrom(await h.request("/auth/totp/verify", "POST", { code: h.code(), rememberDevice: true }, again.cookie), "remember_device");
    const admin = await h.login("office", "password", "Admin", rememberAgain);
    const sessionId = (await h.login("office", "password", "Test device", rememberAgain)).body.sessionId;
    expect((await h.request(`/users/1/sessions/${sessionId}`, "DELETE", undefined, admin.cookie)).status).toBe(204);
    expect((await h.login("office", "password", "Test device", rememberAgain)).body.secondFactor).toBe("code_required");
  });

  it("enrols with an otpauth URI and secret text that @oslojs/otp codes verify", async () => {
    await h.seed("fresh.office", "office", { enrolled: false });
    const pending = await h.login("fresh.office");
    const enrolment = await (await h.request("/auth/totp/enrol", "POST", {}, pending.cookie)).json();
    const uri = new URL(enrolment.uri);
    expect(Object.keys(enrolment).sort()).toEqual(["secret", "uri"]);
    expect(enrolment.uri).toMatch(/^otpauth:\/\/totp\/Traslado%20Programado:fresh\.office\?/);
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      issuer: "Traslado Programado",
      algorithm: "SHA1",
      secret: enrolment.secret,
      period: "30",
      digits: "6",
    });
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
    const code = generateHOTP(await storedKey("fresh.office"), BigInt(Math.floor(h.clock.now.getTime() / 30000)), 6);
    expect((await h.request("/auth/totp/verify", "POST", { code }, pending.cookie)).status).toBe(204);
  });
});
