import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../src/db.js";

const appPool = createPool(process.env.TEST_DATABASE_URL!);
const migrationPool = createPool(process.env.TEST_MIGRATION_DATABASE_URL!);

afterAll(async () => {
  await Promise.all([appPool.end(), migrationPool.end()]);
});

describe("C1 database cleanup", () => {
  it("creates rows in the ordinary and append-only tables for the next cleanup", async () => {
    await migrationPool.query("INSERT INTO foundation_permission_probe (marker) VALUES ('cleanup-probe')");
    await migrationPool.query("INSERT INTO change_log (entity, entity_id, action) VALUES ('user', 'cleanup-probe', 'created')");
  });

  it("starts the next test with every public table empty while leaving drizzle migrations intact", async () => {
    const tables = await migrationPool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    const populated: string[] = [];
    for (const { tablename } of tables.rows as Array<{ tablename: string }>) {
      const result = await migrationPool.query(`SELECT count(*)::int AS count FROM public."${tablename.replaceAll('"', '""')}"`);
      if (result.rows[0].count !== 0) populated.push(tablename);
    }

    expect(populated).toEqual([]);
    await expect(appPool.query("DELETE FROM change_log")).rejects.toThrow(/permission denied/i);
    const migrations = await migrationPool.query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations");
    expect(migrations.rows[0].count).toBeGreaterThan(0);
  });
});
