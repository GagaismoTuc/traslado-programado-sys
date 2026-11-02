import "./profile.js";
import { afterAll, beforeEach, inject } from "vitest";
import { Pool } from "pg";

const workerId = process.env.VITEST_POOL_ID ?? "1";
if (!/^\d+$/.test(workerId)) throw new Error(`Invalid Vitest worker id: ${workerId}`);
const databaseName = `traslado_worker_${workerId}`;
const admin = new Pool({ connectionString: inject("adminConnectionString"), options: "-c timezone=UTC" });

await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${databaseName} WITH TEMPLATE ${inject("templateDatabase")} OWNER traslado_migrator`);
await admin.end();

function withCredentials(uri: string, username: string, password: string, database: string) {
  const url = new URL(uri);
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

process.env.TEST_DATABASE_URL = withCredentials(
  inject("adminConnectionString"),
  "traslado_app",
  inject("applicationPassword"),
  databaseName,
);
process.env.TEST_MIGRATION_DATABASE_URL = withCredentials(
  inject("adminConnectionString"),
  "traslado_migrator",
  inject("migrationPassword"),
  databaseName,
);

const migrationPool = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, options: "-c timezone=UTC" });
beforeEach(async () => {
  const truncateStarted = performance.now();
  const result = await migrationPool.query(
    "SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS tables FROM pg_tables WHERE schemaname = 'public'",
  );
  const tables = result.rows[0].tables as string | null;
  if (tables) await migrationPool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  (globalThis as unknown as { __profile: { current: { truncate: number } } }).__profile.current.truncate += performance.now() - truncateStarted;
});
afterAll(async () => {
  await migrationPool.end();
});
