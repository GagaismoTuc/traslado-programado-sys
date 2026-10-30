import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/auth.js";
import { runBreakGlassOffice } from "../src/break-glass-office.js";
import { cookieFrom, createHarness } from "./helpers/harness.js";

const h = createHarness("break-glass-test");
beforeEach(() => h.reset());

describe("Office break-glass command", () => {
  it("resets an Office account's password, TOTP, sessions and remembered devices and refuses anything else", async () => {
    await h.seed("locked.out", "office");
    await h.seed("driver", "driver");
    const disabledId = await h.seed("retired", "office");
    await h.migrationPool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [disabledId]);
    const pending = await h.login("locked.out");
    const remember = cookieFrom(await h.request("/auth/totp/verify", "POST", { code: h.code(), rememberDevice: true }, pending.cookie), "remember_device");
    const snapshot = () => h.migrationPool.query("SELECT username, password_hash, totp_secret FROM users ORDER BY id").then((result) => result.rows);
    const before = await snapshot();

    const refusals: Array<[string[], Record<string, string>, string]> = [
      [["nobody"], { BREAK_GLASS_OFFICE_PASSWORD: "new" }, "No account named nobody"],
      [["driver"], { BREAK_GLASS_OFFICE_PASSWORD: "new" }, "driver is not an Office account"],
      [["retired"], { BREAK_GLASS_OFFICE_PASSWORD: "new" }, "retired is disabled"],
      [["locked.out"], { BREAK_GLASS_OFFICE_PASSWORD: "" }, "BREAK_GLASS_OFFICE_PASSWORD is required"],
      [["locked.out", "new-password"], { BREAK_GLASS_OFFICE_PASSWORD: "new" }, "Usage: db:break-glass-office <username>"],
    ];
    for (const [args, env, message] of refusals) {
      await expect(runBreakGlassOffice(h.migrationPool, args, env)).rejects.toThrow(message);
    }
    expect(await snapshot()).toEqual(before);
    await expect(h.migrationPool.query("SELECT count(*)::int AS count FROM change_log WHERE action = 'break_glass'")).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await runBreakGlassOffice(h.migrationPool, ["Locked.Out"], { BREAK_GLASS_OFFICE_PASSWORD: "recovered-secret" });
    const user = await h.migrationPool.query("SELECT password_hash, totp_secret, totp_confirmed_at, totp_last_step FROM users WHERE id = 1");
    expect(await verifyPassword("recovered-secret", user.rows[0].password_hash)).toBe(true);
    expect(user.rows[0]).toMatchObject({ totp_secret: null, totp_confirmed_at: null, totp_last_step: null });
    await expect(h.migrationPool.query("SELECT ended_reason FROM sessions")).resolves.toMatchObject({ rows: [{ ended_reason: "break_glass" }] });
    await expect(h.migrationPool.query("SELECT count(*)::int AS count FROM remembered_devices")).resolves.toMatchObject({ rows: [{ count: 0 }] });
    const log = await h.migrationPool.query("SELECT actor_user_id, actor_label, entity, entity_id, action, after_data FROM change_log WHERE action = 'break_glass'");
    expect(log.rows).toEqual([{
      actor_user_id: null,
      actor_label: "break-glass",
      entity: "user",
      entity_id: "1",
      action: "break_glass",
      after_data: { username: "locked.out", totpReset: true },
    }]);
    expect(JSON.stringify(log.rows)).not.toContain("recovered-secret");
    expect((await h.login("locked.out", "recovered-secret", "Test device", remember)).body.secondFactor).toBe("enrolment_required");
  });

  it("exits non-zero with the refusal message when the command refuses", () => {
    const result = spawnSync(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "src/break-glass-office.ts", "nobody"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, BOOTSTRAP_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL, BREAK_GLASS_OFFICE_PASSWORD: "new" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("No account named nobody");
    expect(result.stdout).toBe("");
  });
});
