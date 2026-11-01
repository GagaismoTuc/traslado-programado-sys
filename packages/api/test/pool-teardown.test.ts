import { Pool } from "pg";
import { afterAll, expect, inject, it } from "vitest";
import { ignoreAdministratorTermination } from "./helpers/pool.js";

const workerId = process.env.VITEST_POOL_ID ?? "1";
const databaseName = `traslado_teardown_${workerId}`;
const admin = new Pool({ connectionString: inject("adminConnectionString"), options: "-c timezone=UTC" });

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
});

it("does not report the 57P01 of DROP DATABASE WITH (FORCE) on a pool connection as an unhandled error", async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(inject("adminConnectionString"));
  url.pathname = `/${databaseName}`;
  const pool = ignoreAdministratorTermination(new Pool({ connectionString: url.toString(), options: "-c timezone=UTC" }));
  const unhandled: unknown[] = [];
  const record = (error: unknown) => unhandled.push(error);
  process.on("uncaughtException", record);
  try {
    // One idle client whose backend is alive: the side of the #75 race where Postgres terminates it before it reads Terminate.
    await pool.query("SELECT 1");
    const removed = new Promise((resolve) => pool.once("remove", resolve));
    await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await removed;
    await pool.end();
  } finally {
    process.off("uncaughtException", record);
  }
  expect(unhandled).toEqual([]);
  expect(pool.totalCount).toBe(0);
});

it("still throws a connection error other than 57P01", () => {
  const pool = ignoreAdministratorTermination(new Pool());
  const idleTimeout = Object.assign(new Error("terminating connection due to idle-session timeout"), { code: "57P05" });
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  expect(() => pool.emit("error", idleTimeout)).toThrow(idleTimeout);
  expect(() => pool.emit("error", reset)).toThrow(reset);
});
