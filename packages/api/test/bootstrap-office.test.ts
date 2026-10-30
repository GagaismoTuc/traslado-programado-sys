import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { createPool } from "../src/db.js";

const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);

beforeAll(async () => {
  await migrationPool.query("SELECT 1");
});

afterAll(async () => {
  await migrationPool.end();
});

describe("initial Office bootstrap command", () => {
  it("creates the first Office account from a username argument and password environment variable", async () => {
    const { runBootstrapOfficeCommand } = await import("../src/bootstrap-office.js");
    const password = "first-office-secret";
    const output: string[] = [];

    await runBootstrapOfficeCommand(
      migrationPool,
      ["First.Office"],
      { BOOTSTRAP_OFFICE_PASSWORD: password },
      (message) => output.push(message),
    );
    const users = await migrationPool.query("SELECT username, role, password_hash FROM users");
    const audit = await migrationPool.query(
      "SELECT actor_user_id, actor_label, entity, action, after_data FROM change_log",
    );

    expect(output).toEqual(["Created initial Office account: first.office"]);
    expect(output.join(" ")).not.toContain(password);
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0].role).toBe("office");
    expect(users.rows[0].password_hash).not.toBe(password);
    expect(await verifyPassword(password, String(users.rows[0].password_hash))).toBe(true);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_user_id: null,
      actor_label: "bootstrap",
      entity: "user",
      action: "created",
      after_data: { username: "first.office", role: "office" },
    });
    expect(JSON.stringify(audit.rows)).not.toContain(password);
  });

  it("refuses when an Office account already exists and does not accept a password argument", async () => {
    const { runBootstrapOffice } = await import("../src/bootstrap-office.js");
    await migrationPool.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'office')", [
      "existing-office",
      await hashPassword("existing-password"),
    ]);

    await expect(
      runBootstrapOffice(migrationPool, ["second-office"], {}),
    ).rejects.toThrow("BOOTSTRAP_OFFICE_PASSWORD is required");
    await expect(
      runBootstrapOffice(migrationPool, ["second-office", "should-not-be-used"], {
        BOOTSTRAP_OFFICE_PASSWORD: "another-secret",
      }),
    ).rejects.toThrow("Usage: db:bootstrap-office <username>");
    await expect(
      runBootstrapOffice(migrationPool, ["second-office"], { BOOTSTRAP_OFFICE_PASSWORD: "another-secret" }),
    ).rejects.toThrow("An Office account already exists");

    const users = await migrationPool.query("SELECT count(*)::int AS count FROM users");
    const audit = await migrationPool.query("SELECT count(*)::int AS count FROM change_log");
    expect(users.rows[0].count).toBe(1);
    expect(audit.rows[0].count).toBe(0);
  });

  it("ignores disabled Office accounts and refuses a username that belongs to a disabled account", async () => {
    const { runBootstrapOffice } = await import("../src/bootstrap-office.js");
    await migrationPool.query("INSERT INTO users (username, password_hash, role, disabled_at) VALUES ($1, $2, 'office', now())", [
      "retired-office",
      await hashPassword("retired-password"),
    ]);

    await expect(
      runBootstrapOffice(migrationPool, ["Retired-Office"], { BOOTSTRAP_OFFICE_PASSWORD: "new-secret" }),
    ).rejects.toThrow("Username retired-office belongs to a disabled account; choose another username (db:break-glass-office recovers an active Office account)");
    await expect(migrationPool.query("SELECT count(*)::int AS count FROM users")).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const created = await runBootstrapOffice(migrationPool, ["new-office"], { BOOTSTRAP_OFFICE_PASSWORD: "new-secret" });
    expect(created.username).toBe("new-office");
    const users = await migrationPool.query("SELECT username, role, disabled_at IS NULL AS active FROM users ORDER BY id");
    expect(users.rows).toEqual([
      { username: "retired-office", role: "office", active: false },
      { username: "new-office", role: "office", active: true },
    ]);
    await expect(
      runBootstrapOffice(migrationPool, ["third-office"], { BOOTSTRAP_OFFICE_PASSWORD: "third-secret" }),
    ).rejects.toThrow("An Office account already exists");
  });

  it("serializes concurrent commands so only one initial Office account is created", async () => {
    const { runBootstrapOffice } = await import("../src/bootstrap-office.js");
    const outcomes = await Promise.allSettled([
      runBootstrapOffice(migrationPool, ["first-office"], { BOOTSTRAP_OFFICE_PASSWORD: "first-secret" }),
      runBootstrapOffice(migrationPool, ["other-office"], { BOOTSTRAP_OFFICE_PASSWORD: "other-secret" }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const users = await migrationPool.query("SELECT username, role FROM users");
    const audit = await migrationPool.query("SELECT actor_label, action FROM change_log");
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0].role).toBe("office");
    expect(audit.rows).toEqual([{ actor_label: "bootstrap", action: "created" }]);
  });
});
