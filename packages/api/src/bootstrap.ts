import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sqlLiteral(value: string) {
  return value.replaceAll("'", "''");
}

export async function bootstrapRoles(
  pool: Pick<Pool, "query">,
  migrationPassword: string,
  applicationPassword: string,
) {
  const script = await readFile(new URL("../db/bootstrap-roles.sql", import.meta.url), "utf8");
  const sql = script
    .replaceAll("{{MIGRATION_PASSWORD}}", sqlLiteral(migrationPassword))
    .replaceAll("{{APPLICATION_PASSWORD}}", sqlLiteral(applicationPassword));
  await pool.query(sql);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pool = new Pool({ connectionString: required("BOOTSTRAP_DATABASE_URL"), options: "-c timezone=UTC" });
  try {
    await bootstrapRoles(pool, required("MIGRATION_PASSWORD"), required("APPLICATION_PASSWORD"));
  } finally {
    await pool.end();
  }
}
