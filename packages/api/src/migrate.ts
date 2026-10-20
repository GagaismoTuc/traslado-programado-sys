import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDrizzle, createPool } from "./db.js";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");

const pool = createPool(url);
try {
  await migrate(createDrizzle(pool), { migrationsFolder: "./drizzle" });
} finally {
  await pool.end();
}
