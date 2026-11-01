import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, expect, inject, it } from "vitest";
import { createDrizzle } from "../src/db.js";
import { ignoreAdministratorTermination } from "./helpers/pool.js";

const migrationsFolder = resolve(import.meta.dirname, "../drizzle");
const workerId = process.env.VITEST_POOL_ID ?? "1";
const databaseName = `traslado_backfill_${workerId}`;
const admin = new Pool({ connectionString: inject("adminConnectionString"), options: "-c timezone=UTC" });
let work: string | undefined;

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
  if (work) await rm(work, { recursive: true, force: true });
});

// The migrations up to `lastTag`, so a database can be left at the schema an earlier release had.
async function migrationsUpTo(lastTag: string) {
  work = await mkdtemp(join(tmpdir(), "traslado-migrations-"));
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const entries = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag === lastTag) + 1);
  await mkdir(join(work, "meta"));
  await writeFile(join(work, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) await copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(work, `${entry.tag}.sql`));
  return work;
}

it("backfills the Tolerancia de llegada of existing Destinos from their kind and leaves stored exit times empty", async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(inject("adminConnectionString"));
  url.pathname = `/${databaseName}`;
  // `pool.end()` resolves before the socket closes, so the drop in afterAll can still terminate this connection.
  const pool = ignoreAdministratorTermination(new Pool({ connectionString: url.toString(), options: "-c timezone=UTC" }));
  try {
    await migrate(createDrizzle(pool), { migrationsFolder: await migrationsUpTo("0007_purple_solo") });
    for (const kind of ["therapy", "clinic", "school", "day_centre", "other"]) {
      await pool.query(
        "INSERT INTO destinations (name, kind, address, latitude, longitude) VALUES ($1, $2, 'Avenida Sintetica 303', -26.82, -65.2)",
        [`Destino ${kind}`, kind],
      );
    }
    // An entrada stored before the exit time existed, from the therapy centre to the school (synthetic data).
    await pool.query("INSERT INTO daily_plans (plan_date) VALUES ('2026-11-02')");
    await pool.query(
      `INSERT INTO passengers (name, home_address, home_latitude, home_longitude, companions, front_seat, wheelchair,
         max_ride_time_minutes, pickup_duration_minutes, dropoff_duration_minutes)
       VALUES ('Pasajero Sintético', 'Calle Inventada 101', -26.83, -65.21, 0, false, false, 60, 5, 5)`,
    );
    await pool.query(
      `INSERT INTO transfers (daily_plan_id, passenger_id, direction, origin_destination_id, destination_id, target_time, companions)
       VALUES (1, 1, 'entrada', 1, 3, '14:00', 0)`,
    );

    await migrate(createDrizzle(pool), { migrationsFolder });

    const rows = (await pool.query("SELECT kind, arrival_tolerance_minutes AS tolerance FROM destinations ORDER BY id")).rows;
    expect(rows).toEqual([
      { kind: "therapy", tolerance: 0 },
      { kind: "clinic", tolerance: 0 },
      { kind: "school", tolerance: 30 },
      { kind: "day_centre", tolerance: 30 },
      { kind: "other", tolerance: 0 },
    ]);
    expect((await pool.query("SELECT exit_time FROM transfers")).rows).toEqual([{ exit_time: null }]);
  } finally {
    await pool.end();
  }
}, 60_000);
