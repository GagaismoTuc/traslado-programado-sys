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

const applicationPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c timezone=UTC" });
beforeEach(async () => {
  await applicationPool.query("DELETE FROM foundation_permission_probe");
});
afterAll(async () => {
  await applicationPool.end();
});
