import { randomBytes } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import type { TestProject } from "vitest/node";
import { createDrizzle, createPool } from "../src/db.js";
import { bootstrapRoles } from "../src/bootstrap.js";

const image = "postgres:16.15-alpine";
const templateDatabase = "traslado_template";

function withCredentials(uri: string, username: string, password: string) {
  const url = new URL(uri);
  url.username = username;
  url.password = password;
  return url.toString();
}

function useDatabase(uri: string, database: string) {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

export default async function setup(project: TestProject) {
  let container;
  try {
    container = await new PostgreSqlContainer(image)
      .withDatabase(templateDatabase)
      .withUsername("postgres")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`C1 test harness requires Docker and image ${image}; container startup failed: ${detail}`, { cause: error });
  }

  const rootUrl = container.getConnectionUri();
  const migrationPassword = randomBytes(24).toString("hex");
  const applicationPassword = randomBytes(24).toString("hex");
  const adminPool = new Pool({ connectionString: rootUrl, options: "-c timezone=UTC" });
  let adminPoolClosed = false;

  try {
    await bootstrapRoles(adminPool, migrationPassword, applicationPassword);
    const migrationUrl = withCredentials(rootUrl, "traslado_migrator", migrationPassword);
    const migrationPool = createPool(migrationUrl);
    try {
      await migrate(createDrizzle(migrationPool), { migrationsFolder: "./drizzle" });
    } finally {
      await migrationPool.end();
    }
  } catch (error) {
    await adminPool.end();
    adminPoolClosed = true;
    await container.stop();
    throw error;
  } finally {
    if (!adminPoolClosed) await adminPool.end();
  }

  const postgresUrl = useDatabase(rootUrl, "postgres");
  project.provide("adminConnectionString", postgresUrl);
  project.provide("templateDatabase", templateDatabase);
  project.provide("applicationPassword", applicationPassword);
  project.provide("migrationPassword", migrationPassword);

  return async () => container.stop();
}
