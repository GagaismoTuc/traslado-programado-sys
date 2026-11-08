import { afterAll, beforeEach, inject, vi } from "vitest";
import { Pool } from "pg";

// Rule 2 of #101: src/auth.ts still asks for Argon2id at m=64 MiB, t=3 (production cost, see password-hash.test.ts); only
// the test environment derives at the minimum cost. At full cost the hashes were 69% of the API suite's time on CI.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  type Argon2 = typeof actual.argon2;
  const argon2 = (algorithm: Parameters<Argon2>[0], parameters: Parameters<Argon2>[1], callback: Parameters<Argon2>[2]) =>
    actual.argon2(algorithm, { ...parameters, memory: 8 * parameters.parallelism, passes: 1 }, callback);
  return { ...actual, argon2: vi.fn(argon2) };
});

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
  const result = await migrationPool.query(
    "SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS tables FROM pg_tables WHERE schemaname = 'public'",
  );
  const tables = result.rows[0].tables as string | null;
  if (tables) await migrationPool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
});
afterAll(async () => {
  await migrationPool.end();
});
